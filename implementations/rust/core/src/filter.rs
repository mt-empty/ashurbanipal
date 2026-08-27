//! Deserialization + structural validation of the filter AST wire format
//! (`spec/protocol.md` §5.4.2). Grammar parsing (DSL text → AST) is a
//! frontend-only concern (`spec/filter-dsl.md`); this module never sees DSL
//! text, never produces SQL, and never validates a column against the
//! schema — each backend's query builder in `db/` does that.

/// Derived by measurement, not the DSL-era 1024 carried forward: over the
/// valid cases in `spec/fixtures/parser-tests.json` the worst JSON-over-DSL
/// inflation is 5.67x (V13 — tiny conditions inflate the most), so 1024
/// DSL-equivalent bytes need ~5803 JSON bytes; 8192 covers that with
/// margin. Applies to the URL-decoded JSON text of the `filter` param.
pub const MAX_FILTER_BYTES: usize = 8192;
pub const MAX_CONDITIONS: usize = 10;

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
    #[serde(rename = "IS NULL")]
    IsNull,
    #[serde(rename = "IS NOT NULL")]
    IsNotNull,
}

impl FilterOp {
    pub fn takes_value(self) -> bool {
        !matches!(self, Self::IsNull | Self::IsNotNull)
    }

    /// The exact §5.4.2 wire spelling, for error messages.
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
            Self::IsNull => "IS NULL",
            Self::IsNotNull => "IS NOT NULL",
        }
    }
}

/// `column` is exactly as received on the wire — the query builder matches
/// it against the live schema allow-list before it ever reaches SQL text.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Condition {
    pub logic: Option<Logic>,
    #[serde(default)]
    pub not: bool,
    pub column: String,
    pub op: FilterOp,
    pub value: Option<String>,
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

/// Deserializes and structurally validates the URL-decoded `filter` param.
/// An empty array is legal and means "no filter" (§5.4.2) — callers treat
/// `Ok(vec![])` accordingly.
pub fn parse(raw: &str) -> Result<Vec<Condition>, FilterError> {
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
        match (i, condition.logic) {
            (0, Some(_)) => return Err(err("logic must be absent on the first condition")),
            (1.., None) => {
                return Err(err(format!(
                    "condition {i} is missing logic (\"AND\" or \"OR\")"
                )))
            }
            _ => {}
        }
        match (condition.op.takes_value(), &condition.value) {
            (true, None) => {
                return Err(err(format!(
                    "op {:?} requires a value",
                    condition.op.as_wire()
                )))
            }
            (false, Some(_)) => {
                return Err(err(format!(
                    "op {:?} takes no value",
                    condition.op.as_wire()
                )))
            }
            _ => {}
        }
    }
    Ok(conditions)
}
