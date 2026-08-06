use std::collections::HashMap;
use std::time::{Duration, Instant};

use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};

use super::{
    op_sql, quote_ident, ColumnInfo, ColumnRef, DbError, DbSource, KeyKind, QueryOpts, TableData,
    TableInfo,
};
use crate::filter::{Condition, FilterOp, Logic};

/// Catalog/metadata queries have no per-request timeout knob, but must
/// still be bounded — same value as `Limits::query_timeout_secs`'s default
/// (mirrors `postgres::CATALOG_TIMEOUT_SECS`).
const CATALOG_TIMEOUT_SECS: u32 = 5;

/// SQLite has no schema namespace above a single database file — this is
/// the only name `list_schemas` ever returns, mirroring how a bare
/// `ATTACH`-less connection exposes its one implicit `main` schema.
const ONLY_SCHEMA: &str = "main";

/// A request naming any schema other than `ONLY_SCHEMA` is asking for
/// something that doesn't exist on this backend — same `NotAllowed` shape
/// Postgres returns for a schema absent from its live allow-list, so
/// callers don't need to special-case which backend rejected it.
fn check_schema(schema: Option<&str>) -> Result<(), DbError> {
    match schema {
        None | Some(ONLY_SCHEMA) => Ok(()),
        Some(other) => Err(DbError::NotAllowed(format!("schema {other:?}"))),
    }
}

/// Reviewed and supported, gated behind the `sqlite` feature (off by
/// default). Not run through `conformance/runner` — see
/// `docs/adapter-decisions.md` for the per-clause decisions this makes
/// where Postgres-specific catalog/stats mechanisms have no equivalent.
#[derive(Clone)]
pub struct SqliteSource {
    pool: SqlitePool,
}

impl SqliteSource {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// SQLite has no `SET LOCAL statement_timeout` equivalent — `busy_timeout`
    /// only bounds waiting for a file lock, not a slow `SELECT`, and each
    /// connection runs on its own dedicated worker thread, so wrapping the
    /// query future in `tokio::time::timeout` would abandon *waiting* for a
    /// result without actually stopping the blocking call on that thread
    /// (the connection would stay tied up for the query's real duration
    /// regardless). The real interrupt mechanism is `sqlite3_progress_handler`
    /// (`SqliteConnection::set_progress_handler`): invoked periodically
    /// during query execution, and returning `false` aborts the query
    /// immediately on the same thread — that's what this wraps every query
    /// in, mirroring what `postgres::PgPoolSource::bounded_tx` guarantees.
    async fn bounded<T>(
        &self,
        timeout_secs: u32,
        query: impl AsyncFnOnce(&mut sqlx::SqliteConnection) -> Result<T, DbError>,
    ) -> Result<T, DbError> {
        let mut conn = self.pool.acquire().await?;
        let deadline = Instant::now() + Duration::from_secs(timeout_secs as u64);
        {
            let mut handle = conn.lock_handle().await?;
            // Checked every 1000 VM opcodes — frequent enough to bound
            // overrun tightly without meaningfully slowing the query.
            handle.set_progress_handler(1000, move || Instant::now() < deadline);
        }
        let result = query(&mut conn).await;
        {
            // num_ops < 1 disables the handler (sqlx docs on
            // set_progress_handler) — must clear it before the connection
            // goes back to the pool, or a reused connection would inherit
            // a `deadline` that's already elapsed and abort instantly.
            let mut handle = conn.lock_handle().await?;
            handle.set_progress_handler(0, || true);
        }
        result
    }

    async fn allowed_tables(&self) -> Result<Vec<String>, DbError> {
        self.bounded(CATALOG_TIMEOUT_SECS, async |conn| {
            let rows = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(
                "select name from sqlite_master \
                 where type = 'table' and name not like 'sqlite\\_%' escape '\\' \
                 order by name"
                    .to_string(),
            ))
            .fetch_all(&mut *conn)
            .await?;
            Ok(rows)
        })
        .await
    }

    /// `table` is validated against `allowed_tables` by every caller before
    /// reaching here — `PRAGMA` doesn't accept bound parameters for the
    /// table name, so this is the one identifier spliced into a PRAGMA
    /// string rather than bound.
    async fn allowed_columns(&self, table: &str) -> Result<Vec<String>, DbError> {
        let table = quote_ident(table);
        self.bounded(CATALOG_TIMEOUT_SECS, async move |conn| {
            let rows = sqlx::query_as::<_, (i64, String)>(sqlx::AssertSqlSafe(format!(
                "select cid, name from pragma_table_info({table}) order by cid"
            )))
            .fetch_all(&mut *conn)
            .await?;
            Ok(rows.into_iter().map(|(_, name)| name).collect())
        })
        .await
    }

    /// Composite FKs are dropped rather than risk mislabeling which
    /// referencing column pairs with which referenced column, mirroring
    /// `postgres::PgPoolSource::key_metadata`.
    async fn key_metadata(
        &self,
        table: &str,
    ) -> Result<(Vec<String>, HashMap<String, ColumnRef>), DbError> {
        let table = quote_ident(table);
        self.bounded(CATALOG_TIMEOUT_SECS, async move |conn| {
            let cols = sqlx::query_as::<_, (i64, String, i64)>(sqlx::AssertSqlSafe(format!(
                "select cid, name, pk from pragma_table_info({table}) order by cid"
            )))
            .fetch_all(&mut *conn)
            .await?;
            let pk_columns: Vec<String> = cols
                .into_iter()
                .filter(|(_, _, pk)| *pk > 0)
                .map(|(_, name, _)| name)
                .collect();

            // (id, seq, table, from, to) — `id` groups columns belonging to
            // the same constraint (composite FKs share an id). The quoted
            // "table"/"from"/"to" are pragma_foreign_key_list's own fixed
            // output column names (SQL keywords needing escape), not the
            // caller-supplied table.
            let fks = sqlx::query_as::<_, (i64, i64, String, String, String)>(sqlx::AssertSqlSafe(
                format!(
                    "select id, seq, \"table\", \"from\", \"to\" \
                     from pragma_foreign_key_list({table})"
                ),
            ))
            .fetch_all(&mut *conn)
            .await?;
            let mut by_constraint: HashMap<i64, Vec<(String, String, String)>> = HashMap::new();
            for (id, _seq, ref_table, from, to) in fks {
                by_constraint
                    .entry(id)
                    .or_default()
                    .push((from, ref_table, to));
            }
            let mut fk_columns = HashMap::new();
            for members in by_constraint.into_values() {
                if members.len() != 1 {
                    continue;
                }
                let (from, ref_table, to) = members.into_iter().next().unwrap();
                fk_columns.insert(
                    from,
                    ColumnRef {
                        table: ref_table,
                        column: to,
                        // SQLite has no schema namespace (see ONLY_SCHEMA).
                        schema: None,
                    },
                );
            }
            Ok((pk_columns, fk_columns))
        })
        .await
    }
}

fn row_to_json(
    row: &SqliteRow,
    columns: &[ColumnInfo],
) -> serde_json::Map<String, serde_json::Value> {
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

/// SQLite equivalent of `postgres::build_where_clause`: `?` placeholders
/// instead of `$N` (SQLite has no numbered-from-N form usable alongside
/// `LIMIT ?`/`OFFSET ?`), `CAST(col AS TEXT)` instead of `::text`, and
/// `ILIKE` mapped to plain `LIKE` since SQLite has no case-insensitive-by-
/// default keyword distinct from `LIKE` (SQLite's `LIKE` is already ASCII
/// case-insensitive).
fn build_where_clause(
    conditions: &[Condition],
    column_names: &[String],
) -> Result<(String, Vec<String>), DbError> {
    if conditions.is_empty() {
        return Ok((String::new(), Vec::new()));
    }

    let mut values = Vec::new();
    let mut clause = String::new();
    for (i, condition) in conditions.iter().enumerate() {
        let column = column_names
            .iter()
            .find(|c| c.as_str() == condition.column)
            .ok_or_else(|| DbError::NotAllowed(format!("column {:?}", condition.column)))?;

        let keyword = if condition.op == FilterOp::Ilike {
            "LIKE"
        } else {
            op_sql(condition.op)
        };
        let quoted_column = quote_ident(column);
        let inner = if condition.op.takes_value() {
            let value = condition.value.clone().ok_or_else(|| {
                DbError::FilterParse(format!("op {:?} requires a value", condition.op.as_wire()))
            })?;
            let frag = format!("CAST({quoted_column} AS TEXT) {keyword} ?");
            values.push(value);
            frag
        } else {
            format!("CAST({quoted_column} AS TEXT) {keyword}")
        };
        let wrapped = if condition.not {
            format!("(NOT ({inner}))")
        } else {
            format!("({inner})")
        };

        if i > 0 {
            let logic = condition
                .logic
                .ok_or_else(|| DbError::FilterParse(format!("condition {i} is missing logic")))?;
            clause.push_str(match logic {
                Logic::And => " AND ",
                Logic::Or => " OR ",
            });
        }
        clause.push_str(&wrapped);
    }
    Ok((format!(" where {clause}"), values))
}

impl DbSource for SqliteSource {
    async fn list_schemas(&self) -> Result<Vec<String>, DbError> {
        Ok(vec![ONLY_SCHEMA.to_string()])
    }

    async fn list_tables(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        check_schema(schema)?;
        let names = self.allowed_tables().await?;
        // No `obj_description` equivalent in SQLite — comments unsupported.
        Ok(names
            .into_iter()
            .map(|name| TableInfo {
                name,
                comment: None,
            })
            .collect())
    }

    async fn table_counts(&self, schema: Option<&str>) -> Result<Vec<(String, i64)>, DbError> {
        check_schema(schema)?;
        let tables = self.allowed_tables().await?;
        // SQLite has no reltuples-equivalent catalog estimate; -1 is the
        // documented "no estimate" sentinel (spec/protocol.md §5.3) rather
        // than a per-table COUNT(*) scan. See docs/adapter-decisions.md.
        Ok(tables.into_iter().map(|table| (table, -1i64)).collect())
    }

    async fn query_table(
        &self,
        schema: Option<&str>,
        table: &str,
        opts: QueryOpts,
    ) -> Result<TableData, DbError> {
        check_schema(schema)?;
        let tables = self.allowed_tables().await?;
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

        let (where_clause, filter_values) = match &opts.filter {
            Some(filter) => build_where_clause(filter, &column_names)?,
            None => (String::new(), Vec::new()),
        };

        let (pk_columns, fk_columns) = self.key_metadata(&table).await?;
        let pragma_table = quote_ident(&table);
        let column_types: Vec<(String, String)> = self
            .bounded(CATALOG_TIMEOUT_SECS, async move |conn| {
                let rows =
                    sqlx::query_as::<_, (i64, String, String)>(sqlx::AssertSqlSafe(format!(
                        "select cid, name, type from pragma_table_info({pragma_table}) \
                         order by cid"
                    )))
                    .fetch_all(&mut *conn)
                    .await?;
                Ok(rows.into_iter().map(|(_, name, ty)| (name, ty)).collect())
            })
            .await?;

        let columns: Vec<ColumnInfo> = column_types
            .into_iter()
            .map(|(name, type_name)| {
                let (key, references) = if pk_columns.contains(&name) {
                    (Some(KeyKind::Pk), None)
                } else if let Some(r) = fk_columns.get(&name) {
                    (Some(KeyKind::Fk), Some(r.clone()))
                } else {
                    (None, None)
                };
                ColumnInfo {
                    name,
                    // SQLite's declared column types can be empty ("");
                    // fall back to a stable label rather than emitting "".
                    type_name: if type_name.is_empty() {
                        "unknown".to_string()
                    } else {
                        type_name
                    },
                    key,
                    references,
                    comment: None,
                }
            })
            .collect();

        let select_list = columns
            .iter()
            .map(|c| format!("CAST({} AS TEXT)", quote_ident(&c.name)))
            .collect::<Vec<_>>()
            .join(", ");
        let order_clause = match &sort {
            Some(col) => format!(
                " order by {}.{} {}",
                quote_ident(&table),
                quote_ident(col),
                if opts.descending { "desc" } else { "asc" }
            ),
            None => String::new(),
        };
        let quoted_table = quote_ident(&table);
        let sql = format!(
            "select {select_list} from {quoted_table}{where_clause}{order_clause} limit ? offset ?"
        );

        let limit = opts.limit as i64;
        let offset = opts.offset as i64;
        let (rows, columns) = self
            .bounded(opts.timeout_secs, async move |conn| {
                let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
                for value in &filter_values {
                    query = query.bind(value);
                }
                query = query.bind(limit).bind(offset);
                let sqlite_rows = query.fetch_all(&mut *conn).await?;

                let rows = sqlite_rows
                    .iter()
                    .map(|r| row_to_json(r, &columns))
                    .collect();
                Ok((rows, columns))
            })
            .await?;

        Ok(TableData {
            columns,
            rows,
            // No reltuples-equivalent estimate to read; -1 is the
            // documented "no estimate" sentinel (spec/protocol.md §5.4.4),
            // not a second COUNT(*) scan on every page load.
            total_approx: -1,
        })
    }

    async fn common_values(
        &self,
        schema: Option<&str>,
        table: &str,
        column: &str,
    ) -> Result<Vec<(String, f32)>, DbError> {
        check_schema(schema)?;
        let tables = self.allowed_tables().await?;
        let table = tables
            .iter()
            .find(|t| t.as_str() == table)
            .ok_or_else(|| DbError::NotAllowed(format!("table {table:?}")))?
            .clone();
        let columns = self.allowed_columns(&table).await?;
        columns
            .iter()
            .find(|c| c.as_str() == column)
            .ok_or_else(|| DbError::NotAllowed(format!("column {column:?}")))?;

        // No pg_stats equivalent to read; an empty list is the documented
        // "no statistics available" answer (spec/protocol.md §5.5), not a
        // live GROUP BY scan. See docs/adapter-decisions.md.
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn seeded_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(
            "create table users (\
                id integer primary key, \
                email text not null, \
                age integer\
             );\
             create table orders (\
                id integer primary key, \
                user_id integer references users(id), \
                status text not null\
             );"
            .to_string(),
        ))
        .execute(&pool)
        .await
        .unwrap();
        for (email, age) in [("a@x.com", 30), ("b@x.com", 30), ("c@x.com", 40)] {
            sqlx::query(sqlx::AssertSqlSafe(
                "insert into users (email, age) values (?, ?)".to_string(),
            ))
            .bind(email)
            .bind(age)
            .execute(&pool)
            .await
            .unwrap();
        }
        sqlx::query(sqlx::AssertSqlSafe(
            "insert into orders (user_id, status) values (1, 'open')".to_string(),
        ))
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn list_tables_and_query_table_round_trip() {
        let source = SqliteSource::new(seeded_pool().await);

        let tables = source.list_tables(None).await.unwrap();
        let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["orders", "users"]);
        assert!(tables.iter().all(|t| t.comment.is_none()));

        assert_eq!(source.list_schemas().await.unwrap(), vec!["main"]);
        assert!(matches!(
            source.list_tables(Some("other")).await,
            Err(DbError::NotAllowed(_))
        ));

        let data = source
            .query_table(
                None,
                "users",
                QueryOpts {
                    limit: 10,
                    offset: 0,
                    sort: Some("age".to_string()),
                    descending: false,
                    timeout_secs: 5,
                    filter: None,
                },
            )
            .await
            .unwrap();
        // No reltuples-equivalent estimate on SQLite; always the -1
        // sentinel (spec/protocol.md §5.4.4), not a live COUNT(*).
        assert_eq!(data.total_approx, -1);
        assert_eq!(data.rows.len(), 3);
        assert_eq!(
            data.columns.iter().find(|c| c.name == "id").unwrap().key,
            Some(KeyKind::Pk)
        );
        // Every cell is a JSON string or null (matches the Postgres
        // `row_to_json`'s contract dbviewer.html relies on).
        for row in &data.rows {
            for value in row.values() {
                assert!(value.is_string() || value.is_null());
            }
        }
    }

    #[tokio::test]
    async fn foreign_key_column_reports_key_and_references() {
        let source = SqliteSource::new(seeded_pool().await);
        let data = source
            .query_table(
                None,
                "orders",
                QueryOpts {
                    limit: 10,
                    offset: 0,
                    sort: None,
                    descending: false,
                    timeout_secs: 5,
                    filter: None,
                },
            )
            .await
            .unwrap();
        let user_id_col = data.columns.iter().find(|c| c.name == "user_id").unwrap();
        assert_eq!(user_id_col.key, Some(KeyKind::Fk));
        assert_eq!(user_id_col.references.as_ref().unwrap().table, "users");
        assert_eq!(user_id_col.references.as_ref().unwrap().column, "id");
    }

    #[tokio::test]
    async fn table_counts_reports_no_estimate_sentinel() {
        let source = SqliteSource::new(seeded_pool().await);
        let counts = source.table_counts(None).await.unwrap();
        // No reltuples-equivalent catalog on SQLite; always -1
        // (spec/protocol.md §5.3), not a per-table COUNT(*).
        assert_eq!(
            counts,
            vec![("orders".to_string(), -1), ("users".to_string(), -1)]
        );
    }

    #[tokio::test]
    async fn common_values_is_always_empty_on_sqlite() {
        let source = SqliteSource::new(seeded_pool().await);
        // No pg_stats equivalent on SQLite; always empty
        // (spec/protocol.md §5.5's "no statistics available" case), not a
        // live GROUP BY scan.
        let values = source.common_values(None, "users", "age").await.unwrap();
        assert!(values.is_empty());
    }

    #[tokio::test]
    async fn common_values_rejects_unknown_column() {
        let source = SqliteSource::new(seeded_pool().await);
        assert!(matches!(
            source.common_values(None, "users", "nope").await,
            Err(DbError::NotAllowed(_))
        ));
    }

    #[tokio::test]
    async fn slow_query_is_aborted_by_the_progress_handler_not_left_to_run() {
        let source = SqliteSource::new(seeded_pool().await);
        // A recursive CTE generating far more rows than a 1s budget should
        // allow it to finish counting — proves the progress handler
        // actually interrupts execution, not just the caller's wait.
        let err = source
            .bounded(1, async |conn| {
                sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(
                    "with recursive slow(x) as (\
                        select 1 union all select x + 1 from slow where x < 100000000\
                     ) select count(*) from slow"
                        .to_string(),
                ))
                .fetch_one(&mut *conn)
                .await
                .map_err(DbError::from)
            })
            .await;
        assert!(err.is_err(), "expected the slow query to be interrupted");

        // The connection must still be usable afterward — proves the
        // handler was cleared, not left armed with a stale deadline.
        let ok = source
            .bounded(5, async |conn| {
                sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe("select 1".to_string()))
                    .fetch_one(&mut *conn)
                    .await
                    .map_err(DbError::from)
            })
            .await;
        assert_eq!(ok.unwrap(), 1);
    }
}
