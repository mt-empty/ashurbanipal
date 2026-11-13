//! Validates filter JSON ASTs (`spec/protocol.md` §5.4.2); DSL text parsing
//! remains frontend-only (`spec/filter-dsl.md`).

pub const MAX_FILTER_BYTES: usize = 8192;
pub const MAX_CONDITIONS: usize = 10;
pub const MAX_IN_ITEMS: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
pub enum Logic {
    #[serde(rename = "AND")]
    And,
    #[serde(rename = "OR")]
    Or,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
pub enum FilterOp {
    #[serde(rename = "=")]
    Eq,
    #[serde(rename = "!=")]
    Ne,
    #[serde(rename = ">")]
    Gt,
    #[serde(rename = "<")]
    Lt,
    #[serde(rename = ">=")]
    Ge,
    #[serde(rename = "<=")]
    Le,
    #[serde(rename = "LIKE")]
    Like,
    #[serde(rename = "ILIKE")]
    Ilike,
    #[serde(rename = "IN")]
    In,
    #[serde(rename = "BETWEEN")]
    Between,
    #[serde(rename = "IS NULL")]
    IsNull,
    #[serde(rename = "IS NOT NULL")]
    IsNotNull,
}

impl FilterOp {
    pub fn takes_value(self) -> bool {
        !matches!(self, Self::IsNull | Self::IsNotNull)
    }

    /// `LIKE`/`ILIKE` always compare the text cast, whatever the column's class.
    pub fn is_pattern(self) -> bool {
        matches!(self, Self::Like | Self::Ilike)
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Eq => "=",
            Self::Ne => "!=",
            Self::Gt => ">",
            Self::Lt => "<",
            Self::Ge => ">=",
            Self::Le => "<=",
            Self::Like => "LIKE",
            Self::Ilike => "ILIKE",
            Self::In => "IN",
            Self::Between => "BETWEEN",
            Self::IsNull => "IS NULL",
            Self::IsNotNull => "IS NOT NULL",
        }
    }
}

/// Query builders validate `column` before SQL (`spec/protocol.md` §5.4.2).
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Condition {
    pub logic: Option<Logic>,
    #[serde(default)]
    pub not: bool,
    pub column: String,
    pub op: FilterOp,
    pub value: Option<FilterValue>,
    /// Table position, accepted only by [`parse_for_join`] (`spec/protocol.md` §5.11.3).
    #[serde(default)]
    pub join: Option<usize>,
}

/// A string for most ops; an array for `IN` and `BETWEEN`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(untagged)]
pub enum FilterValue {
    One(String),
    List(Vec<String>),
}

impl FilterValue {
    pub fn items(&self) -> &[String] {
        match self {
            Self::One(v) => std::slice::from_ref(v),
            Self::List(v) => v,
        }
    }
}

impl From<&str> for FilterValue {
    fn from(v: &str) -> Self {
        Self::One(v.to_string())
    }
}

impl From<String> for FilterValue {
    fn from(v: String) -> Self {
        Self::One(v)
    }
}

/// Checks a condition's value against its op (`spec/protocol.md` §5.4.2).
pub fn check_value_shape(op: FilterOp, value: Option<&FilterValue>) -> Result<(), FilterError> {
    let wire = op.as_wire();
    match (op, value) {
        (FilterOp::IsNull | FilterOp::IsNotNull, None) => Ok(()),
        (FilterOp::IsNull | FilterOp::IsNotNull, Some(_)) => {
            Err(err(format!("op {wire:?} takes no value")))
        }
        (_, None) => Err(err(format!("op {wire:?} requires a value"))),
        (FilterOp::In, Some(FilterValue::List(items)))
            if (1..=MAX_IN_ITEMS).contains(&items.len()) =>
        {
            Ok(())
        }
        (FilterOp::In, Some(_)) => Err(err(format!(
            "op \"IN\" needs an array of 1 to {MAX_IN_ITEMS} strings"
        ))),
        (FilterOp::Between, Some(FilterValue::List(items))) if items.len() == 2 => Ok(()),
        (FilterOp::Between, Some(_)) => Err(err(
            "op \"BETWEEN\" needs an array of two strings, [low, high]",
        )),
        (_, Some(FilterValue::One(_))) => Ok(()),
        (_, Some(FilterValue::List(_))) => Err(err(format!("op {wire:?} needs a string value"))),
    }
}

/// The form a value compared in its column's own type must have
/// (`spec/protocol.md` §5.4.2): the common form, widened to every value the
/// engine stores and renders for that type, so a cell's own text always
/// filters back to its row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueForm {
    /// At most 35 integer and 30 fraction digits: the `DECIMAL(65,30)` cast's bound.
    MysqlDecimal,
    MysqlFloat,
    /// Years 0001–9999, or the zero date `0000-00-00`.
    MysqlDate,
    MysqlDatetime,
    /// Hours up to ±838.
    MysqlTime,
    /// Any number of digits, `NaN` or `±Infinity`.
    PgNumeric,
    PgFloat,
    /// Years from 0001 with an optional ` BC`, above 9999, or `±infinity`.
    PgDate,
    PgTimestamp,
    /// A timestamp that may carry a time-zone offset.
    PgTimestampTz,
    /// Hours 00–23, or exactly `24:00`.
    PgTime,
    PgTimeTz,
}

impl ValueForm {
    pub fn accepts(self, v: &str) -> bool {
        let b = v.as_bytes();
        match self {
            Self::MysqlDecimal => decimal(b, true) == Some(b.len()),
            Self::MysqlFloat => float(b, true),
            Self::MysqlDate => mysql_date(b),
            Self::MysqlDatetime => timestamp(b, mysql_date, time),
            Self::MysqlTime => mysql_time(b),
            Self::PgNumeric => pg_special_number(b) || decimal(b, false) == Some(b.len()),
            Self::PgFloat => pg_special_number(b) || float(b, false),
            Self::PgDate => pg_infinity(b) || pg_date_bc(b, |d, bc| date(d, true, bc)),
            Self::PgTimestamp => {
                pg_infinity(b)
                    || pg_date_bc(b, |t, bc| timestamp(t, |d| date(d, true, bc), pg_time))
            }
            Self::PgTimestampTz => {
                pg_infinity(b)
                    || pg_date_bc(b, |t, bc| {
                        timestamp(
                            t,
                            |d| date(d, true, bc),
                            |c| without_offset(c, 5).is_some_and(pg_time),
                        )
                    })
            }
            Self::PgTime => pg_time(b),
            Self::PgTimeTz => without_offset(b, 5).is_some_and(pg_time),
        }
    }

    /// Names the expected form in an error title.
    pub fn describe(self) -> &'static str {
        match self {
            Self::MysqlDecimal => "a decimal number such as -12 or 0.5",
            Self::MysqlFloat => "a number such as 0.5 or 1.5e-3",
            Self::MysqlDate => "a date such as 2016-01-31",
            Self::MysqlDatetime | Self::PgTimestamp => {
                "a date such as 2016-01-31, optionally with a time such as 10:30:00"
            }
            Self::MysqlTime => "a time such as 10:30 or -100:00:00",
            Self::PgNumeric => "a decimal number such as -12, 0.5 or NaN",
            Self::PgFloat => "a number such as 0.5, 1.5e-3 or Infinity",
            Self::PgDate => "a date such as 2016-01-31, 0044-03-15 BC or infinity",
            Self::PgTimestampTz => {
                "a date such as 2016-01-31, optionally with a time such as 10:30:00 and an offset such as +02:00"
            }
            Self::PgTime => "a time such as 10:30 or 10:30:00.5",
            Self::PgTimeTz => "a time such as 10:30, optionally with an offset such as +02:00",
        }
    }
}

/// `b` without a trailing `Z`, `±HH`, `±HHMM`, `±HH:MM` or `±HH:MM:SS`
/// offset searched for at or after `from`; `b` itself when there is none,
/// `None` when the offset is malformed.
fn without_offset(b: &[u8], from: usize) -> Option<&[u8]> {
    if let Some(body) = b.strip_suffix(b"Z") {
        return Some(body);
    }
    let Some(i) = b
        .iter()
        .skip(from)
        .rposition(|c| matches!(c, b'+' | b'-'))
        .map(|i| i + from)
    else {
        return Some(b);
    };
    let o = &b[i + 1..];
    let ok = match o.len() {
        2 | 4 => digits(o) == o.len(),
        5 => o[2] == b':' && digits(&o[..2]) == 2 && digits(&o[3..]) == 2,
        8 => {
            o[2] == b':'
                && o[5] == b':'
                && [&o[..2], &o[3..5], &o[6..]].iter().all(|p| digits(p) == 2)
        }
        _ => false,
    };
    ok.then_some(&b[..i])
}

/// Length of a leading `[+-]?d+(.d+)?`, if there is one; `bounded` caps it
/// at 35 integer and 30 fraction digits.
fn decimal(b: &[u8], bounded: bool) -> Option<usize> {
    let (max_int, max_frac) = if bounded {
        (35, 30)
    } else {
        (usize::MAX, usize::MAX)
    };
    let mut i = usize::from(matches!(b.first(), Some(b'+' | b'-')));
    let int = digits(&b[i..]);
    if !(1..=max_int).contains(&int) {
        return None;
    }
    i += int;
    if b.get(i) == Some(&b'.') {
        let frac = digits(&b[i + 1..]);
        if !(1..=max_frac).contains(&frac) {
            return None;
        }
        i += 1 + frac;
    }
    Some(i)
}

fn float(b: &[u8], bounded: bool) -> bool {
    decimal(b, bounded).is_some_and(|n| n == b.len() || exponent(&b[n..]))
}

fn exponent(b: &[u8]) -> bool {
    let Some((b'e' | b'E', rest)) = b.split_first() else {
        return false;
    };
    let rest = match rest.first() {
        Some(b'+' | b'-') => &rest[1..],
        _ => rest,
    };
    (1..=3).contains(&rest.len()) && digits(rest) == rest.len()
}

fn pg_special_number(b: &[u8]) -> bool {
    ["NaN", "Infinity", "+Infinity", "-Infinity"]
        .iter()
        .any(|s| b.eq_ignore_ascii_case(s.as_bytes()))
}

fn pg_infinity(b: &[u8]) -> bool {
    b.eq_ignore_ascii_case(b"infinity") || b.eq_ignore_ascii_case(b"-infinity")
}

/// Calls `f` with `b` minus a trailing ` BC`, and whether it had one.
fn pg_date_bc(b: &[u8], f: impl Fn(&[u8], bool) -> bool) -> bool {
    match b.strip_suffix(b" BC") {
        Some(rest) => f(rest, true),
        None => f(b, false),
    }
}

fn digits(b: &[u8]) -> usize {
    b.iter().take_while(|c| c.is_ascii_digit()).count()
}

fn num(b: &[u8]) -> Option<u32> {
    (!b.is_empty() && digits(b) == b.len())
        .then(|| b.iter().fold(0, |n, c| n * 10 + u32::from(c - b'0')))
}

/// `YYYY-MM-DD`, a real calendar date from year 0001; `wide_years` allows up
/// to 7 year digits. A `bc` year counts back from 1 BC, which is a leap year.
fn date(b: &[u8], wide_years: bool, bc: bool) -> bool {
    let year_len = digits(b);
    let year_ok = if wide_years {
        (4..=7).contains(&year_len)
    } else {
        year_len == 4
    };
    if !year_ok || b.len() != year_len + 6 || b[year_len] != b'-' || b[year_len + 3] != b'-' {
        return false;
    }
    let (Some(y), Some(m), Some(d)) = (
        num(&b[..year_len]),
        num(&b[year_len + 1..year_len + 3]),
        num(&b[year_len + 4..]),
    ) else {
        return false;
    };
    if y < 1 {
        return false;
    }
    let leap_year = if bc { y - 1 } else { y };
    let leap = leap_year % 4 == 0 && (leap_year % 100 != 0 || leap_year % 400 == 0);
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&d)
}

fn mysql_date(b: &[u8]) -> bool {
    b == b"0000-00-00" || date(b, false, false)
}

/// A date accepted by `date_ok`, optionally followed by a space or `T` and a
/// time accepted by `time_ok`.
fn timestamp(b: &[u8], date_ok: impl Fn(&[u8]) -> bool, time_ok: impl Fn(&[u8]) -> bool) -> bool {
    match b.iter().position(|c| matches!(c, b' ' | b'T')) {
        Some(i) => date_ok(&b[..i]) && time_ok(&b[i + 1..]),
        None => date_ok(b),
    }
}

/// `:MM[:SS[.f{1,6}]]`.
fn clock_tail(b: &[u8]) -> bool {
    let two = |s: &[u8]| s.len() == 2 && num(s).is_some_and(|n| n <= 59);
    if b.len() < 3 || b[0] != b':' || !two(&b[1..3]) {
        return false;
    }
    match &b[3..] {
        [] => true,
        [b':', rest @ ..] if rest.len() >= 2 && two(&rest[..2]) => match &rest[2..] {
            [] => true,
            [b'.', frac @ ..] => (1..=6).contains(&frac.len()) && digits(frac) == frac.len(),
            _ => false,
        },
        _ => false,
    }
}

/// `HH:MM[:SS[.f{1,6}]]` with hours 00–23.
fn time(b: &[u8]) -> bool {
    b.len() >= 2 && num(&b[..2]).is_some_and(|h| h <= 23) && clock_tail(&b[2..])
}

/// A `time`, or `24:00` with any zero seconds and fraction.
fn pg_time(b: &[u8]) -> bool {
    time(b)
        || (b.starts_with(b"24")
            && clock_tail(&b[2..])
            && b[2..].iter().all(|c| matches!(c, b'0' | b':' | b'.')))
}

/// `[-]HH[H]:MM[:SS[.f{1,6}]]` with hours up to 838.
fn mysql_time(b: &[u8]) -> bool {
    let b = b.strip_prefix(b"-").unwrap_or(b);
    let hours = digits(b);
    (2..=3).contains(&hours)
        && num(&b[..hours]).is_some_and(|h| h <= 838)
        && clock_tail(&b[hours..])
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterError(pub String);

impl std::fmt::Display for FilterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for FilterError {}

fn err(message: impl Into<String>) -> FilterError {
    FilterError(message.into())
}

pub fn parse(raw: &str) -> Result<Vec<Condition>, FilterError> {
    parse_inner(raw, false)
}

/// Like [`parse`], but conditions may carry a `join` table position.
pub fn parse_for_join(raw: &str) -> Result<Vec<Condition>, FilterError> {
    parse_inner(raw, true)
}

fn parse_inner(raw: &str, allow_join: bool) -> Result<Vec<Condition>, FilterError> {
    if raw.len() > MAX_FILTER_BYTES {
        return Err(err(format!(
            "filter too long: {} bytes (max {MAX_FILTER_BYTES})",
            raw.len()
        )));
    }
    let conditions: Vec<Condition> = serde_json::from_str(raw)
        .map_err(|e| err(format!("filter must be a JSON array of conditions: {e}")))?;
    if conditions.len() > MAX_CONDITIONS {
        return Err(err(format!(
            "too many conditions: {} (max {MAX_CONDITIONS})",
            conditions.len()
        )));
    }
    for (i, condition) in conditions.iter().enumerate() {
        if condition.join.is_some() && !allow_join {
            return Err(err("join is only valid on the join route"));
        }
        match (i, condition.logic) {
            (0, Some(_)) => return Err(err("logic must be absent on the first condition")),
            (1.., None) => {
                return Err(err(format!(
                    "condition {i} is missing logic (\"AND\" or \"OR\")"
                )))
            }
            _ => {}
        }
        check_value_shape(condition.op, condition.value.as_ref())
            .map_err(|e| err(format!("condition {i}: {e}")))?;
    }
    Ok(conditions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_forms() {
        let cases: &[(ValueForm, &str, bool)] = &[
            (ValueForm::MysqlDecimal, "-12", true),
            (ValueForm::MysqlDecimal, "+3.25", true),
            (ValueForm::MysqlDecimal, "0.5", true),
            (ValueForm::MysqlDecimal, ".5", false),
            (ValueForm::MysqlDecimal, "5.", false),
            (ValueForm::MysqlDecimal, "1e3", false),
            (ValueForm::MysqlDecimal, "abc", false),
            (ValueForm::MysqlDecimal, "", false),
            (ValueForm::MysqlDecimal, "NaN", false),
            (ValueForm::MysqlDecimal, &"9".repeat(35), true),
            (ValueForm::MysqlDecimal, &"9".repeat(36), false),
            (ValueForm::MysqlFloat, "1.5e-3", true),
            (ValueForm::MysqlFloat, "2E10", true),
            (ValueForm::MysqlFloat, "1e", false),
            (ValueForm::MysqlFloat, "NaN", false),
            (ValueForm::MysqlDate, "2016-02-29", true),
            (ValueForm::MysqlDate, "2015-02-29", false),
            (ValueForm::MysqlDate, "2016-02-30", false),
            (ValueForm::MysqlDate, "0000-00-00", true),
            (ValueForm::MysqlDate, "0000-01-01", false),
            (ValueForm::MysqlDate, "12000-01-01", false),
            (ValueForm::MysqlDate, "2016-01-01 10:00", false),
            (ValueForm::MysqlDatetime, "2016-01-01", true),
            (ValueForm::MysqlDatetime, "2016-01-01 10:30", true),
            (ValueForm::MysqlDatetime, "2016-01-01T10:30:00.123456", true),
            (ValueForm::MysqlDatetime, "0000-00-00 00:00:00", true),
            (
                ValueForm::MysqlDatetime,
                "2016-01-01T10:30:00.1234567",
                false,
            ),
            (ValueForm::MysqlDatetime, "2016-01-01T10:30:00Z", false),
            (ValueForm::MysqlDatetime, "2016-01-01 ", false),
            (ValueForm::MysqlDatetime, "2016-01-01 24:00", false),
            (ValueForm::MysqlTime, "23:59:59", true),
            (ValueForm::MysqlTime, "-01:00:00", true),
            (ValueForm::MysqlTime, "100:00:00.5", true),
            (ValueForm::MysqlTime, "838:59:59", true),
            (ValueForm::MysqlTime, "839:00:00", false),
            (ValueForm::MysqlTime, "9:30", false),
            (ValueForm::MysqlTime, "10:60", false),
            (ValueForm::PgNumeric, "-12", true),
            (ValueForm::PgNumeric, &"9".repeat(40), true),
            (ValueForm::PgNumeric, "NaN", true),
            (ValueForm::PgNumeric, "-Infinity", true),
            (ValueForm::PgNumeric, "1e3", false),
            (ValueForm::PgNumeric, "abc", false),
            (ValueForm::PgFloat, "1e+300", true),
            (ValueForm::PgFloat, "infinity", true),
            (ValueForm::PgFloat, "1e", false),
            (ValueForm::PgDate, "2016-02-29", true),
            (ValueForm::PgDate, "2016-02-30", false),
            (ValueForm::PgDate, "12000-01-01", true),
            (ValueForm::PgDate, "0044-03-15 BC", true),
            (ValueForm::PgDate, "0001-02-29 BC", true),
            (ValueForm::PgDate, "0002-02-29 BC", false),
            (ValueForm::PgDate, "infinity", true),
            (ValueForm::PgDate, "-infinity", true),
            (ValueForm::PgDate, "0000-01-01", false),
            (ValueForm::PgDate, "0000-00-00", false),
            (ValueForm::PgTimestamp, "2016-01-01 10:30", true),
            (ValueForm::PgTimestamp, "0044-03-15 10:00:00 BC", true),
            (ValueForm::PgTimestamp, "12000-01-01 10:00:00", true),
            (ValueForm::PgTimestamp, "2016-01-01 24:00:00", true),
            (ValueForm::PgTimestamp, "infinity", true),
            (ValueForm::PgTimestamp, "2016-01-01T10:30:00Z", false),
            (ValueForm::PgTime, "23:59:59", true),
            (ValueForm::PgTime, "24:00", true),
            (ValueForm::PgTime, "24:00:00.000", true),
            (ValueForm::PgTime, "24:00:01", false),
            (ValueForm::PgTime, "10:60", false),
            (ValueForm::PgTime, "9:30", false),
            (ValueForm::PgTime, "10:00+02", false),
            (ValueForm::PgTimestampTz, "2016-01-01 10:00:00+00", true),
            (
                ValueForm::PgTimestampTz,
                "2016-01-01T10:00:00.5+05:30",
                true,
            ),
            (
                ValueForm::PgTimestampTz,
                "1890-01-01 00:00:00+00:53:28",
                true,
            ),
            (
                ValueForm::PgTimestampTz,
                "0044-03-15 10:00:00+00:53:28 BC",
                true,
            ),
            (ValueForm::PgTimestampTz, "2016-01-01 10:00-0300", true),
            (ValueForm::PgTimestampTz, "2016-01-01 10:00Z", true),
            (ValueForm::PgTimestampTz, "2016-01-01", true),
            (ValueForm::PgTimestampTz, "-infinity", true),
            (ValueForm::PgTimestampTz, "2016-01-01Z", false),
            (ValueForm::PgTimestampTz, "2016-01-01 10:00+5", false),
            (ValueForm::PgTimestampTz, "2016-01-01 10:00+05:3", false),
            (ValueForm::PgTimeTz, "10:00:00+02", true),
            (ValueForm::PgTimeTz, "24:00:00+00", true),
            (ValueForm::PgTimeTz, "10:00", true),
            (ValueForm::PgTimeTz, "10:00+", false),
        ];
        for &(form, v, ok) in cases {
            assert_eq!(form.accepts(v), ok, "{form:?} {v:?}");
        }
    }
}
