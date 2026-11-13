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
/// (`spec/protocol.md` §5.4.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueForm {
    Number,
    Float,
    Date,
    Timestamp,
    /// A timestamp that may end in a time-zone offset (Postgres `timestamptz`).
    TimestampTz,
    Time,
    /// A time that may end in a time-zone offset (Postgres `timetz`).
    TimeTz,
}

impl ValueForm {
    pub fn accepts(self, v: &str) -> bool {
        let b = v.as_bytes();
        match self {
            Self::Number => decimal(b) == Some(b.len()),
            Self::Float => decimal(b).is_some_and(|n| n == b.len() || exponent(&b[n..])),
            Self::Date => b.len() == 10 && date(b),
            Self::Timestamp => {
                b.len() >= 10
                    && date(&b[..10])
                    && (b.len() == 10 || (matches!(b[10], b' ' | b'T') && time(&b[11..])))
            }
            Self::TimestampTz => without_offset(b, 16).is_some_and(|t| {
                (t.len() > 10 || t.len() == b.len()) && Self::Timestamp.accepts_bytes(t)
            }),
            Self::Time => time(b),
            Self::TimeTz => without_offset(b, 5).is_some_and(time),
        }
    }

    fn accepts_bytes(self, b: &[u8]) -> bool {
        std::str::from_utf8(b).is_ok_and(|v| self.accepts(v))
    }

    /// Names the expected form in an error title.
    pub fn describe(self) -> &'static str {
        match self {
            Self::Number => "a decimal number such as -12 or 0.5",
            Self::Float => "a number such as 0.5 or 1.5e-3",
            Self::Date => "a date such as 2016-01-31",
            Self::Timestamp => "a date such as 2016-01-31, optionally with a time such as 10:30:00",
            Self::TimestampTz => {
                "a date such as 2016-01-31, optionally with a time such as 10:30:00 and an offset such as +02:00"
            }
            Self::Time => "a time such as 10:30 or 10:30:00.5",
            Self::TimeTz => "a time such as 10:30, optionally with an offset such as +02:00",
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

/// Length of a leading `[+-]?d{1,35}(.d{1,30})?`, if there is one.
fn decimal(b: &[u8]) -> Option<usize> {
    let mut i = usize::from(matches!(b.first(), Some(b'+' | b'-')));
    let int = digits(&b[i..]);
    if !(1..=35).contains(&int) {
        return None;
    }
    i += int;
    if b.get(i) == Some(&b'.') {
        let frac = digits(&b[i + 1..]);
        if !(1..=30).contains(&frac) {
            return None;
        }
        i += 1 + frac;
    }
    Some(i)
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

fn digits(b: &[u8]) -> usize {
    b.iter().take_while(|c| c.is_ascii_digit()).count()
}

fn num(b: &[u8]) -> Option<u32> {
    (!b.is_empty() && digits(b) == b.len())
        .then(|| b.iter().fold(0, |n, c| n * 10 + u32::from(c - b'0')))
}

/// `YYYY-MM-DD`, a real calendar date in years 0001–9999.
fn date(b: &[u8]) -> bool {
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let (Some(y), Some(m), Some(d)) = (num(&b[..4]), num(&b[5..7]), num(&b[8..])) else {
        return false;
    };
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    y >= 1 && (1..=days).contains(&d)
}

/// `HH:MM[:SS[.f{1,6}]]` with hours 00–23.
fn time(b: &[u8]) -> bool {
    let two = |s: &[u8], max| s.len() == 2 && num(s).is_some_and(|n| n <= max);
    if b.len() < 5 || b[2] != b':' || !two(&b[..2], 23) || !two(&b[3..5], 59) {
        return false;
    }
    let rest = &b[5..];
    if rest.is_empty() {
        return true;
    }
    if rest.len() < 3 || rest[0] != b':' || !two(&rest[1..3], 59) {
        return false;
    }
    match &rest[3..] {
        [] => true,
        [b'.', frac @ ..] => (1..=6).contains(&frac.len()) && digits(frac) == frac.len(),
        _ => false,
    }
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
            (ValueForm::Number, "-12", true),
            (ValueForm::Number, "+3.25", true),
            (ValueForm::Number, "0.5", true),
            (ValueForm::Number, ".5", false),
            (ValueForm::Number, "5.", false),
            (ValueForm::Number, "1e3", false),
            (ValueForm::Number, "abc", false),
            (ValueForm::Number, "", false),
            (ValueForm::Number, &"9".repeat(35), true),
            (ValueForm::Number, &"9".repeat(36), false),
            (ValueForm::Float, "1.5e-3", true),
            (ValueForm::Float, "2E10", true),
            (ValueForm::Float, "1e", false),
            (ValueForm::Float, "NaN", false),
            (ValueForm::Date, "2016-02-29", true),
            (ValueForm::Date, "2015-02-29", false),
            (ValueForm::Date, "2016-02-30", false),
            (ValueForm::Date, "0000-01-01", false),
            (ValueForm::Date, "2016-01-01 10:00", false),
            (ValueForm::Timestamp, "2016-01-01", true),
            (ValueForm::Timestamp, "2016-01-01 10:30", true),
            (ValueForm::Timestamp, "2016-01-01T10:30:00.123456", true),
            (ValueForm::Timestamp, "2016-01-01T10:30:00.1234567", false),
            (ValueForm::Timestamp, "2016-01-01T10:30:00Z", false),
            (ValueForm::Timestamp, "2016-01-01 ", false),
            (ValueForm::Time, "23:59:59", true),
            (ValueForm::Time, "24:00", false),
            (ValueForm::Time, "10:60", false),
            (ValueForm::Time, "9:30", false),
            (ValueForm::Time, "10:00+02", false),
            (ValueForm::TimestampTz, "2016-01-01 10:00:00+00", true),
            (ValueForm::TimestampTz, "2016-01-01T10:00:00.5+05:30", true),
            (ValueForm::TimestampTz, "1890-01-01 00:00:00+00:53:28", true),
            (ValueForm::TimestampTz, "2016-01-01 10:00-0300", true),
            (ValueForm::TimestampTz, "2016-01-01 10:00Z", true),
            (ValueForm::TimestampTz, "2016-01-01", true),
            (ValueForm::TimestampTz, "2016-01-01Z", false),
            (ValueForm::TimestampTz, "2016-01-01 10:00+5", false),
            (ValueForm::TimestampTz, "2016-01-01 10:00+05:3", false),
            (ValueForm::TimeTz, "10:00:00+02", true),
            (ValueForm::TimeTz, "10:00", true),
            (ValueForm::TimeTz, "10:00+", false),
        ];
        for &(form, v, ok) in cases {
            assert_eq!(form.accepts(v), ok, "{form:?} {v:?}");
        }
    }
}
