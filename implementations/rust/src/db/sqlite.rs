use std::collections::HashMap;
use std::time::{Duration, Instant};

use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};

use super::{
    op_sql, ColumnInfo, ColumnRef, DbError, DbSource, KeyKind, QueryOpts, TableData, TableInfo,
};
use crate::filter::{Condition, FilterOp, Logic};

/// Catalog/metadata queries have no per-request timeout knob, but must
/// still be bounded — same value as `Limits::query_timeout_secs`'s default
/// (mirrors `postgres::CATALOG_TIMEOUT_SECS`).
const CATALOG_TIMEOUT_SECS: u32 = 5;

/// Cap for the live `GROUP BY` `common_values` falls back to (SQLite has no
/// `pg_stats` equivalent to read pre-computed frequencies from) — matches
/// roughly what Postgres's planner-stats typically return.
const COMMON_VALUES_LIMIT: i64 = 20;

/// SQLite spike, gated behind the `sqlite` feature — not a listed/conformant
/// port (`docs/design.md` §2 non-goal, `PORTING.md`). See
/// `/home/vscode/.claude/plans/sharded-swimming-wozniak.md` for the scope
/// this was built against.
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
        let table = table.to_string();
        self.bounded(CATALOG_TIMEOUT_SECS, async move |conn| {
            let rows = sqlx::query_as::<_, (i64, String)>(sqlx::AssertSqlSafe(format!(
                "select cid, name from pragma_table_info(\"{table}\") order by cid"
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
        let table = table.to_string();
        self.bounded(CATALOG_TIMEOUT_SECS, async move |conn| {
            let cols = sqlx::query_as::<_, (i64, String, i64)>(sqlx::AssertSqlSafe(format!(
                "select cid, name, pk from pragma_table_info(\"{table}\") order by cid"
            )))
            .fetch_all(&mut *conn)
            .await?;
            let pk_columns: Vec<String> = cols
                .into_iter()
                .filter(|(_, _, pk)| *pk > 0)
                .map(|(_, name, _)| name)
                .collect();

            // (id, seq, table, from, to) — `id` groups columns belonging to
            // the same constraint (composite FKs share an id).
            let fks = sqlx::query_as::<_, (i64, i64, String, String, String)>(sqlx::AssertSqlSafe(
                format!(
                    "select id, seq, \"table\", \"from\", \"to\" \
                     from pragma_foreign_key_list(\"{table}\")"
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
        let inner = if condition.op.takes_value() {
            let value = condition.value.clone().ok_or_else(|| {
                DbError::FilterParse(format!("op {:?} requires a value", condition.op.as_wire()))
            })?;
            let frag = format!("CAST(\"{column}\" AS TEXT) {keyword} ?");
            values.push(value);
            frag
        } else {
            format!("CAST(\"{column}\" AS TEXT) {keyword}")
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
    async fn list_tables(&self) -> Result<Vec<TableInfo>, DbError> {
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

    async fn table_counts(&self) -> Result<Vec<(String, i64)>, DbError> {
        let tables = self.allowed_tables().await?;
        let mut counts = Vec::with_capacity(tables.len());
        for table in tables {
            let t = table.clone();
            let count = self
                .bounded(CATALOG_TIMEOUT_SECS, async move |conn| {
                    // `t` came from `allowed_tables` (sqlite_master), not
                    // user input.
                    let count: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                        "select count(*) from \"{t}\""
                    )))
                    .fetch_one(&mut *conn)
                    .await?;
                    Ok(count)
                })
                .await?;
            counts.push((table, count));
        }
        Ok(counts)
    }

    async fn query_table(&self, table: &str, opts: QueryOpts) -> Result<TableData, DbError> {
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
        let pragma_table = table.clone();
        let column_types: Vec<(String, String)> = self
            .bounded(CATALOG_TIMEOUT_SECS, async move |conn| {
                let rows =
                    sqlx::query_as::<_, (i64, String, String)>(sqlx::AssertSqlSafe(format!(
                        "select cid, name, type from pragma_table_info(\"{pragma_table}\") \
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
            .map(|c| format!("CAST(\"{}\" AS TEXT)", c.name))
            .collect::<Vec<_>>()
            .join(", ");
        let order_clause = match &sort {
            Some(col) => format!(
                " order by \"{}\".\"{}\" {}",
                table,
                col,
                if opts.descending { "desc" } else { "asc" }
            ),
            None => String::new(),
        };
        let sql = format!(
            "select {select_list} from \"{table}\"{where_clause}{order_clause} limit ? offset ?"
        );
        let count_sql = format!("select count(*) from \"{table}\"{where_clause}");

        let limit = opts.limit as i64;
        let offset = opts.offset as i64;
        let values_for_rows = filter_values.clone();
        let (rows, columns, total_approx) = self
            .bounded(opts.timeout_secs, async move |conn| {
                let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
                for value in &values_for_rows {
                    query = query.bind(value);
                }
                query = query.bind(limit).bind(offset);
                let sqlite_rows = query.fetch_all(&mut *conn).await?;

                let mut count_query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(count_sql));
                for value in &filter_values {
                    count_query = count_query.bind(value);
                }
                let total_approx = count_query.fetch_one(&mut *conn).await?;

                let rows = sqlite_rows
                    .iter()
                    .map(|r| row_to_json(r, &columns))
                    .collect();
                Ok((rows, columns, total_approx))
            })
            .await?;

        Ok(TableData {
            columns,
            rows,
            total_approx,
        })
    }

    async fn common_values(
        &self,
        table: &str,
        column: &str,
    ) -> Result<Vec<(String, f32)>, DbError> {
        let tables = self.allowed_tables().await?;
        let table = tables
            .iter()
            .find(|t| t.as_str() == table)
            .ok_or_else(|| DbError::NotAllowed(format!("table {table:?}")))?
            .clone();
        let columns = self.allowed_columns(&table).await?;
        let column = columns
            .iter()
            .find(|c| c.as_str() == column)
            .ok_or_else(|| DbError::NotAllowed(format!("column {column:?}")))?
            .clone();

        self.bounded(CATALOG_TIMEOUT_SECS, async move |conn| {
            let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "select count(*) from \"{table}\""
            )))
            .fetch_one(&mut *conn)
            .await?;
            if total == 0 {
                return Ok(Vec::new());
            }
            let rows = sqlx::query_as::<_, (String, i64)>(sqlx::AssertSqlSafe(format!(
                "select CAST(\"{column}\" AS TEXT) as val, count(*) as freq \
                 from \"{table}\" where \"{column}\" is not null \
                 group by \"{column}\" order by freq desc limit {COMMON_VALUES_LIMIT}"
            )))
            .fetch_all(&mut *conn)
            .await?;
            Ok(rows
                .into_iter()
                .map(|(val, freq)| (val, freq as f32 / total as f32))
                .collect())
        })
        .await
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

        let tables = source.list_tables().await.unwrap();
        let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["orders", "users"]);
        assert!(tables.iter().all(|t| t.comment.is_none()));

        let data = source
            .query_table(
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
        assert_eq!(data.total_approx, 3);
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
    async fn common_values_groups_and_reports_fractions() {
        let source = SqliteSource::new(seeded_pool().await);
        let values = source.common_values("users", "age").await.unwrap();
        let (val_30, freq_30) = values.iter().find(|(v, _)| v == "30").unwrap();
        assert_eq!(val_30, "30");
        assert!((freq_30 - 2.0 / 3.0).abs() < 1e-6);
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
