use std::collections::{HashMap, HashSet};

use sqlx::postgres::PgRow;
use sqlx::{PgPool, Postgres, Row, Transaction};

use super::{
    op_sql, quote_ident, ColumnInfo, ColumnRef, DbError, DbSource, KeyKind, QueryOpts, TableData,
    TableInfo,
};
use crate::filter::{Condition, Logic};

/// Catalog/metadata queries have no per-request timeout knob, but must
/// still be bounded — same value as `Limits::query_timeout_secs`'s default.
const CATALOG_TIMEOUT_SECS: u32 = 5;

/// Parameter numbering continues after `$1` (limit) and `$2` (offset), so
/// the first filter value is `$3`. Every column is matched against
/// `allowed_columns` before being spliced in. Conditions are joined with
/// their own `logic` tokens, relying on SQL's native AND-tighter-than-OR
/// precedence — no grouping exists in the AST. Postgres-specific:
/// `::text` cast syntax and `$N` placeholders are not portable to other
/// backends — see `sqlite::build_where_clause` for the SQLite equivalent.
fn build_where_clause(
    conditions: &[Condition],
    column_names: &[String],
) -> Result<(String, Vec<String>), DbError> {
    if conditions.is_empty() {
        return Ok((String::new(), Vec::new()));
    }

    let mut values = Vec::new();
    let mut next_param = 3;
    let mut clause = String::new();
    for (i, condition) in conditions.iter().enumerate() {
        let column = column_names
            .iter()
            .find(|c| c.as_str() == condition.column)
            .ok_or_else(|| DbError::NotAllowed(format!("column {:?}", condition.column)))?;

        // filter::parse already enforced these structurally; re-checking
        // here keeps build_where_clause safe on any input path (tests,
        // future callers) instead of trusting its caller.
        let inner = if condition.op.takes_value() {
            let value = condition.value.clone().ok_or_else(|| {
                DbError::FilterParse(format!("op {:?} requires a value", condition.op.as_wire()))
            })?;
            let frag = format!(
                "{}::text {} ${next_param}",
                quote_ident(column),
                op_sql(condition.op)
            );
            values.push(value);
            next_param += 1;
            frag
        } else {
            format!("{}::text {}", quote_ident(column), op_sql(condition.op))
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

#[derive(Clone)]
pub struct PgPoolSource {
    pool: PgPool,
}

impl PgPoolSource {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Every query runs through one of these so nothing can hold a
    /// connection unbounded: `SET LOCAL statement_timeout` only lasts for
    /// the enclosing transaction.
    async fn bounded_tx(
        &self,
        timeout_secs: u32,
    ) -> Result<sqlx::Transaction<'static, sqlx::Postgres>, DbError> {
        let mut tx = self.pool.begin().await?;
        // AssertSqlSafe: interpolates only a u32.
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "set local statement_timeout = '{timeout_secs}s'"
        )))
        .execute(&mut *tx)
        .await?;
        Ok(tx)
    }

    /// Excludes the catalogs themselves (`pg_catalog`, `information_schema`,
    /// `pg_toast%`, `pg_temp_%`) and anything the connected role can't
    /// actually use, so a schema only ever appears here if it's both a real
    /// user namespace and one this role has `USAGE` on.
    async fn list_schemas_in_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<Vec<String>, DbError> {
        let rows = sqlx::query_scalar::<_, String>(
            "select nspname from pg_namespace \
             where nspname not in ('pg_catalog', 'information_schema') \
               and nspname not like 'pg_toast%' \
               and nspname not like 'pg_temp\\_%' escape '\\' \
               and has_schema_privilege(nspname, 'USAGE') \
             order by nspname",
        )
        .fetch_all(&mut **tx)
        .await?;
        Ok(rows)
    }

    /// Resolves the schema for this operation exactly once, as the first
    /// statement in `tx`, and every later query in the same transaction
    /// reuses this value — since a `Transaction` stays pinned to one
    /// physical connection for its whole lifetime, this is immune to the
    /// pool session drift `tests/schema_isolation.rs` guards against. An
    /// explicit request and an absent one (resolved via `current_schema()`)
    /// both go through the same `list_schemas_in_tx` allow-list, so neither
    /// path can reach a schema the other would reject.
    async fn resolve_schema_in_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        requested: Option<&str>,
    ) -> Result<String, DbError> {
        let schemas = self.list_schemas_in_tx(tx).await?;
        let resolved = match requested {
            Some(name) => name.to_string(),
            None => {
                sqlx::query_scalar::<_, String>("select current_schema()")
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
        tx: &mut Transaction<'_, Postgres>,
        schema: &str,
    ) -> Result<Vec<String>, DbError> {
        let rows = sqlx::query_scalar::<_, String>(
            "select table_name from information_schema.tables \
             where table_schema = $1 and table_type = 'BASE TABLE' \
             order by table_name",
        )
        .bind(schema)
        .fetch_all(&mut **tx)
        .await?;
        Ok(rows)
    }

    async fn allowed_columns_in_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        schema: &str,
        table: &str,
    ) -> Result<Vec<String>, DbError> {
        let rows = sqlx::query_scalar::<_, String>(
            "select column_name from information_schema.columns \
             where table_schema = $1 and table_name = $2 \
             order by ordinal_position",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&mut **tx)
        .await?;
        Ok(rows)
    }

    /// Composite FKs are dropped rather than risk mislabeling which
    /// referencing column pairs with which referenced column.
    ///
    /// The `ccu` join must match on `ccu.constraint_schema` (the schema the
    /// constraint itself lives in, always equal to `tc.table_schema`), not
    /// `ccu.table_schema` (the schema of the table constraint_column_usage
    /// is describing — for a FOREIGN KEY row that's the *referenced*
    /// table's schema, which for a cross-schema FK differs from the
    /// constraining table's schema). Joining on `ccu.table_schema` instead
    /// silently drops every cross-schema FK's metadata (the LEFT JOIN just
    /// never matches), which is the bug this comment is guarding against
    /// regressing to.
    async fn key_metadata_in_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        schema: &str,
        table: &str,
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
        >(
            "select tc.constraint_name, tc.constraint_type, kcu.column_name, \
                    ccu.table_schema as ref_schema, ccu.table_name as ref_table, \
                    ccu.column_name as ref_column \
             from information_schema.table_constraints tc \
             join information_schema.key_column_usage kcu \
               on kcu.constraint_name = tc.constraint_name \
              and kcu.table_schema = tc.table_schema \
             left join information_schema.constraint_column_usage ccu \
               on ccu.constraint_name = tc.constraint_name \
              and ccu.constraint_schema = tc.table_schema \
              and tc.constraint_type = 'FOREIGN KEY' \
             where tc.table_schema = $1 \
               and tc.table_name = $2 \
               and tc.constraint_type in ('PRIMARY KEY', 'FOREIGN KEY')",
        )
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
                // Same-schema is the overwhelming common case; omitting
                // `schema` there keeps the wire payload byte-identical to
                // before this field existed.
                let schema = (ref_schema != schema).then_some(ref_schema);
                fk_columns.insert(
                    column_name,
                    ColumnRef {
                        table: ref_table,
                        column: ref_column,
                        schema,
                    },
                );
            }
        }
        Ok((pk_columns, fk_columns))
    }
}

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
    async fn list_schemas(&self) -> Result<Vec<String>, DbError> {
        let mut tx = self.bounded_tx(CATALOG_TIMEOUT_SECS).await?;
        let schemas = self.list_schemas_in_tx(&mut tx).await?;
        tx.commit().await?;
        Ok(schemas)
    }

    async fn list_tables(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        let mut tx = self.bounded_tx(CATALOG_TIMEOUT_SECS).await?;
        let schema = self.resolve_schema_in_tx(&mut tx, schema).await?;
        let rows = sqlx::query_as::<_, (String, Option<String>)>(
            "select c.relname::text, obj_description(c.oid, 'pg_class') \
             from pg_class c \
             join pg_namespace n on n.oid = c.relnamespace \
             where n.nspname = $1 and c.relkind = 'r' \
             order by c.relname",
        )
        .bind(&schema)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(rows
            .into_iter()
            .map(|(name, comment)| TableInfo { name, comment })
            .collect())
    }

    async fn table_counts(&self, schema: Option<&str>) -> Result<Vec<(String, i64)>, DbError> {
        let mut tx = self.bounded_tx(CATALOG_TIMEOUT_SECS).await?;
        let schema = self.resolve_schema_in_tx(&mut tx, schema).await?;
        let rows = sqlx::query_as::<_, (String, i64)>(
            "select c.relname::text, c.reltuples::bigint \
             from pg_class c \
             join pg_namespace n on n.oid = c.relnamespace \
             where n.nspname = $1 and c.relkind = 'r' \
             order by c.relname",
        )
        .bind(&schema)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(rows)
    }

    async fn query_table(
        &self,
        schema: Option<&str>,
        table: &str,
        opts: QueryOpts,
    ) -> Result<TableData, DbError> {
        let mut tx = self.bounded_tx(opts.timeout_secs).await?;
        let schema = self.resolve_schema_in_tx(&mut tx, schema).await?;
        let tables = self.allowed_tables_in_tx(&mut tx, &schema).await?;
        let table = tables
            .iter()
            .find(|t| t.as_str() == table)
            .ok_or_else(|| DbError::NotAllowed(format!("table {table:?}")))?
            .clone();

        let column_names = self.allowed_columns_in_tx(&mut tx, &schema, &table).await?;
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

        let column_types = sqlx::query_as::<_, (String, String)>(
            "select column_name, data_type from information_schema.columns \
             where table_schema = $1 and table_name = $2 \
             order by ordinal_position",
        )
        .bind(&schema)
        .bind(&table)
        .fetch_all(&mut *tx)
        .await?;
        // Joins through pg_attribute/pg_class directly: col_description is
        // keyed by attnum, which can diverge from ordinal_position once a
        // column has been dropped.
        let column_comments: HashMap<String, String> =
            sqlx::query_as::<_, (String, Option<String>)>(
                "select a.attname::text, col_description(a.attrelid, a.attnum::int) \
             from pg_attribute a \
             join pg_class c on c.oid = a.attrelid \
             join pg_namespace n on n.oid = c.relnamespace \
             where n.nspname = $1 and c.relname = $2 \
               and a.attnum > 0 and not a.attisdropped",
            )
            .bind(&schema)
            .bind(&table)
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .filter_map(|(name, comment)| comment.map(|c| (name, c)))
            .collect();
        let (pk_columns, fk_columns) = self.key_metadata_in_tx(&mut tx, &schema, &table).await?;
        let columns: Vec<ColumnInfo> = column_types
            .into_iter()
            .map(|(name, type_name)| {
                let (key, references) = if pk_columns.contains(&name) {
                    (Some(KeyKind::Pk), fk_columns.get(&name).cloned())
                } else if let Some(r) = fk_columns.get(&name) {
                    (Some(KeyKind::Fk), Some(r.clone()))
                } else {
                    (None, None)
                };
                let comment = column_comments.get(&name).cloned();
                ColumnInfo {
                    name,
                    type_name,
                    key,
                    references,
                    comment,
                }
            })
            .collect();

        let select_list = columns
            .iter()
            .map(|c| format!("{}::text", quote_ident(&c.name)))
            .collect::<Vec<_>>()
            .join(", ");
        // Table-qualified (by relation name, not schema — a FROM item's
        // correlation name is its own relation name regardless of whether
        // FROM itself is schema-qualified): an unqualified `order by "col"`
        // would resolve to the `::text`-cast output column in select_list,
        // sorting lexicographically instead of by the real typed value.
        let order_clause = match &sort {
            Some(col) => format!(
                " order by {}.{} {}",
                quote_ident(&table),
                quote_ident(col),
                if opts.descending { "desc" } else { "asc" }
            ),
            None => String::new(),
        };
        let sql = format!(
            "select {select_list} from {}.{}{where_clause}{order_clause} limit $1 offset $2",
            quote_ident(&schema),
            quote_ident(&table)
        );

        // AssertSqlSafe: sql interpolates only schema-validated identifiers
        // and hardcoded operator fragments; all values are bound.
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(opts.limit as i64)
            .bind(opts.offset as i64);
        for value in filter_values {
            query = query.bind(value);
        }
        let pg_rows = query.fetch_all(&mut *tx).await?;
        let total_approx = sqlx::query_scalar::<_, i64>(
            "select reltuples::bigint from pg_class c \
             join pg_namespace n on n.oid = c.relnamespace \
             where n.nspname = $1 and c.relname = $2",
        )
        .bind(&schema)
        .bind(&table)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;

        let rows = pg_rows.iter().map(|r| row_to_json(r, &columns)).collect();
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
        let mut tx = self.bounded_tx(CATALOG_TIMEOUT_SECS).await?;
        let schema = self.resolve_schema_in_tx(&mut tx, schema).await?;
        let tables = self.allowed_tables_in_tx(&mut tx, &schema).await?;
        let table = tables
            .iter()
            .find(|t| t.as_str() == table)
            .ok_or_else(|| DbError::NotAllowed(format!("table {table:?}")))?
            .clone();
        let columns = self.allowed_columns_in_tx(&mut tx, &schema, &table).await?;
        let column = columns
            .iter()
            .find(|c| c.as_str() == column)
            .ok_or_else(|| DbError::NotAllowed(format!("column {column:?}")))?
            .clone();

        // most_common_vals is anyarray; ::text::text[] reads it uniformly
        // without fighting Rust-side type inference. NULL (no ANALYZE stats
        // yet) unnests to zero rows, not an error.
        let rows = sqlx::query_as::<_, (String, f32)>(
            "select t.val, t.freq \
             from pg_stats, \
                  lateral unnest(most_common_vals::text::text[], most_common_freqs) as t(val, freq) \
             where schemaname = $1 and tablename = $2 and attname = $3 \
             order by t.freq desc",
        )
        .bind(&schema)
        .bind(&table)
        .bind(&column)
        .fetch_all(&mut *tx)
        .await?;

        let data_type = sqlx::query_scalar::<_, String>(
            "select data_type from information_schema.columns \
             where table_schema = $1 and table_name = $2 and column_name = $3",
        )
        .bind(&schema)
        .bind(&table)
        .bind(&column)
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;
        // boolean's array-literal text form is "t"/"f", not "true"/"false" —
        // normalize to match row_to_json's rendering.
        let rows = if data_type.as_deref() == Some("boolean") {
            rows.into_iter()
                .map(|(val, freq)| {
                    let val = match val.as_str() {
                        "t" => "true".to_string(),
                        "f" => "false".to_string(),
                        _ => val,
                    };
                    (val, freq)
                })
                .collect()
        } else {
            rows
        };
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filter;

    /// Shared fixture runner over `spec/fixtures/filter-builder-tests.json`
    /// (schema: `spec/fixtures/README.md`) — the same file every port's
    /// runner and the black-box HTTP suite consume, so validation/building
    /// behavior can't drift between them.
    const FIXTURES: &str = include_str!("../../../../spec/fixtures/filter-builder-tests.json");

    #[derive(serde::Deserialize)]
    struct FixtureFile {
        cases: Vec<FixtureCase>,
    }

    #[derive(serde::Deserialize)]
    struct FixtureCase {
        name: String,
        table: String,
        conditions: Option<serde_json::Value>,
        raw: Option<String>,
        expect: Option<ExpectedWhere>,
        expect_error: Option<String>,
    }

    #[derive(serde::Deserialize)]
    struct ExpectedWhere {
        #[serde(rename = "where")]
        where_clause: String,
        values: Vec<String>,
    }

    /// Static mirror of the seed schema's columns for the tables the
    /// fixture references (README: unit runners substitute this for the
    /// live `information_schema` lookup).
    fn seed_columns(table: &str) -> Vec<String> {
        let cols: &[&str] = match table {
            "users" => &[
                "id",
                "email",
                "full_name",
                "age",
                "is_active",
                "login_count",
                "metadata",
                "last_login_at",
                "created_at",
            ],
            "orders" => &[
                "id",
                "user_id",
                "status",
                "total_cents",
                "discount_pct",
                "tags",
                "line_items",
                "created_at",
            ],
            "products" => &[
                "id",
                "sku",
                "name",
                "category",
                "price",
                "weight_kg",
                "in_stock",
                "description",
                "created_on",
            ],
            other => panic!("fixture references unmapped table {other:?}"),
        };
        cols.iter().map(|c| c.to_string()).collect()
    }

    /// Fixture placeholders are numbered from `$1`; this implementation binds
    /// limit/offset first, so its real clause starts at `$3`.
    fn shift_placeholders(fragment: &str, by: u32) -> String {
        let mut out = String::with_capacity(fragment.len());
        let mut chars = fragment.chars().peekable();
        while let Some(c) = chars.next() {
            if c != '$' {
                out.push(c);
                continue;
            }
            let mut digits = String::new();
            while let Some(d) = chars.peek().filter(|d| d.is_ascii_digit()) {
                digits.push(*d);
                chars.next();
            }
            out.push('$');
            out.push_str(&(digits.parse::<u32>().unwrap() + by).to_string());
        }
        out
    }

    #[test]
    fn filter_builder_fixtures() {
        let file: FixtureFile = serde_json::from_str(FIXTURES).unwrap();
        assert!(!file.cases.is_empty());
        for case in &file.cases {
            let name = &case.name;
            let raw = match (&case.raw, &case.conditions) {
                (Some(raw), _) => raw.clone(),
                (None, Some(conditions)) => serde_json::to_string(conditions).unwrap(),
                (None, None) => panic!("case {name}: neither raw nor conditions"),
            };
            let parsed = filter::parse(&raw);
            match (&case.expect, &case.expect_error) {
                (Some(expected), None) => {
                    let conditions =
                        parsed.unwrap_or_else(|e| panic!("case {name}: parse failed: {e}"));
                    let (where_clause, values) =
                        build_where_clause(&conditions, &seed_columns(&case.table))
                            .unwrap_or_else(|e| panic!("case {name}: build failed: {e}"));
                    let expected_clause = if expected.where_clause.is_empty() {
                        String::new()
                    } else {
                        format!(" where {}", shift_placeholders(&expected.where_clause, 2))
                    };
                    assert_eq!(where_clause, expected_clause, "case {name}: WHERE mismatch");
                    assert_eq!(values, expected.values, "case {name}: bind values mismatch");
                }
                (None, Some(kind)) if kind == "unknown_column" => {
                    let conditions = parsed.unwrap_or_else(|e| {
                        panic!("case {name}: should parse (rejection is builder-stage): {e}")
                    });
                    match build_where_clause(&conditions, &seed_columns(&case.table)) {
                        Err(DbError::NotAllowed(_)) => {}
                        other => panic!(
                            "case {name}: expected NotAllowed from the builder, got {other:?}"
                        ),
                    }
                }
                (None, Some(kind)) => {
                    assert!(
                        parsed.is_err(),
                        "case {name}: expected structural rejection ({kind}), but it parsed"
                    );
                }
                _ => panic!("case {name}: exactly one of expect/expect_error required"),
            }
        }
    }
}
