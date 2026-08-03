mod postgres;
#[cfg(feature = "sqlite")]
mod sqlite;

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
    fn list_tables(
        &self,
    ) -> impl std::future::Future<Output = Result<Vec<TableInfo>, DbError>> + Send;
    fn table_counts(
        &self,
    ) -> impl std::future::Future<Output = Result<Vec<(String, i64)>, DbError>> + Send;
    fn query_table(
        &self,
        table: &str,
        opts: QueryOpts,
    ) -> impl std::future::Future<Output = Result<TableData, DbError>> + Send;
    fn common_values(
        &self,
        table: &str,
        column: &str,
    ) -> impl std::future::Future<Output = Result<Vec<(String, f32)>, DbError>> + Send;
}

/// The hardcoded operator→SQL-keyword table (`spec/protocol.md` §5.4.2) —
/// wire text never becomes an operator except through this match. The
/// keyword is shared across backends; the *fragment* built around it
/// (cast syntax, placeholder style) is not — see `postgres::build_where_clause`
/// and `sqlite::build_where_clause`, each of which calls this and then
/// applies its own dialect's cast/placeholder rules. Note `Ilike` has no
/// SQLite keyword — `sqlite::build_where_clause` special-cases it to plain
/// `LIKE` (SQLite's `LIKE` is already ASCII case-insensitive) rather than
/// calling this for that variant.
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
