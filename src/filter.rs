//! Pure syntactic parser for the filter DSL (`docs/filter-dsl.md`). Never
//! produces SQL text and never validates a column against the schema —
//! that's `db.rs`'s job.
//!
//! Iterative, not recursive-descent, so a pathological input can't cause
//! unbounded stack growth.

const MAX_FILTER_BYTES: usize = 1024;
const MAX_CONDITIONS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompareOp {
    Eq,
    Ne,
    Gt,
    Ge,
    Lt,
    Le,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Logic {
    And,
    Or,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Predicate {
    Compare(CompareOp, String),
    Like(String),
    Ilike(String),
    IsNull,
    IsNotNull,
}

/// `column` is exactly as written in the request — the query builder
/// matches it against the live schema allow-list before it ever reaches
/// SQL text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Condition {
    pub negated: bool,
    pub column: String,
    pub predicate: Predicate,
}

/// `logic.len() == conditions.len() - 1`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFilter {
    pub conditions: Vec<Condition>,
    pub logic: Vec<Logic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterParseError {
    pub message: String,
    pub position: usize,
}

impl std::fmt::Display for FilterParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} at position {}", self.message, self.position)
    }
}

impl std::error::Error for FilterParseError {}

fn err(message: impl Into<String>, position: usize) -> FilterParseError {
    FilterParseError {
        message: message.into(),
        position,
    }
}

pub fn parse(input: &str) -> Result<ParsedFilter, FilterParseError> {
    if input.len() > MAX_FILTER_BYTES {
        return Err(err(
            format!(
                "filter string too long: {} bytes (max {MAX_FILTER_BYTES})",
                input.len()
            ),
            0,
        ));
    }

    let mut pos = 0usize;
    let mut conditions = Vec::new();
    let mut logic = Vec::new();

    loop {
        let condition = parse_condition(input, &mut pos)?;
        conditions.push(condition);
        if conditions.len() > MAX_CONDITIONS {
            return Err(err(
                format!("too many conditions (max {MAX_CONDITIONS})"),
                pos,
            ));
        }

        if pos >= input.len() {
            break;
        }
        skip_ws_required(input, &mut pos)?;
        if pos >= input.len() {
            break;
        }
        let token = parse_logic(input, &mut pos)?;
        logic.push(token);
        skip_ws_required(input, &mut pos)?;
    }

    Ok(ParsedFilter { conditions, logic })
}

fn peek_char(input: &str, pos: usize) -> Option<char> {
    input[pos..].chars().next()
}

fn skip_ws_optional(input: &str, pos: &mut usize) {
    while let Some(c) = peek_char(input, *pos) {
        if c.is_whitespace() {
            *pos += c.len_utf8();
        } else {
            break;
        }
    }
}

fn skip_ws_required(input: &str, pos: &mut usize) -> Result<(), FilterParseError> {
    let start = *pos;
    skip_ws_optional(input, pos);
    if *pos == start {
        return Err(err("expected whitespace", start));
    }
    Ok(())
}

/// Case-insensitive, with a word-boundary check so e.g. `LIKELY` isn't
/// misread as `LIKE`. ASCII-only, so fullwidth/confusable chars never match.
fn match_keyword_ci(input: &str, pos: usize, keyword: &str) -> bool {
    let mut chars = input[pos..].chars();
    for kw_c in keyword.chars() {
        match chars.next() {
            Some(c) if c.eq_ignore_ascii_case(&kw_c) => {}
            _ => return false,
        }
    }
    !matches!(chars.next(), Some(c) if c.is_alphanumeric() || c == '_')
}

fn consume_keyword_ci(input: &str, pos: &mut usize, keyword: &str) -> bool {
    if match_keyword_ci(input, *pos, keyword) {
        *pos += keyword.len();
        true
    } else {
        false
    }
}

fn parse_column(input: &str, pos: &mut usize) -> Result<String, FilterParseError> {
    let start = *pos;
    match peek_char(input, *pos) {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => *pos += c.len_utf8(),
        _ => return Err(err("expected column name", start)),
    }
    while let Some(c) = peek_char(input, *pos) {
        if c.is_ascii_alphanumeric() || c == '_' {
            *pos += c.len_utf8();
        } else {
            break;
        }
    }
    Ok(input[start..*pos].to_string())
}

/// A doubled `''` decodes to a single literal `'`.
fn parse_quoted_value(input: &str, pos: &mut usize) -> Result<String, FilterParseError> {
    let start = *pos;
    debug_assert_eq!(peek_char(input, *pos), Some('\''));
    *pos += 1; // opening quote
    let mut value = String::new();
    loop {
        match peek_char(input, *pos) {
            None => return Err(err("unterminated quoted value", start)),
            Some('\'') => {
                *pos += 1;
                if peek_char(input, *pos) == Some('\'') {
                    value.push('\'');
                    *pos += 1;
                } else {
                    break;
                }
            }
            Some(c) => {
                value.push(c);
                *pos += c.len_utf8();
            }
        }
    }
    Ok(value)
}

/// `AND`/`OR`/`NOT` are always keywords, never bare values — quote them to
/// use as a literal.
fn parse_bare_value(input: &str, pos: &mut usize) -> Result<String, FilterParseError> {
    let start = *pos;
    let mut value = String::new();
    while let Some(c) = peek_char(input, *pos) {
        if c.is_whitespace() || c == '\'' {
            break;
        }
        value.push(c);
        *pos += c.len_utf8();
    }
    if value.is_empty() {
        return Err(err("expected value", start));
    }
    if value.eq_ignore_ascii_case("AND")
        || value.eq_ignore_ascii_case("OR")
        || value.eq_ignore_ascii_case("NOT")
    {
        return Err(err(
            format!("bare {value:?} is always a keyword here; quote it to use as a value"),
            start,
        ));
    }
    Ok(value)
}

fn parse_value(input: &str, pos: &mut usize) -> Result<String, FilterParseError> {
    if peek_char(input, *pos) == Some('\'') {
        parse_quoted_value(input, pos)
    } else {
        parse_bare_value(input, pos)
    }
}

enum OpToken {
    Compare(CompareOp),
    Like,
    Ilike,
}

/// Symbolic operators are matched longest-first so `>=`/`<=` aren't misread
/// as `>`/`<` followed by a bare `=...` value.
fn parse_operator(input: &str, pos: &mut usize) -> Result<OpToken, FilterParseError> {
    let start = *pos;
    if consume_keyword_ci(input, pos, "ILIKE") {
        return Ok(OpToken::Ilike);
    }
    if consume_keyword_ci(input, pos, "LIKE") {
        return Ok(OpToken::Like);
    }
    const SYMBOLIC: &[(&str, CompareOp)] = &[
        (">=", CompareOp::Ge),
        ("<=", CompareOp::Le),
        ("!=", CompareOp::Ne),
        (">", CompareOp::Gt),
        ("<", CompareOp::Lt),
        ("=", CompareOp::Eq),
    ];
    let rest = &input[*pos..];
    for (sym, op) in SYMBOLIC {
        if rest.starts_with(sym) {
            *pos += sym.len();
            return Ok(OpToken::Compare(*op));
        }
    }
    Err(err(
        "expected operator (one of = != >= <= > < LIKE ILIKE, or IS [NOT] NULL)",
        start,
    ))
}

/// Speculatively tries the `IS [NOT] NULL` branch and rewinds to right
/// after `column` if it doesn't apply, falling through to the operator
/// branch.
fn parse_simple_condition(
    input: &str,
    pos: &mut usize,
) -> Result<(String, Predicate), FilterParseError> {
    let column = parse_column(input, pos)?;

    let after_column = *pos;
    if skip_ws_required(input, pos).is_ok() {
        if consume_keyword_ci(input, pos, "IS") {
            skip_ws_required(input, pos)?;
            let is_not = consume_keyword_ci(input, pos, "NOT");
            if is_not {
                skip_ws_required(input, pos)?;
            }
            if !consume_keyword_ci(input, pos, "NULL") {
                return Err(err("expected NULL", *pos));
            }
            let predicate = if is_not {
                Predicate::IsNotNull
            } else {
                Predicate::IsNull
            };
            return Ok((column, predicate));
        }
        *pos = after_column;
    }

    skip_ws_optional(input, pos);
    let op = parse_operator(input, pos)?;
    skip_ws_optional(input, pos);
    let value = parse_value(input, pos)?;
    let predicate = match op {
        OpToken::Compare(cmp) => Predicate::Compare(cmp, value),
        OpToken::Like => Predicate::Like(value),
        OpToken::Ilike => Predicate::Ilike(value),
    };
    Ok((column, predicate))
}

fn parse_condition(input: &str, pos: &mut usize) -> Result<Condition, FilterParseError> {
    let mut negated = false;
    if match_keyword_ci(input, *pos, "NOT") {
        *pos += 3;
        skip_ws_required(input, pos)?;
        negated = true;
    }
    let (column, predicate) = parse_simple_condition(input, pos)?;
    Ok(Condition {
        negated,
        column,
        predicate,
    })
}

fn parse_logic(input: &str, pos: &mut usize) -> Result<Logic, FilterParseError> {
    let start = *pos;
    if consume_keyword_ci(input, pos, "AND") {
        return Ok(Logic::And);
    }
    if consume_keyword_ci(input, pos, "OR") {
        return Ok(Logic::Or);
    }
    Err(err("expected AND or OR", start))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cond(negated: bool, column: &str, predicate: Predicate) -> Condition {
        Condition {
            negated,
            column: column.to_string(),
            predicate,
        }
    }

    #[test]
    fn v1_basic_equality() {
        let parsed = parse("status = completed").unwrap();
        assert_eq!(
            parsed.conditions,
            vec![cond(
                false,
                "status",
                Predicate::Compare(CompareOp::Eq, "completed".to_string())
            )]
        );
        assert!(parsed.logic.is_empty());
    }

    #[test]
    fn v2_no_space_symbolic_operator() {
        let parsed = parse("status=completed").unwrap();
        assert_eq!(
            parsed.conditions,
            vec![cond(
                false,
                "status",
                Predicate::Compare(CompareOp::Eq, "completed".to_string())
            )]
        );
    }

    #[test]
    fn v5_two_conditions_and() {
        let parsed = parse("a >= 1 AND b <= 2").unwrap();
        assert_eq!(
            parsed.conditions,
            vec![
                cond(
                    false,
                    "a",
                    Predicate::Compare(CompareOp::Ge, "1".to_string())
                ),
                cond(
                    false,
                    "b",
                    Predicate::Compare(CompareOp::Le, "2".to_string())
                ),
            ]
        );
        assert_eq!(parsed.logic, vec![Logic::And]);
    }

    #[test]
    fn v6_and_or_precedence_flat_shape() {
        let parsed =
            parse("status = completed AND created_at > 2016-01-01 OR is_active = true").unwrap();
        assert_eq!(parsed.conditions.len(), 3);
        assert_eq!(parsed.logic, vec![Logic::And, Logic::Or]);
    }

    #[test]
    fn v7_like_bare_value() {
        let parsed = parse("name LIKE %smith%").unwrap();
        assert_eq!(
            parsed.conditions,
            vec![cond(false, "name", Predicate::Like("%smith%".to_string()))]
        );
    }

    #[test]
    fn v8_like_quoted_value_with_space() {
        let parsed = parse("name LIKE '% smith%'").unwrap();
        assert_eq!(
            parsed.conditions,
            vec![cond(false, "name", Predicate::Like("% smith%".to_string()))]
        );
    }

    #[test]
    fn v9_doubled_quote_escape() {
        let parsed = parse("note = 'it''s fine'").unwrap();
        assert_eq!(
            parsed.conditions,
            vec![cond(
                false,
                "note",
                Predicate::Compare(CompareOp::Eq, "it's fine".to_string())
            )]
        );
    }

    #[test]
    fn v10_v11_is_null_variants() {
        assert_eq!(
            parse("deleted_at IS NULL").unwrap().conditions,
            vec![cond(false, "deleted_at", Predicate::IsNull)]
        );
        assert_eq!(
            parse("deleted_at IS NOT NULL").unwrap().conditions,
            vec![cond(false, "deleted_at", Predicate::IsNotNull)]
        );
    }

    #[test]
    fn v12_v21_quoted_keyword_as_value() {
        assert_eq!(
            parse("status = 'AND'").unwrap().conditions,
            vec![cond(
                false,
                "status",
                Predicate::Compare(CompareOp::Eq, "AND".to_string())
            )]
        );
        assert_eq!(
            parse("status = 'NOT'").unwrap().conditions,
            vec![cond(
                false,
                "status",
                Predicate::Compare(CompareOp::Eq, "NOT".to_string())
            )]
        );
    }

    #[test]
    fn v13_v20_lowercase_keywords() {
        let parsed = parse("a = 1 and b = 2 or c = 3").unwrap();
        assert_eq!(parsed.logic, vec![Logic::And, Logic::Or]);
        let parsed = parse("not status = completed").unwrap();
        assert!(parsed.conditions[0].negated);
    }

    #[test]
    fn v14_jsonb_quoted_value() {
        let parsed = parse(r#"payload = '{"a": 1}'"#).unwrap();
        assert_eq!(
            parsed.conditions,
            vec![cond(
                false,
                "payload",
                Predicate::Compare(CompareOp::Eq, r#"{"a": 1}"#.to_string())
            )]
        );
    }

    #[test]
    fn v15_empty_quoted_value() {
        let parsed = parse("email = ''").unwrap();
        assert_eq!(
            parsed.conditions,
            vec![cond(
                false,
                "email",
                Predicate::Compare(CompareOp::Eq, String::new())
            )]
        );
    }

    #[test]
    fn v16_ilike() {
        let parsed = parse("name ILIKE '%SMITH%'").unwrap();
        assert_eq!(
            parsed.conditions,
            vec![cond(false, "name", Predicate::Ilike("%SMITH%".to_string()))]
        );
    }

    #[test]
    fn v17_v18_v19_not_prefix() {
        let parsed = parse("NOT status = completed").unwrap();
        assert!(parsed.conditions[0].negated);
        assert_eq!(
            parsed.conditions[0].predicate,
            Predicate::Compare(CompareOp::Eq, "completed".to_string())
        );

        let parsed = parse("NOT email ILIKE '%test%'").unwrap();
        assert!(parsed.conditions[0].negated);

        let parsed = parse("NOT deleted_at IS NULL").unwrap();
        assert!(parsed.conditions[0].negated);
        assert_eq!(parsed.conditions[0].predicate, Predicate::IsNull);
    }

    #[test]
    fn a1_injection_value_decodes_as_plain_string() {
        let parsed = parse("status = '''; DROP TABLE users; --'").unwrap();
        assert_eq!(
            parsed.conditions[0].predicate,
            Predicate::Compare(CompareOp::Eq, "'; DROP TABLE users; --".to_string())
        );
    }

    #[test]
    fn a5_unicode_confusable_value_parses() {
        let parsed = parse("status = \u{1D554}\u{1D560}\u{1D62C}").unwrap();
        assert_eq!(
            parsed.conditions[0].predicate,
            Predicate::Compare(CompareOp::Eq, "\u{1D554}\u{1D560}\u{1D62C}".to_string())
        );
    }

    // ---- Rejected cases ----

    #[test]
    fn r2_missing_value() {
        assert!(parse("status =").is_err());
    }

    #[test]
    fn r3_missing_column() {
        assert!(parse("= completed").is_err());
    }

    #[test]
    fn r4_unknown_operator() {
        assert!(parse("status == completed").is_err());
    }

    #[test]
    fn unknown_operator_error_lists_valid_operators() {
        let e = parse("status CONTAINS completed").unwrap_err();
        for op in ["!=", ">=", "<=", "LIKE", "ILIKE", "IS"] {
            assert!(
                e.message.contains(op),
                "message {:?} missing {op}",
                e.message
            );
        }
    }

    #[test]
    fn r5_trailing_logic_token() {
        assert!(parse("status = a AND").is_err());
    }

    #[test]
    fn r6_parentheses_unsupported() {
        assert!(parse("(status = a)").is_err());
    }

    #[test]
    fn r7_trailing_garbage() {
        assert!(parse("status = a; DROP TABLE users").is_err());
    }

    #[test]
    fn r8_unclosed_quote() {
        assert!(parse("status = 'unterminated").is_err());
    }

    #[test]
    fn r9_column_starts_with_digit() {
        assert!(parse("1abc = x").is_err());
    }

    #[test]
    fn r10_word_operator_missing_value() {
        assert!(parse("status LIKE").is_err());
    }

    #[test]
    fn r11_doubled_logic_token() {
        assert!(parse("a = 1 OR OR b = 2").is_err());
    }

    #[test]
    fn r12_mid_predicate_not_unsupported() {
        assert!(parse("status NOT = completed").is_err());
    }

    #[test]
    fn r13_length_limit_exceeded() {
        let filter = "a = ".to_string() + &"x".repeat(1200);
        assert!(parse(&filter).is_err());
    }

    #[test]
    fn r14_condition_count_limit_exceeded() {
        let filter = std::iter::repeat("a = 1")
            .take(11)
            .collect::<Vec<_>>()
            .join(" AND ");
        assert!(parse(&filter).is_err());
    }

    #[test]
    fn r15_double_negation_rejected() {
        assert!(parse("NOT NOT status = completed").is_err());
    }

    #[test]
    fn r16_bare_not_is_keyword_not_literal() {
        assert!(parse("status = NOT").is_err());
    }

    #[test]
    fn a2_second_condition_digit_leading_column_rejected() {
        assert!(parse("id = 1 OR 1=1").is_err());
    }

    #[test]
    fn a3_double_quote_illegal_in_column_rejected() {
        assert!(parse("col\"name = x").is_err());
    }

    #[test]
    fn a6_fullwidth_column_rejected() {
        assert!(parse("\u{FF53}\u{FF54}\u{FF41}\u{FF54}\u{FF55}\u{FF53} = x").is_err());
    }

    #[test]
    fn a7_embedded_nul_byte_rejected() {
        assert!(parse("statu\0s = x").is_err());
    }

    #[test]
    fn a9_boundary_ten_conditions_succeed() {
        let filter = std::iter::repeat("a = 1")
            .take(10)
            .collect::<Vec<_>>()
            .join(" AND ");
        assert_eq!(parse(&filter).unwrap().conditions.len(), 10);
    }

    #[test]
    fn a9_boundary_eleven_conditions_rejected() {
        let filter = std::iter::repeat("a = 1")
            .take(11)
            .collect::<Vec<_>>()
            .join(" AND ");
        assert!(parse(&filter).is_err());
    }

    #[test]
    fn trailing_whitespace_is_tolerated() {
        assert!(parse("status = completed   ").is_ok());
    }

    #[test]
    fn empty_filter_is_a_parse_error() {
        assert!(parse("").is_err());
    }
}
