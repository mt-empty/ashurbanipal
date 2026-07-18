use std::collections::{HashMap, HashSet};

use serde::Serialize;
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};

use crate::filter::{CompareOp, Logic, ParsedFilter, Predicate};

/// Options for a single-table query. Everything here is already validated
/// by the route layer *except* `table`, `sort`, and each `filter` column,
/// which this layer checks against the live schema before touching SQL.
#[derive(Debug, Clone)]
pub struct QueryOpts {
    pub limit: u32,
    pub offset: u32,
    pub sort: Option<String>,
    pub descending: bool,
    pub timeout_secs: u32,
    /// Already syntactically parsed (`crate::filter::parse`), not yet
    /// schema-validated — `query_table` matches each condition's column
    /// against the live `information_schema` allow-list before it's
    /// spliced into SQL, the same way `sort` already is.
    pub filter: Option<ParsedFilter>,
}

/// A column's role in the table's key structure, surfaced to the frontend
/// purely as navigation metadata — see `references` for where an `Fk`
/// points. Never used to build SQL; it's informational only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyKind {
    Pk,
    Fk,
}

/// What a foreign-key column points at. Both fields are schema identifiers
/// pulled from `information_schema` (same catalog-lookup trust level as
/// `allowed_tables`/`allowed_columns`), not user input.
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
    /// Additive metadata (`docs/client-enhancements.md` §6): omitted
    /// entirely for columns with no key role, so existing consumers of the
    /// `{name, type}` shape see no change.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<KeyKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references: Option<ColumnRef>,
    /// `COMMENT ON COLUMN` text, if any (`docs/client-enhancements.md` §7).
    /// Most columns in a typical schema won't have one — absent, not an
    /// error case.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

/// A table name plus its optional `COMMENT ON TABLE` text
/// (`docs/client-enhancements.md` §7). Kept separate from `allowed_tables()`
/// (plain `Vec<String>`), which stays the lean schema allow-list used for
/// request validation — this is the richer shape only `/tables` needs.
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
    /// Requested table (or sort/filter column) is not in the schema
    /// allow-list.
    NotAllowed(String),
    /// The `filter` param failed to parse (`filter-dsl.md` §4) — a plain-text
    /// reason, always mapped to 400, never partially executed.
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

/// The seam between the routes and the database. v1 ships exactly one
/// implementation (`PgPoolSource`); the boundary exists so other pool/driver
/// adapters can be added without touching handlers (`design.md` §5).
/// Native async-fn-in-trait — the router is generic, no `dyn`.
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
    /// Planner-statistics shortlist for a column (`docs/client-enhancements.md`
    /// §8): value + its estimated frequency, sourced from `pg_stats`. Never a
    /// `SELECT DISTINCT` scan — matches the "approximate over exact"
    /// philosophy `table_counts` already uses via `pg_class.reltuples`.
    fn common_values(
        &self,
        table: &str,
        column: &str,
    ) -> impl std::future::Future<Output = Result<Vec<(String, f32)>, DbError>> + Send;
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

    /// Schema-catalog lookup (not a data query, same family as
    /// `allowed_tables`/`allowed_columns`) for which columns of `table` are a
    /// primary key and which are a foreign key, and what the latter point
    /// at. `table` is already schema-validated by the caller before this
    /// runs, but it's bound as a parameter regardless.
    ///
    /// PK membership is exact even for a composite primary key (each member
    /// column is reported individually). FK *targets* are a different
    /// story: `information_schema.constraint_column_usage` carries no
    /// ordinal position, so joining it against `key_column_usage` for a
    /// composite FK (>1 referencing column) yields a cross product with no
    /// reliable way to pair referencing column N with referenced column N —
    /// see the grouping-by-`constraint_name` step below, which detects that
    /// case and drops it rather than risk mislabeling which column
    /// references what.
    async fn key_metadata(
        &self,
        table: &str,
    ) -> Result<(HashSet<String>, HashMap<String, ColumnRef>), DbError> {
        let rows = sqlx::query_as::<_, (String, String, String, Option<String>, Option<String>)>(
            "select tc.constraint_name, tc.constraint_type, kcu.column_name, \
                    ccu.table_name as ref_table, ccu.column_name as ref_column \
             from information_schema.table_constraints tc \
             join information_schema.key_column_usage kcu \
               on kcu.constraint_name = tc.constraint_name \
              and kcu.table_schema = tc.table_schema \
             left join information_schema.constraint_column_usage ccu \
               on ccu.constraint_name = tc.constraint_name \
              and ccu.table_schema = tc.table_schema \
              and tc.constraint_type = 'FOREIGN KEY' \
             where tc.table_schema = 'public' \
               and tc.table_name = $1 \
               and tc.constraint_type in ('PRIMARY KEY', 'FOREIGN KEY')",
        )
        .bind(table)
        .fetch_all(&self.pool)
        .await?;

        // (referencing column, referenced table, referenced column) — the
        // referenced table/column are `None` when the left join to
        // `constraint_column_usage` didn't match (i.e. this isn't an FK row).
        type FkCandidateRow = (String, Option<String>, Option<String>);

        let mut pk_columns = HashSet::new();
        // constraint_name -> its FkCandidateRow entries, collected so
        // composite FKs (multiple distinct column_names under one
        // constraint) can be detected and skipped below.
        let mut fk_candidates: HashMap<String, Vec<FkCandidateRow>> = HashMap::new();
        for (constraint_name, constraint_type, column_name, ref_table, ref_column) in rows {
            match constraint_type.as_str() {
                "PRIMARY KEY" => {
                    pk_columns.insert(column_name);
                }
                "FOREIGN KEY" => {
                    fk_candidates.entry(constraint_name).or_default().push((
                        column_name,
                        ref_table,
                        ref_column,
                    ));
                }
                _ => {}
            }
        }

        let mut fk_columns = HashMap::new();
        for members in fk_candidates.into_values() {
            let distinct_columns: HashSet<&str> =
                members.iter().map(|(name, _, _)| name.as_str()).collect();
            if distinct_columns.len() != 1 {
                continue; // composite FK — ambiguous pairing, see doc comment above.
            }
            if let Some((column_name, Some(ref_table), Some(ref_column))) =
                members.into_iter().next()
            {
                fk_columns.insert(
                    column_name,
                    ColumnRef {
                        table: ref_table,
                        column: ref_column,
                    },
                );
            }
        }
        Ok((pk_columns, fk_columns))
    }
}

/// Maps a parsed comparison operator to its hardcoded SQL fragment —
/// allow-list, never string-formatted from user input (`filter-dsl.md` §3
/// point 2).
fn compare_op_sql(op: CompareOp) -> &'static str {
    match op {
        CompareOp::Eq => "=",
        CompareOp::Ne => "!=",
        CompareOp::Gt => ">",
        CompareOp::Ge => ">=",
        CompareOp::Lt => "<",
        CompareOp::Le => "<=",
    }
}

/// Turns a syntactically-parsed [`ParsedFilter`] into a ` where ...` SQL
/// clause (empty string if there are no conditions) plus the ordered list of
/// values to bind for it, continuing the parameter numbering after `$1`
/// (limit) and `$2` (offset) — i.e. the first filter value is `$3`.
///
/// Every column is matched against `allowed_columns` (the same live
/// `information_schema` allow-list `sort` is checked against) before being
/// spliced in — this is the check that makes A8/A10 (`pg_sleep`, an unknown
/// column) fail with `DbError::NotAllowed` instead of ever reaching SQL
/// text, and it runs regardless of whether the condition is negated (`NOT`
/// never bypasses allow-listing).
///
/// Each condition's fragment is individually parenthesized and joined with
/// the literal `AND`/`OR` text from the input; Postgres's own operator
/// precedence (`AND` binds tighter than `OR`) then reproduces the grammar's
/// documented precedence without this builder needing to construct a
/// precedence-aware tree itself (`filter-dsl.md` §5 V6).
fn build_where_clause(
    filter: &ParsedFilter,
    column_names: &[String],
) -> Result<(String, Vec<String>), DbError> {
    if filter.conditions.is_empty() {
        return Ok((String::new(), Vec::new()));
    }

    let mut values = Vec::new();
    let mut next_param = 3;
    let mut fragments = Vec::with_capacity(filter.conditions.len());
    for condition in &filter.conditions {
        let column = column_names
            .iter()
            .find(|c| c.as_str() == condition.column)
            .ok_or_else(|| DbError::NotAllowed(format!("column {:?}", condition.column)))?;

        let inner = match &condition.predicate {
            Predicate::Compare(op, value) => {
                let frag = format!("\"{column}\"::text {} ${next_param}", compare_op_sql(*op));
                values.push(value.clone());
                next_param += 1;
                frag
            }
            Predicate::Like(value) => {
                let frag = format!("\"{column}\"::text LIKE ${next_param}");
                values.push(value.clone());
                next_param += 1;
                frag
            }
            Predicate::Ilike(value) => {
                let frag = format!("\"{column}\"::text ILIKE ${next_param}");
                values.push(value.clone());
                next_param += 1;
                frag
            }
            Predicate::IsNull => format!("\"{column}\"::text IS NULL"),
            Predicate::IsNotNull => format!("\"{column}\"::text IS NOT NULL"),
        };
        fragments.push(if condition.negated {
            format!("(NOT ({inner}))")
        } else {
            format!("({inner})")
        });
    }

    let mut clause = fragments[0].clone();
    for (logic, frag) in filter.logic.iter().zip(fragments.iter().skip(1)) {
        clause.push_str(match logic {
            Logic::And => " AND ",
            Logic::Or => " OR ",
        });
        clause.push_str(frag);
    }
    Ok((format!(" where {clause}"), values))
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
    async fn list_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        // Catalog-only read (`obj_description` against `pg_description`),
        // same cost class as the `pg_class.reltuples` count query below —
        // no table scan. `allowed_tables()` stays the lean `Vec<String>`
        // used for request validation; this is the richer `/tables` shape.
        let rows = sqlx::query_as::<_, (String, Option<String>)>(
            "select c.relname::text, obj_description(c.oid, 'pg_class') \
             from pg_class c \
             join pg_namespace n on n.oid = c.relnamespace \
             where n.nspname = 'public' and c.relkind = 'r' \
             order by c.relname",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(name, comment)| TableInfo { name, comment })
            .collect())
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

        // Filter columns are checked against the same live allow-list as
        // `sort` above — this is what makes splicing them into SQL text
        // safe (`filter-dsl.md` §3 point 1, §5 A8/A10). Operators are never
        // taken from user text: `compare_op_sql` is a hardcoded match over
        // the closed `CompareOp` enum the parser already produced.
        let (where_clause, filter_values) = match &opts.filter {
            Some(filter) => build_where_clause(filter, &column_names)?,
            None => (String::new(), Vec::new()),
        };

        let column_types = sqlx::query_as::<_, (String, String)>(
            "select column_name, data_type from information_schema.columns \
             where table_schema = 'public' and table_name = $1 \
             order by ordinal_position",
        )
        .bind(&table)
        .fetch_all(&self.pool)
        .await?;
        // Schema metadata, not query results — fine to fetch alongside the
        // column list above rather than as a separate route (`design.md`
        // §2's no-joins non-goal is about query execution, not this).
        let (pk_columns, fk_columns) = self.key_metadata(&table).await?;
        // `col_description` keyed by `pg_attribute.attnum`, not
        // `information_schema.ordinal_position` — the two can diverge once
        // a table has ever had a column dropped, so this joins through
        // `pg_attribute`/`pg_class` directly rather than trusting the
        // position from the query above. Catalog-only, same cost class as
        // `key_metadata` above.
        let column_comments: HashMap<String, String> =
            sqlx::query_as::<_, (String, Option<String>)>(
                "select a.attname::text, col_description(a.attrelid, a.attnum::int) \
             from pg_attribute a \
             join pg_class c on c.oid = a.attrelid \
             join pg_namespace n on n.oid = c.relnamespace \
             where n.nspname = 'public' and c.relname = $1 \
               and a.attnum > 0 and not a.attisdropped",
            )
            .bind(&table)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .filter_map(|(name, comment)| comment.map(|c| (name, c)))
            .collect();
        let columns: Vec<ColumnInfo> = column_types
            .into_iter()
            .map(|(name, type_name)| {
                // A column that's both a PK and FK member (composite key
                // doubling as a reference) reports as `pk` — the more
                // identifying fact of the two, and the shape here only
                // carries one `key` value per column.
                let (key, references) = if pk_columns.contains(&name) {
                    (Some(KeyKind::Pk), None)
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
        let sql = format!(
            "select {select_list} from \"{table}\"{where_clause}{order_clause} limit $1 offset $2"
        );

        let mut tx = self.pool.begin().await?;
        // Per-query timeout so a pathological query can't hold a host pool
        // connection indefinitely (`design.md` §4). LOCAL scopes it to this
        // transaction only.
        //
        // AssertSqlSafe audit: `timeout_secs` is a u32 from the host's own
        // config; `sql` interpolates only identifiers matched exactly against
        // the live information_schema above, plus the filter's operator
        // fragments built by `build_where_clause` (hardcoded per-operator SQL
        // text, never user text) — request strings never reach either
        // string, and all values (limit/offset/filter values) are bound.
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "set local statement_timeout = '{}s'",
            opts.timeout_secs
        )))
        .execute(&mut *tx)
        .await?;
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(opts.limit as i64)
            .bind(opts.offset as i64);
        for value in filter_values {
            query = query.bind(value);
        }
        let pg_rows = query.fetch_all(&mut *tx).await?;
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

        // `most_common_vals` is `anyarray` (planner stats can be over any
        // column type); `::text::text[]` is the standard idiom to read it
        // uniformly — cast to the array's text representation, then
        // reparse that as a `text[]` literal, rather than fighting
        // Rust-side type inference for `anyarray`. `most_common_freqs` is
        // already `real[]`, no cast needed. Both are NULL when `ANALYZE`
        // has never populated stats for this column; `unnest(NULL)` is an
        // empty set, so that case falls out as zero rows, not an error.
        let rows = sqlx::query_as::<_, (String, f32)>(
            "select t.val, t.freq \
             from pg_stats, \
                  lateral unnest(most_common_vals::text::text[], most_common_freqs) as t(val, freq) \
             where schemaname = 'public' and tablename = $1 and attname = $2 \
             order by t.freq desc",
        )
        .bind(&table)
        .bind(&column)
        .fetch_all(&self.pool)
        .await?;

        // The `::text::text[]` idiom above reads an array's *literal* text
        // form, which for `boolean` is Postgres's abbreviated array-input
        // syntax (`t`/`f`) rather than the scalar `true`/`false` that
        // `row_to_json` renders via a direct `col::text` cast elsewhere in
        // this file. Left alone, a value picked from this list wouldn't
        // match the same column's own grid rendering (and wouldn't match
        // `column::text = $n` once the filter DSL lands, since that also
        // casts the actual column, not an array literal). Verified this is
        // the one type in practice where the two text forms diverge — enum,
        // array, uuid, numeric, and timestamp columns all round-trip
        // identically through both paths.
        let data_type = sqlx::query_scalar::<_, String>(
            "select data_type from information_schema.columns \
             where table_schema = 'public' and table_name = $1 and column_name = $2",
        )
        .bind(&table)
        .bind(&column)
        .fetch_optional(&self.pool)
        .await?;
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
