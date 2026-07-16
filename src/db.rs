use serde::Serialize;
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};

/// Options for a single-table query. Everything here is already validated
/// by the route layer *except* `table` and `sort`, which this layer checks
/// against the live schema before touching SQL.
#[derive(Debug, Clone)]
pub struct QueryOpts {
    pub limit: u32,
    pub offset: u32,
    pub sort: Option<String>,
    pub descending: bool,
    pub timeout_secs: u32,
}

#[derive(Debug, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
}

#[derive(Debug, Serialize)]
pub struct TableData {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<serde_json::Map<String, serde_json::Value>>,
    pub total_approx: i64,
}

#[derive(Debug)]
pub enum DbError {
    /// Requested table (or sort column) is not in the schema allow-list.
    NotAllowed(String),
    Sqlx(sqlx::Error),
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAllowed(what) => write!(f, "not in schema allow-list: {what}"),
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

/// The seam between the routes and the database. v1 ships exactly one
/// implementation (`PgPoolSource`); the boundary exists so other pool/driver
/// adapters can be added without touching handlers (`design.md` §5).
/// Native async-fn-in-trait — the router is generic, no `dyn`.
pub trait DbSource: Send + Sync + 'static {
    fn list_tables(&self)
        -> impl std::future::Future<Output = Result<Vec<String>, DbError>> + Send;
    fn table_counts(
        &self,
    ) -> impl std::future::Future<Output = Result<Vec<(String, i64)>, DbError>> + Send;
    fn query_table(
        &self,
        table: &str,
        opts: QueryOpts,
    ) -> impl std::future::Future<Output = Result<TableData, DbError>> + Send;
}

/// `DbSource` backed by the host service's existing `sqlx::PgPool`.
#[derive(Clone)]
pub struct PgPoolSource {
    pool: PgPool,
}

impl PgPoolSource {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// The allow-list: current tables in `public`, straight from the live
    /// schema. `table`/`sort` params are only ever compared against this —
    /// request strings are never interpolated unchecked.
    async fn allowed_tables(&self) -> Result<Vec<String>, DbError> {
        let rows = sqlx::query_scalar::<_, String>(
            "select table_name from information_schema.tables \
             where table_schema = 'public' and table_type = 'BASE TABLE' \
             order by table_name",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    async fn allowed_columns(&self, table: &str) -> Result<Vec<String>, DbError> {
        let rows = sqlx::query_scalar::<_, String>(
            "select column_name from information_schema.columns \
             where table_schema = 'public' and table_name = $1 \
             order by ordinal_position",
        )
        .bind(table)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }
}

/// Render one Postgres value as JSON for the browser. Everything is fetched
/// as text (`::text` casts in the query) except where sqlx decodes natively;
/// unknown types degrade to their text form rather than erroring.
fn row_to_json(row: &PgRow, columns: &[ColumnInfo]) -> serde_json::Map<String, serde_json::Value> {
    let mut map = serde_json::Map::with_capacity(columns.len());
    for (i, col) in columns.iter().enumerate() {
        let value = match row.try_get::<Option<String>, _>(i) {
            Ok(Some(text)) => serde_json::Value::String(text),
            Ok(None) => serde_json::Value::Null,
            Err(_) => serde_json::Value::String("<undecodable>".to_string()),
        };
        map.insert(col.name.clone(), value);
    }
    map
}

impl DbSource for PgPoolSource {
    async fn list_tables(&self) -> Result<Vec<String>, DbError> {
        self.allowed_tables().await
    }

    async fn table_counts(&self) -> Result<Vec<(String, i64)>, DbError> {
        let rows = sqlx::query_as::<_, (String, i64)>(
            "select c.relname::text, c.reltuples::bigint \
             from pg_class c \
             join pg_namespace n on n.oid = c.relnamespace \
             where n.nspname = 'public' and c.relkind = 'r' \
             order by c.relname",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    async fn query_table(&self, table: &str, opts: QueryOpts) -> Result<TableData, DbError> {
        let tables = self.allowed_tables().await?;
        // Exact match against the live schema — the only path by which the
        // request's table string may reach SQL text.
        let table = tables
            .iter()
            .find(|t| t.as_str() == table)
            .ok_or_else(|| DbError::NotAllowed(format!("table {table:?}")))?
            .clone();

        let column_names = self.allowed_columns(&table).await?;
        let sort = match &opts.sort {
            Some(requested) => Some(
                column_names
                    .iter()
                    .find(|c| c.as_str() == requested)
                    .ok_or_else(|| DbError::NotAllowed(format!("column {requested:?}")))?
                    .clone(),
            ),
            None => None,
        };

        let column_types = sqlx::query_as::<_, (String, String)>(
            "select column_name, data_type from information_schema.columns \
             where table_schema = 'public' and table_name = $1 \
             order by ordinal_position",
        )
        .bind(&table)
        .fetch_all(&self.pool)
        .await?;
        let columns: Vec<ColumnInfo> = column_types
            .into_iter()
            .map(|(name, type_name)| ColumnInfo { name, type_name })
            .collect();

        // Identifiers are quoted and were validated against the live schema
        // above; values (limit/offset) are bound. Every column is cast to
        // text so decoding is uniform across uuid/jsonb/timestamptz/etc.
        let select_list = columns
            .iter()
            .map(|c| format!("\"{}\"::text", c.name))
            .collect::<Vec<_>>()
            .join(", ");
        let order_clause = match &sort {
            Some(col) => format!(
                " order by \"{}\" {}",
                col,
                if opts.descending { "desc" } else { "asc" }
            ),
            None => String::new(),
        };
        let sql = format!("select {select_list} from \"{table}\"{order_clause} limit $1 offset $2");

        let mut tx = self.pool.begin().await?;
        // Per-query timeout so a pathological query can't hold a host pool
        // connection indefinitely (`design.md` §4). LOCAL scopes it to this
        // transaction only.
        //
        // AssertSqlSafe audit: `timeout_secs` is a u32 from the host's own
        // config; `sql` interpolates only identifiers matched exactly against
        // the live information_schema above — request strings never reach
        // either string, and all values are bound.
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "set local statement_timeout = '{}s'",
            opts.timeout_secs
        )))
        .execute(&mut *tx)
        .await?;
        let pg_rows = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(opts.limit as i64)
            .bind(opts.offset as i64)
            .fetch_all(&mut *tx)
            .await?;
        tx.commit().await?;

        let total_approx = sqlx::query_scalar::<_, i64>(
            "select reltuples::bigint from pg_class c \
             join pg_namespace n on n.oid = c.relnamespace \
             where n.nspname = 'public' and c.relname = $1",
        )
        .bind(&table)
        .fetch_one(&self.pool)
        .await?;

        let rows = pg_rows.iter().map(|r| row_to_json(r, &columns)).collect();
        Ok(TableData {
            columns,
            rows,
            total_approx,
        })
    }
}
