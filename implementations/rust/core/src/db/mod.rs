#[cfg(feature = "mysql")]
mod mysql;
#[cfg(feature = "postgres")]
mod postgres;
#[cfg(feature = "sqlite")]
mod sqlite;

#[cfg(feature = "mysql")]
pub use mysql::MySqlSource;
#[cfg(feature = "postgres")]
pub use postgres::PgPoolSource;
#[cfg(feature = "sqlite")]
pub use sqlite::SqliteSource;

use serde::Serialize;

use crate::filter::{Condition, FilterOp};

#[derive(Debug, Clone)]
pub struct QueryOpts {
    pub limit: u32,
    pub offset: u32,
    pub sort: Option<String>,
    pub descending: bool,
    pub timeout_secs: u32,
    pub filter: Option<Vec<Condition>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyKind {
    Pk,
    Fk,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnRef {
    pub table: String,
    pub column: String,
    /// Only set when the referenced table lives in a schema other than the
    /// referencing column's own — same-schema FKs (the common case) omit it,
    /// so the wire payload is unchanged from before this field existed
    /// (additive, spec/protocol.md §7 versioning policy).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<KeyKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references: Option<ColumnRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TableInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TableData {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<serde_json::Map<String, serde_json::Value>>,
    pub total_approx: i64,
}

#[derive(Debug)]
pub enum DbError {
    NotAllowed(String),
    FilterParse(String),
    Sqlx(sqlx::Error),
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAllowed(what) => write!(f, "not in schema allow-list: {what}"),
            Self::FilterParse(reason) => write!(f, "invalid filter: {reason}"),
            Self::Sqlx(e) => write!(f, "database error: {e}"),
        }
    }
}

impl std::error::Error for DbError {}

impl From<sqlx::Error> for DbError {
    fn from(e: sqlx::Error) -> Self {
        Self::Sqlx(e)
    }
}

pub trait DbSource: Send + Sync + 'static {
    fn list_schemas(
        &self,
    ) -> impl std::future::Future<Output = Result<Vec<String>, DbError>> + Send;
    fn list_tables(
        &self,
        schema: Option<&str>,
    ) -> impl std::future::Future<Output = Result<Vec<TableInfo>, DbError>> + Send;
    fn table_counts(
        &self,
        schema: Option<&str>,
    ) -> impl std::future::Future<Output = Result<Vec<(String, i64)>, DbError>> + Send;
    fn query_table(
        &self,
        schema: Option<&str>,
        table: &str,
        opts: QueryOpts,
    ) -> impl std::future::Future<Output = Result<TableData, DbError>> + Send;
    fn common_values(
        &self,
        schema: Option<&str>,
        table: &str,
        column: &str,
    ) -> impl std::future::Future<Output = Result<Vec<(String, f32)>, DbError>> + Send;
}

/// Escapes an identifier for splicing into SQL text by doubling embedded
/// `"` (the standard Postgres/SQLite quoted-identifier escape) — every name
/// reaching this must already be allow-list-validated against a live
/// catalog lookup; this only makes a validated name syntactically safe to
/// splice; it is not itself a validation step. Not universal: MySQL's
/// default identifier quote is the backtick, not `"`, so
/// `mysql::quote_ident_mysql` is its own function, not a reuse of this one.
pub(crate) fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// The hardcoded operator→SQL-keyword table — wire text never becomes an
/// operator except through this match. Each backend's `build_where_clause`
/// wraps the keyword in its own cast/placeholder syntax, and skips this
/// entirely for `Ilike` on SQLite/MySQL, which have no such keyword.
pub(crate) fn op_sql(op: FilterOp) -> &'static str {
    match op {
        FilterOp::Eq => "=",
        FilterOp::Ne => "!=",
        FilterOp::Gt => ">",
        FilterOp::Ge => ">=",
        FilterOp::Lt => "<",
        FilterOp::Le => "<=",
        FilterOp::Like => "LIKE",
        FilterOp::Ilike => "ILIKE",
        FilterOp::IsNull => "IS NULL",
        FilterOp::IsNotNull => "IS NOT NULL",
    }
}

#[cfg(test)]
mod tests {
    use super::quote_ident;

    #[test]
    fn quote_ident_doubles_embedded_quotes() {
        assert_eq!(quote_ident("users"), "\"users\"");
        // A name containing `"` must not let the attacker close the quoted
        // identifier early — doubling is the escape, not omission.
        assert_eq!(quote_ident("foo\"bar"), "\"foo\"\"bar\"");
        assert_eq!(
            quote_ident("a\"; drop table users; --"),
            "\"a\"\"; drop table users; --\""
        );
    }
}
