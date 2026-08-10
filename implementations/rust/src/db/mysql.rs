use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};

use sqlx::mysql::MySqlRow;
use sqlx::{MySql, MySqlPool, Row, Transaction};

use super::{
    op_sql, ColumnInfo, ColumnRef, DbError, DbSource, KeyKind, QueryOpts, TableData, TableInfo,
};
use crate::filter::{Condition, FilterOp, Logic};

/// Catalog/metadata queries have no per-request timeout knob, but must
/// still be bounded — same value as `Limits::query_timeout_secs`'s default
/// (mirrors `postgres::CATALOG_TIMEOUT_SECS`/`sqlite::CATALOG_TIMEOUT_SECS`).
const CATALOG_TIMEOUT_SECS: u32 = 5;

/// `sqlx`'s `mysql` driver speaks the wire protocol both engines
/// implement, but the two forks need different SQL for the one thing this
/// crate relies on: a per-query timeout (see `timed_select`). Detected
/// once per `MySqlSource` via `variant()` and cached, not re-checked per
/// request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Variant {
    MySql,
    MariaDb,
}

/// MySQL's `SET LOCAL` is a documented plain synonym for `SET SESSION` —
/// unlike Postgres's genuinely transaction-scoped `SET LOCAL
/// statement_timeout`, copying that pattern verbatim would leak a timeout
/// onto the pooled connection's next reuse. Both forks instead offer a
/// self-resetting per-statement mechanism, but not the same one: MySQL's
/// `MAX_EXECUTION_TIME` is an optimizer hint spliced inline right after
/// `select`, its required placement. MariaDB never implemented that hint
/// — an unrecognized `/*+ ... */` comment is silently ignored rather than
/// rejected, so reusing MySQL's hint there would fail open, silently not
/// enforcing the timeout at all — and instead wraps the *whole* statement
/// in `SET STATEMENT max_statement_time=N FOR ...` (plain seconds, not
/// milliseconds). Either way nothing needs clearing before the connection
/// returns to the pool, unlike SQLite's progress handler (see
/// `sqlite.rs`). `body` is the SQL text starting right after the `select`
/// keyword this function supplies.
fn timed_select(variant: Variant, timeout_secs: u32, body: &str) -> String {
    match variant {
        Variant::MySql => format!(
            "select /*+ MAX_EXECUTION_TIME({}) */ {body}",
            timeout_secs as u64 * 1000
        ),
        Variant::MariaDb => {
            format!("set statement max_statement_time={timeout_secs} for select {body}")
        }
    }
}

/// MySQL's default identifier quote is the backtick, not `"` — double-quote
/// identifier quoting only works under session-wide `ANSI_QUOTES`, which
/// this crate has no business forcing on a host's connection. The shared
/// `quote_ident` in `db/mod.rs` is documented as Postgres/SQLite-specific
/// and isn't reused here; doubling an embedded backtick is MySQL's own
/// documented escape, the same doubling *strategy* `quote_ident` uses for
/// `"`, just a different character.
fn quote_ident_mysql(ident: &str) -> String {
    format!("`{}`", ident.replace('`', "``"))
}

/// MySQL equivalent of `postgres::build_where_clause`/
/// `sqlite::build_where_clause`: `?` placeholders (positional, like
/// SQLite, not `$N`), `CAST(col AS CHAR)` instead of `::text`/
/// `CAST(col AS TEXT)` (MySQL has no `::` operator and no `TEXT` cast
/// target), and `ILIKE` mapped to `LOWER(...) LIKE LOWER(?)` rather than a
/// bare keyword swap — unlike SQLite, whose plain `LIKE` is unconditionally
/// ASCII case-insensitive, MySQL's `LIKE` case-sensitivity depends on the
/// column's collation, which this crate has no control over. See
/// `docs/adapter-decisions.md` §5.4.2.
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
        let cast = format!("CAST({} AS CHAR)", quote_ident_mysql(column));

        let inner = if condition.op == FilterOp::Ilike {
            let value = condition.value.clone().ok_or_else(|| {
                DbError::FilterParse(format!("op {:?} requires a value", condition.op.as_wire()))
            })?;
            values.push(value);
            format!("LOWER({cast}) LIKE LOWER(?)")
        } else if condition.op.takes_value() {
            let value = condition.value.clone().ok_or_else(|| {
                DbError::FilterParse(format!("op {:?} requires a value", condition.op.as_wire()))
            })?;
            values.push(value);
            format!("{cast} {} ?", op_sql(condition.op))
        } else {
            format!("{cast} {}", op_sql(condition.op))
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

/// Reviewed and supported, gated behind the `mysql` feature (off by
/// default). Not run through `conformance/runner` — see
/// `docs/adapter-decisions.md` for the per-clause decisions this makes
/// where Postgres-specific catalog/stats mechanisms have no equivalent.
#[derive(Clone)]
pub struct MySqlSource {
    pool: MySqlPool,
    variant: Arc<OnceLock<Variant>>,
}

impl MySqlSource {
    pub fn new(pool: MySqlPool) -> Self {
        Self {
            pool,
            variant: Arc::new(OnceLock::new()),
        }
    }

    /// `SELECT VERSION()` returns a string containing `MariaDB` on that
    /// fork (e.g. `10.11.6-MariaDB-1:10.11.6+maria~ubu2004`) and just a
    /// bare version like `8.0.35` on real MySQL — the standard sniff other
    /// drivers use, since there's no dedicated boolean-returning function
    /// for it. Cached in `Arc<OnceLock<_>>` so clones of this `MySqlSource`
    /// share one detection; a lost race between concurrent first calls is
    /// harmless since both would detect the same value.
    async fn variant(&self) -> Result<Variant, DbError> {
        if let Some(v) = self.variant.get() {
            return Ok(*v);
        }
        let version: String =
            sqlx::query_scalar(sqlx::AssertSqlSafe("select version()".to_string()))
                .fetch_one(&self.pool)
                .await?;
        let detected = if version.to_ascii_lowercase().contains("mariadb") {
            Variant::MariaDb
        } else {
            Variant::MySql
        };
        let _ = self.variant.set(detected);
        Ok(detected)
    }

    /// Schema pinning only. A `Transaction` stays bound to one physical
    /// connection for its whole lifetime, so resolving the schema once as
    /// the first statement and reusing it for the rest of the operation is
    /// immune to pool session drift, mirroring
    /// `postgres::PgPoolSource::bounded_tx` — but unlike that method, this
    /// sets no session/transaction-scoped timeout, since the timeout
    /// mechanism (`timed_select`) is applied per-query instead.
    async fn pinned_tx(&self) -> Result<Transaction<'static, MySql>, DbError> {
        Ok(self.pool.begin().await?)
    }

    /// Excludes MySQL's own internal schemas. There is no single
    /// boolean-returning privilege-check function equivalent to Postgres's
    /// `has_schema_privilege` — accepted as a documented gap in
    /// `docs/adapter-decisions.md` (§5.7's exclusion is a SHOULD, not a
    /// MUST).
    async fn list_schemas_in_tx(
        &self,
        tx: &mut Transaction<'_, MySql>,
        variant: Variant,
        timeout_secs: u32,
    ) -> Result<Vec<String>, DbError> {
        let rows = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(timed_select(
            variant,
            timeout_secs,
            "schema_name from information_schema.schemata \
             where schema_name not in ('mysql', 'information_schema', 'performance_schema', 'sys') \
             order by schema_name",
        )))
        .fetch_all(&mut **tx)
        .await?;
        Ok(rows)
    }

    /// Resolves the schema for this operation exactly once, as the first
    /// statement in `tx` — see `pinned_tx`. `current_schema()` has no MySQL
    /// equivalent; `select database()` is the analogous "connection's own
    /// default" read.
    async fn resolve_schema_in_tx(
        &self,
        tx: &mut Transaction<'_, MySql>,
        variant: Variant,
        requested: Option<&str>,
        timeout_secs: u32,
    ) -> Result<String, DbError> {
        let schemas = self.list_schemas_in_tx(tx, variant, timeout_secs).await?;
        let resolved = match requested {
            Some(name) => name.to_string(),
            None => {
                sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(timed_select(
                    variant,
                    timeout_secs,
                    "database()",
                )))
                .fetch_one(&mut **tx)
                .await?
            }
        };
        schemas
            .into_iter()
            .find(|s| s == &resolved)
            .ok_or_else(|| DbError::NotAllowed(format!("schema {resolved:?}")))
    }

    async fn allowed_tables_in_tx(
        &self,
        tx: &mut Transaction<'_, MySql>,
        variant: Variant,
        schema: &str,
        timeout_secs: u32,
    ) -> Result<Vec<String>, DbError> {
        let rows = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(timed_select(
            variant,
            timeout_secs,
            "table_name from information_schema.tables \
             where table_schema = ? and table_type = 'BASE TABLE' \
             order by table_name",
        )))
        .bind(schema)
        .fetch_all(&mut **tx)
        .await?;
        Ok(rows)
    }

    async fn allowed_columns_in_tx(
        &self,
        tx: &mut Transaction<'_, MySql>,
        variant: Variant,
        schema: &str,
        table: &str,
        timeout_secs: u32,
    ) -> Result<Vec<String>, DbError> {
        let rows = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(timed_select(
            variant,
            timeout_secs,
            "column_name from information_schema.columns \
             where table_schema = ? and table_name = ? \
             order by ordinal_position",
        )))
        .bind(schema)
        .bind(table)
        .fetch_all(&mut **tx)
        .await?;
        Ok(rows)
    }

    /// Composite FKs are dropped rather than risk mislabeling which
    /// referencing column pairs with which referenced column, mirroring
    /// `postgres::PgPoolSource::key_metadata_in_tx`/
    /// `sqlite::SqliteSource::key_metadata`.
    ///
    /// The join includes `kcu.table_name = tc.table_name`, not just
    /// `constraint_name` — unlike Postgres's auto-generated,
    /// schema-unique constraint names, MySQL's primary-key constraint is
    /// *always* literally named `"PRIMARY"` on every table, so joining on
    /// `constraint_name` alone would match every other table's
    /// primary-key columns in the same schema.
    async fn key_metadata_in_tx(
        &self,
        tx: &mut Transaction<'_, MySql>,
        variant: Variant,
        schema: &str,
        table: &str,
        timeout_secs: u32,
    ) -> Result<(HashSet<String>, HashMap<String, ColumnRef>), DbError> {
        let rows = sqlx::query_as::<
            _,
            (
                String,
                String,
                String,
                Option<String>,
                Option<String>,
                Option<String>,
            ),
        >(sqlx::AssertSqlSafe(timed_select(
            variant,
            timeout_secs,
            "tc.constraint_name, tc.constraint_type, kcu.column_name, \
                    kcu.referenced_table_schema, kcu.referenced_table_name, \
                    kcu.referenced_column_name \
             from information_schema.table_constraints tc \
             join information_schema.key_column_usage kcu \
               on kcu.constraint_name = tc.constraint_name \
              and kcu.table_schema = tc.table_schema \
              and kcu.table_name = tc.table_name \
             where tc.table_schema = ? \
               and tc.table_name = ? \
               and tc.constraint_type in ('PRIMARY KEY', 'FOREIGN KEY')",
        )))
        .bind(schema)
        .bind(table)
        .fetch_all(&mut **tx)
        .await?;

        type FkCandidateRow = (String, Option<String>, Option<String>, Option<String>);

        let mut pk_columns = HashSet::new();
        let mut fk_candidates: HashMap<String, Vec<FkCandidateRow>> = HashMap::new();
        for (constraint_name, constraint_type, column_name, ref_schema, ref_table, ref_column) in
            rows
        {
            match constraint_type.as_str() {
                "PRIMARY KEY" => {
                    pk_columns.insert(column_name);
                }
                "FOREIGN KEY" => {
                    fk_candidates.entry(constraint_name).or_default().push((
                        column_name,
                        ref_schema,
                        ref_table,
                        ref_column,
                    ));
                }
                _ => {}
            }
        }

        let mut fk_columns = HashMap::new();
        for members in fk_candidates.into_values() {
            let distinct_columns: HashSet<&str> = members
                .iter()
                .map(|(name, _, _, _)| name.as_str())
                .collect();
            if distinct_columns.len() != 1 {
                continue;
            }
            if let Some((column_name, Some(ref_schema), Some(ref_table), Some(ref_column))) =
                members.into_iter().next()
            {
                let ref_schema_field = (ref_schema != schema).then_some(ref_schema);
                fk_columns.insert(
                    column_name,
                    ColumnRef {
                        table: ref_table,
                        column: ref_column,
                        schema: ref_schema_field,
                    },
                );
            }
        }
        Ok((pk_columns, fk_columns))
    }
}

fn row_to_json(
    row: &MySqlRow,
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

impl DbSource for MySqlSource {
    async fn list_schemas(&self) -> Result<Vec<String>, DbError> {
        let variant = self.variant().await?;
        let mut tx = self.pinned_tx().await?;
        let schemas = self
            .list_schemas_in_tx(&mut tx, variant, CATALOG_TIMEOUT_SECS)
            .await?;
        tx.commit().await?;
        Ok(schemas)
    }

    async fn list_tables(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        let variant = self.variant().await?;
        let mut tx = self.pinned_tx().await?;
        let schema = self
            .resolve_schema_in_tx(&mut tx, variant, schema, CATALOG_TIMEOUT_SECS)
            .await?;
        // TABLE_COMMENT sits as a plain column here — no obj_description-
        // style function call needed, unlike Postgres.
        let rows = sqlx::query_as::<_, (String, String)>(sqlx::AssertSqlSafe(timed_select(
            variant,
            CATALOG_TIMEOUT_SECS,
            "table_name, table_comment from information_schema.tables \
             where table_schema = ? and table_type = 'BASE TABLE' \
             order by table_name",
        )))
        .bind(&schema)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(rows
            .into_iter()
            .map(|(name, comment)| TableInfo {
                name,
                // Empty string means "no comment"; MUST be omitted, not
                // emitted as "" (spec/protocol.md §5.2).
                comment: (!comment.is_empty()).then_some(comment),
            })
            .collect())
    }

    async fn table_counts(&self, schema: Option<&str>) -> Result<Vec<(String, i64)>, DbError> {
        let variant = self.variant().await?;
        let mut tx = self.pinned_tx().await?;
        let schema = self
            .resolve_schema_in_tx(&mut tx, variant, schema, CATALOG_TIMEOUT_SECS)
            .await?;
        // TABLE_ROWS is an InnoDB-statistics estimate (reltuples-equivalent,
        // may be stale, refreshed by ANALYZE TABLE) — never COUNT(*). CAST
        // to SIGNED so it decodes as i64 the same way on every MySQL
        // version regardless of the catalog's exact unsigned width.
        let rows = sqlx::query_as::<_, (String, Option<i64>)>(sqlx::AssertSqlSafe(timed_select(
            variant,
            CATALOG_TIMEOUT_SECS,
            "table_name, cast(table_rows as signed) from information_schema.tables \
             where table_schema = ? and table_type = 'BASE TABLE' \
             order by table_name",
        )))
        .bind(&schema)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        // TABLE_ROWS is NULL before InnoDB has gathered any statistics for
        // a freshly created table — -1 is the same "no estimate yet"
        // sentinel Postgres uses before a table's first ANALYZE/VACUUM
        // (spec/protocol.md §5.3), not the "no mechanism at all" case
        // SQLite uses unconditionally.
        Ok(rows
            .into_iter()
            .map(|(name, count)| (name, count.unwrap_or(-1)))
            .collect())
    }

    async fn query_table(
        &self,
        schema: Option<&str>,
        table: &str,
        opts: QueryOpts,
    ) -> Result<TableData, DbError> {
        let variant = self.variant().await?;
        let mut tx = self.pinned_tx().await?;
        let timeout = opts.timeout_secs;
        let schema = self
            .resolve_schema_in_tx(&mut tx, variant, schema, timeout)
            .await?;
        let tables = self
            .allowed_tables_in_tx(&mut tx, variant, &schema, timeout)
            .await?;
        let table = tables
            .iter()
            .find(|t| t.as_str() == table)
            .ok_or_else(|| DbError::NotAllowed(format!("table {table:?}")))?
            .clone();

        let column_names = self
            .allowed_columns_in_tx(&mut tx, variant, &schema, &table, timeout)
            .await?;
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

        // DATA_TYPE and COLUMN_COMMENT both sit as plain columns on
        // information_schema.columns — unlike Postgres, no separate
        // pg_attribute join is needed to get comments, and no ordinal-
        // position-vs-attnum drift is possible.
        let column_meta =
            sqlx::query_as::<_, (String, String, String)>(sqlx::AssertSqlSafe(timed_select(
                variant,
                timeout,
                "column_name, data_type, column_comment \
                 from information_schema.columns \
                 where table_schema = ? and table_name = ? \
                 order by ordinal_position",
            )))
            .bind(&schema)
            .bind(&table)
            .fetch_all(&mut *tx)
            .await?;

        let (pk_columns, fk_columns) = self
            .key_metadata_in_tx(&mut tx, variant, &schema, &table, timeout)
            .await?;
        let columns: Vec<ColumnInfo> = column_meta
            .into_iter()
            .map(|(name, type_name, comment)| {
                let (key, references) = if pk_columns.contains(&name) {
                    (Some(KeyKind::Pk), fk_columns.get(&name).cloned())
                } else if let Some(r) = fk_columns.get(&name) {
                    (Some(KeyKind::Fk), Some(r.clone()))
                } else {
                    (None, None)
                };
                ColumnInfo {
                    name,
                    type_name,
                    key,
                    references,
                    comment: (!comment.is_empty()).then_some(comment),
                }
            })
            .collect();

        let select_list = columns
            .iter()
            .map(|c| format!("CAST({} AS CHAR)", quote_ident_mysql(&c.name)))
            .collect::<Vec<_>>()
            .join(", ");
        // Table-qualified, same reason as postgres.rs/sqlite.rs: an
        // unqualified `order by` would resolve to the CAST-output column in
        // select_list, sorting lexicographically instead of by the real
        // typed value.
        let order_clause = match &sort {
            Some(col) => format!(
                " order by {}.{} {}",
                quote_ident_mysql(&table),
                quote_ident_mysql(col),
                if opts.descending { "desc" } else { "asc" }
            ),
            None => String::new(),
        };
        let sql = timed_select(
            variant,
            timeout,
            &format!(
                "{select_list} from {}.{}{where_clause}{order_clause} limit ? offset ?",
                quote_ident_mysql(&schema),
                quote_ident_mysql(&table)
            ),
        );

        // AssertSqlSafe: sql interpolates only schema-validated identifiers
        // and hardcoded operator fragments; all values are bound.
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
        for value in &filter_values {
            query = query.bind(value);
        }
        query = query.bind(opts.limit as i64).bind(opts.offset as i64);
        let mysql_rows = query.fetch_all(&mut *tx).await?;
        let rows = mysql_rows
            .iter()
            .map(|r| row_to_json(r, &columns))
            .collect();

        let total_approx = sqlx::query_scalar::<_, Option<i64>>(sqlx::AssertSqlSafe(timed_select(
            variant,
            timeout,
            "cast(table_rows as signed) from information_schema.tables \
             where table_schema = ? and table_name = ?",
        )))
        .bind(&schema)
        .bind(&table)
        .fetch_one(&mut *tx)
        .await?
        .unwrap_or(-1);
        tx.commit().await?;

        Ok(TableData {
            columns,
            rows,
            total_approx,
        })
    }

    async fn common_values(
        &self,
        schema: Option<&str>,
        table: &str,
        column: &str,
    ) -> Result<Vec<(String, f32)>, DbError> {
        let variant = self.variant().await?;
        let mut tx = self.pinned_tx().await?;
        let schema = self
            .resolve_schema_in_tx(&mut tx, variant, schema, CATALOG_TIMEOUT_SECS)
            .await?;
        let tables = self
            .allowed_tables_in_tx(&mut tx, variant, &schema, CATALOG_TIMEOUT_SECS)
            .await?;
        let table = tables
            .iter()
            .find(|t| t.as_str() == table)
            .ok_or_else(|| DbError::NotAllowed(format!("table {table:?}")))?
            .clone();
        let columns = self
            .allowed_columns_in_tx(&mut tx, variant, &schema, &table, CATALOG_TIMEOUT_SECS)
            .await?;
        columns
            .iter()
            .find(|c| c.as_str() == column)
            .ok_or_else(|| DbError::NotAllowed(format!("column {column:?}")))?;
        tx.commit().await?;

        // No pg_stats equivalent. MySQL 8's information_schema.
        // COLUMN_STATISTICS histogram needs an explicit
        // `ANALYZE TABLE ... UPDATE HISTOGRAM` to populate and doesn't
        // exist at all on MariaDB/MySQL 5.7 — an empty list is the
        // documented "no statistics available" answer (spec/protocol.md
        // §5.5), mirroring SQLite's same deliberate choice, not a live
        // scan. See docs/adapter-decisions.md.
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn test_url() -> String {
        std::env::var("MYSQL_TEST_URL").expect(
            "MYSQL_TEST_URL must point at a reachable MySQL/MariaDB instance \
             to run `mysql` feature tests (see .devcontainer/docker-compose.yml)",
        )
    }

    /// MySQL has no `sqlite::memory:`-style disposable instance, so each
    /// test gets its own throwaway database rather than relying on
    /// isolation for free.
    struct SeededDb {
        pool: MySqlPool,
        name: String,
    }

    impl SeededDb {
        async fn drop_and_close(self) {
            self.pool.close().await;
            let admin = MySqlPool::connect(&test_url()).await.unwrap();
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "drop database `{}`",
                self.name
            )))
            .execute(&admin)
            .await
            .unwrap();
            admin.close().await;
        }
    }

    async fn seeded_db() -> SeededDb {
        let admin = MySqlPool::connect(&test_url()).await.unwrap();
        // A counter alone collides across separate `cargo test` invocations
        // against the same long-lived instance (it resets to 0 every
        // process run) — a run that panics before `drop_and_close` leaves
        // its database behind for the next run to collide with. The nanos
        // component makes that collision practically impossible even then.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let name = format!(
            "ashurbanipal_test_{nanos}_{}",
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        sqlx::query(sqlx::AssertSqlSafe(format!("create database `{name}`")))
            .execute(&admin)
            .await
            .unwrap();
        admin.close().await;

        let opts = sqlx::mysql::MySqlConnectOptions::from_str(&test_url())
            .unwrap()
            .database(&name);
        let pool = MySqlPool::connect_with(opts).await.unwrap();

        sqlx::query(sqlx::AssertSqlSafe(
            "create table users (\
                id integer primary key auto_increment, \
                email varchar(255) not null, \
                age integer\
             )"
            .to_string(),
        ))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(
            "create table orders (\
                id integer primary key auto_increment, \
                user_id integer, \
                status varchar(50) not null, \
                constraint fk_orders_user foreign key (user_id) references users(id)\
             )"
            .to_string(),
        ))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(
            "create table order_extra (\
                order_id integer primary key, \
                gift_message varchar(255), \
                constraint fk_order_extra_order foreign key (order_id) references orders(id)\
             )"
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
        sqlx::query(sqlx::AssertSqlSafe(
            "insert into order_extra (order_id, gift_message) values (1, 'enjoy!')".to_string(),
        ))
        .execute(&pool)
        .await
        .unwrap();

        SeededDb { pool, name }
    }

    #[tokio::test]
    async fn list_tables_and_query_table_round_trip() {
        let db = seeded_db().await;
        let source = MySqlSource::new(db.pool.clone());

        let tables = source.list_tables(None).await.unwrap();
        let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["order_extra", "orders", "users"]);
        assert!(tables.iter().all(|t| t.comment.is_none()));

        assert!(matches!(
            source.list_tables(Some("no_such_schema")).await,
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
        assert_eq!(data.rows.len(), 3);
        assert_eq!(
            data.columns.iter().find(|c| c.name == "id").unwrap().key,
            Some(KeyKind::Pk)
        );
        // Every cell is a JSON string or null (matches the Postgres/SQLite
        // row_to_json contract dbviewer.html relies on).
        for row in &data.rows {
            for value in row.values() {
                assert!(value.is_string() || value.is_null());
            }
        }

        db.drop_and_close().await;
    }

    #[tokio::test]
    async fn foreign_key_column_reports_key_and_references() {
        let db = seeded_db().await;
        let source = MySqlSource::new(db.pool.clone());
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

        db.drop_and_close().await;
    }

    #[tokio::test]
    async fn pk_and_fk_column_reports_both() {
        let db = seeded_db().await;
        let source = MySqlSource::new(db.pool.clone());
        let data = source
            .query_table(
                None,
                "order_extra",
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
        let order_id_col = data.columns.iter().find(|c| c.name == "order_id").unwrap();
        assert_eq!(order_id_col.key, Some(KeyKind::Pk));
        assert_eq!(order_id_col.references.as_ref().unwrap().table, "orders");
        assert_eq!(order_id_col.references.as_ref().unwrap().column, "id");

        db.drop_and_close().await;
    }

    #[tokio::test]
    async fn table_counts_reports_a_real_estimate() {
        let db = seeded_db().await;
        // InnoDB's background stats recalculation may not have run yet
        // right after insert — force it so the estimate is deterministic
        // for this test, without pretending the wire contract itself is
        // exact (it's still "MAY be stale/approximate" per spec/protocol.md
        // §5.3, same as Postgres's reltuples).
        sqlx::query(sqlx::AssertSqlSafe("analyze table users".to_string()))
            .execute(&db.pool)
            .await
            .unwrap();
        let source = MySqlSource::new(db.pool.clone());
        let counts = source.table_counts(None).await.unwrap();
        // Unlike SQLite's unconditional -1 (no mechanism at all), MySQL has
        // a real TABLE_ROWS estimate — assert it's a non-negative estimate,
        // not the "no mechanism" sentinel.
        let users_count = counts
            .iter()
            .find(|(name, _)| name == "users")
            .map(|(_, count)| *count)
            .unwrap();
        assert!(
            users_count >= 0,
            "expected a real estimate, got the no-estimate sentinel: {users_count}"
        );

        db.drop_and_close().await;
    }

    #[tokio::test]
    async fn common_values_is_always_empty_on_mysql() {
        let db = seeded_db().await;
        let source = MySqlSource::new(db.pool.clone());
        // No pg_stats equivalent on MySQL; always empty (spec/protocol.md
        // §5.5's "no statistics available" case), not a live scan.
        let values = source.common_values(None, "users", "age").await.unwrap();
        assert!(values.is_empty());

        db.drop_and_close().await;
    }

    #[tokio::test]
    async fn common_values_rejects_unknown_column() {
        let db = seeded_db().await;
        let source = MySqlSource::new(db.pool.clone());
        assert!(matches!(
            source.common_values(None, "users", "nope").await,
            Err(DbError::NotAllowed(_))
        ));

        db.drop_and_close().await;
    }

    #[tokio::test]
    async fn slow_query_is_aborted_by_the_timeout_mechanism() {
        let db = seeded_db().await;
        let source = MySqlSource::new(db.pool.clone());
        let variant = source.variant().await.unwrap();
        // Held for the whole test so the `SET SESSION` below (when needed)
        // and the timed query definitely land on the same physical
        // connection — a fresh acquire from `&db.pool` per query would risk
        // getting a different idle connection back.
        let mut conn = db.pool.acquire().await.unwrap();

        // MariaDB caps WITH RECURSIVE at `max_recursive_iterations` (default
        // 1000) regardless of `max_statement_time` — the CTE below would
        // otherwise finish in under a millisecond, long before the 1s
        // timeout gets a chance to fire, making this a broken test rather
        // than a passing one. MySQL has no such cap, so this is a no-op
        // there; harmless either way since it only affects this connection.
        if variant == Variant::MariaDb {
            sqlx::query(sqlx::AssertSqlSafe(
                "set session max_recursive_iterations = 100000000".to_string(),
            ))
            .execute(&mut *conn)
            .await
            .unwrap();
        }
        // Timeout checks happen at row-iteration checkpoints on both
        // forks — empirically, a bare `SELECT SLEEP(n)` never hits one, so
        // this needs a query that actually iterates rows, mirroring the
        // recursive-CTE approach `sqlite.rs`'s progress-handler test uses.
        let sql = timed_select(
            variant,
            1,
            "count(*) from (\
                with recursive slow(x) as (\
                    select 1 union all select x + 1 from slow where x < 100000000\
                ) select x from slow\
             ) t",
        );
        let err = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql))
            .fetch_one(&mut *conn)
            .await;
        assert!(err.is_err(), "expected the slow query to be interrupted");

        // The same connection must still be usable afterward — proves both
        // forks' per-statement mechanisms are self-resetting, no stale
        // state left behind the way an uncleared SQLite progress handler
        // would leave.
        let ok: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe("select 1".to_string()))
            .fetch_one(&mut *conn)
            .await
            .unwrap();
        assert_eq!(ok, 1);
        drop(conn);

        db.drop_and_close().await;
    }
}
