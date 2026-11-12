use std::collections::HashMap;
use std::time::{Duration, Instant};

use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};

use super::{
    group_referenced_by, op_sql, quote_ident, ColumnInfo, ColumnPair, ColumnRef, ConstraintFk,
    ConstraintPk, ConstraintUnique, Constraints, DbError, DbSource, Engine, Ident, IndexInfo,
    KeyKind, NotAllowedKind, QueryOpts, ReferencedBy, SchemaListing, Structure, TableData,
    TableInfo,
};
use crate::filter::{Condition, FilterOp, Logic};
use crate::join::{
    self, order_by_clause, tie_break_keys, ColMeta, ColumnClass, Dialect, IlikeStyle, JoinData,
    JoinOpts, JoinSpec, TableMeta, UniqueKey,
};

/// Catalog/metadata queries need a fixed bounded timeout.
const CATALOG_TIMEOUT_SECS: u32 = 5;

/// SQLite's only schema for a single database file.
const ONLY_SCHEMA: &str = "main";

/// Rejects schema names this backend does not expose.
fn check_schema(schema: Option<&str>) -> Result<(), DbError> {
    match schema {
        None | Some(ONLY_SCHEMA) => Ok(()),
        Some(other) => Err(DbError::not_allowed(
            NotAllowedKind::Schema,
            format!("schema {other:?}"),
        )),
    }
}

/// SQLite backend; see `docs/adapter-decisions.md` for protocol differences.
#[derive(Clone)]
pub struct SqliteSource {
    pool: SqlitePool,
}

impl SqliteSource {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// SQLite progress handlers interrupt running queries; async timeouts only stop waiting.
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

    async fn allowed_tables(&self) -> Result<Vec<Ident>, DbError> {
        self.bounded(CATALOG_TIMEOUT_SECS, async |conn| {
            allowed_tables_on(conn).await
        })
        .await
    }

    /// `PRAGMA` takes no bound parameters, so the table name is quoted into the call.
    async fn allowed_columns(&self, table: &Ident) -> Result<Vec<String>, DbError> {
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
}

async fn allowed_tables_on(conn: &mut sqlx::SqliteConnection) -> Result<Vec<Ident>, DbError> {
    let names = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(
        "select name from sqlite_master \
         where type = 'table' and name not like 'sqlite\\_%' escape '\\' \
         order by name"
            .to_string(),
    ))
    .fetch_all(&mut *conn)
    .await?;
    Ok(names.into_iter().map(Ident::from_catalog).collect())
}

/// Composite FKs are dropped rather than risk mislabeling which referencing
/// column pairs with which referenced column.
async fn key_metadata_on(
    conn: &mut sqlx::SqliteConnection,
    table: &Ident,
) -> Result<(Vec<String>, HashMap<String, ColumnRef>), DbError> {
    let table = quote_ident(table);
    let pk_columns = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(format!(
        "select name from pragma_table_info({table}) where pk > 0 order by pk"
    )))
    .fetch_all(&mut *conn)
    .await?;

    // (id, seq, table, from, to) — `id` groups columns belonging to
    // the same constraint (composite FKs share an id). The quoted
    // "table"/"from"/"to" are pragma_foreign_key_list's own fixed
    // output column names (SQL keywords needing escape), not the
    // caller-supplied table.
    //
    // `REFERENCES parent` shorthand leaves `to` NULL; `ppk` resolves
    // it by position against the parent's PK, correlated per FK row
    // since each can reference a different parent — unlike
    // `referenced_by`'s single bound parent (docs/adapter-decisions.md §5.4.1).
    let fks =
        sqlx::query_as::<_, (i64, i64, String, String, String)>(sqlx::AssertSqlSafe(format!(
            "select fkl.id, fkl.seq, fkl.\"table\", fkl.\"from\", \
                    coalesce(fkl.\"to\", ppk.name, 'rowid') \
             from pragma_foreign_key_list({table}) fkl \
             left join pragma_table_info(fkl.\"table\") ppk on ppk.pk = fkl.seq + 1"
        )))
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
}

/// The text after a `CREATE INDEX` statement's top-level `WHERE`, ignoring
/// quoted text and parentheses. Only called for indexes flagged partial.
fn partial_index_predicate(sql: &str) -> Option<String> {
    let bytes = sql.as_bytes();
    let mut quote: Option<u8> = None;
    let mut depth = 0i32;
    for (i, &b) in bytes.iter().enumerate() {
        match quote {
            Some(q) => {
                if b == q {
                    quote = None;
                }
            }
            None => match b {
                b'\'' | b'"' | b'`' => quote = Some(b),
                b'[' => quote = Some(b']'),
                b'(' => depth += 1,
                b')' => depth -= 1,
                _ if depth == 0 && b.is_ascii_whitespace() => {
                    let rest = &sql[i + 1..];
                    let is_where = rest
                        .get(..5)
                        .is_some_and(|kw| kw.eq_ignore_ascii_case("where"))
                        && rest
                            .get(5..)
                            .and_then(|r| r.chars().next())
                            .is_some_and(|c| c.is_whitespace() || c == '(');
                    if is_where {
                        return Some(rest[5..].trim().to_string());
                    }
                }
                _ => {}
            },
        }
    }
    None
}

/// `spec/protocol.md` §5.11.2: recognised names first, then SQLite's own
/// affinity rules (`docs/adapter-decisions.md` §5.11).
fn column_class(declared: &str) -> ColumnClass {
    let upper = declared.trim().to_ascii_uppercase();
    if upper.is_empty() {
        return ColumnClass::Untyped;
    }
    let base = upper.split('(').next().unwrap_or("").trim();
    match base {
        "UUID" => return ColumnClass::Uuid,
        "BOOLEAN" | "BOOL" => return ColumnClass::Boolean,
        "DATE" | "DATETIME" => return ColumnClass::Temporal,
        "TIME" => return ColumnClass::Time,
        "JSON" | "JSONB" => return ColumnClass::Json,
        _ if base.starts_with("TIMESTAMP") => return ColumnClass::Temporal,
        _ => {}
    }
    if upper.contains("INT") {
        ColumnClass::Number
    } else if upper.contains("CHAR") || upper.contains("CLOB") || upper.contains("TEXT") {
        ColumnClass::Text
    } else if upper.contains("BLOB") {
        ColumnClass::Binary
    } else if upper.contains("REAL") || upper.contains("FLOA") || upper.contains("DOUB") {
        ColumnClass::Float
    } else {
        ColumnClass::Number
    }
}

fn cast_text(column: &str) -> String {
    format!("CAST({column} AS TEXT)")
}

const JOIN_DIALECT: Dialect = Dialect {
    quote: quote_ident,
    cast_text,
    numbered: false,
    ilike: IlikeStyle::Like,
};

async fn table_meta(
    conn: &mut sqlx::SqliteConnection,
    table: &Ident,
) -> Result<TableMeta, DbError> {
    let quoted = quote_ident(table);
    let columns = sqlx::query_as::<_, (i64, String, String)>(sqlx::AssertSqlSafe(format!(
        "select cid, name, type from pragma_table_info({quoted}) order by cid"
    )))
    .fetch_all(&mut *conn)
    .await?;
    let (pk_columns, fk_columns) = key_metadata_on(conn, table).await?;
    let unique_keys = unique_keys_on(conn, table, &pk_columns).await?;
    let columns: Vec<ColMeta> = columns
        .into_iter()
        .map(|(_, name, declared)| {
            let (key, references) = if pk_columns.contains(&name) {
                (Some(KeyKind::Pk), fk_columns.get(&name).cloned())
            } else if let Some(r) = fk_columns.get(&name) {
                (Some(KeyKind::Fk), Some(r.clone()))
            } else {
                (None, None)
            };
            ColMeta {
                class: column_class(&declared),
                collation: None,
                comment: None,
                key,
                references,
                type_name: if declared.is_empty() {
                    "unknown".to_string()
                } else {
                    declared
                },
                name: Ident::from_catalog(name),
            }
        })
        .collect();
    Ok(TableMeta {
        schema: None,
        name: table.clone(),
        order_keys: tie_break_keys(&columns, &unique_keys),
        columns,
    })
}

fn row_to_json<'a>(
    row: &SqliteRow,
    names: impl ExactSizeIterator<Item = &'a str>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut map = serde_json::Map::with_capacity(names.len());
    for (i, name) in names.enumerate() {
        let value = match row.try_get::<Option<String>, _>(i) {
            Ok(Some(text)) => serde_json::Value::String(text),
            Ok(None) => serde_json::Value::Null,
            Err(_) => serde_json::Value::String("<undecodable>".to_string()),
        };
        map.insert(name.to_string(), value);
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
    column_names: &[Ident],
) -> Result<(String, Vec<String>), DbError> {
    if conditions.is_empty() {
        return Ok((String::new(), Vec::new()));
    }

    let mut values = Vec::new();
    let mut clause = String::new();
    for (i, condition) in conditions.iter().enumerate() {
        let column = Ident::find_in(column_names, &condition.column, NotAllowedKind::Column)?;

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
    fn engine(&self) -> Engine {
        Engine::Sqlite
    }
    async fn list_schemas(&self) -> Result<SchemaListing, DbError> {
        Ok(SchemaListing::new(
            vec![ONLY_SCHEMA.to_string()],
            Some(ONLY_SCHEMA.to_string()),
        ))
    }

    async fn list_tables(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        check_schema(schema)?;
        let names = self.allowed_tables().await?;
        // No `obj_description` equivalent in SQLite — comments unsupported.
        Ok(names
            .into_iter()
            .map(|name| TableInfo {
                name: name.into_string(),
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
        Ok(tables
            .into_iter()
            .map(|table| (table.into_string(), -1i64))
            .collect())
    }

    async fn query_table(
        &self,
        schema: Option<&str>,
        table: &str,
        opts: QueryOpts,
    ) -> Result<TableData, DbError> {
        check_schema(schema)?;
        let tables = self.allowed_tables().await?;
        let table = Ident::find_in(&tables, table, NotAllowedKind::Table)?;

        // The join route's lookup, so both routes report the same columns; its
        // names are the live catalog's, so they also serve as the allow-list.
        let meta_table = table.clone();
        let meta = self
            .bounded(CATALOG_TIMEOUT_SECS, async move |conn| {
                table_meta(conn, &meta_table).await
            })
            .await?;
        let order_keys = meta.order_keys.clone();
        let column_names: Vec<Ident> = meta.columns.iter().map(|c| c.name.clone()).collect();
        let columns: Vec<ColumnInfo> = meta.columns.into_iter().map(ColumnInfo::from).collect();
        let sort = opts
            .sort
            .as_deref()
            .map(|requested| Ident::find_in(&column_names, requested, NotAllowedKind::Column))
            .transpose()?;

        let (where_clause, filter_values) = match &opts.filter {
            Some(filter) => build_where_clause(filter, &column_names)?,
            None => (String::new(), Vec::new()),
        };

        let select_list = column_names
            .iter()
            .map(|c| format!("CAST({} AS TEXT)", quote_ident(c)))
            .collect::<Vec<_>>()
            .join(", ");
        let sort_index = sort.and_then(|s| column_names.iter().position(|c| c == s));
        let order_clause = order_by_clause(sort_index, order_keys, opts.descending, |i| {
            format!("{}.{}", quote_ident(table), quote_ident(&column_names[i]))
        });
        let quoted_table = quote_ident(table);
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
                    .map(|r| row_to_json(r, columns.iter().map(|c| c.name.as_str())))
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

    async fn query_join(
        &self,
        schema: Option<&str>,
        spec: &JoinSpec,
        opts: JoinOpts,
    ) -> Result<JoinData, DbError> {
        check_schema(schema)?;
        let refs = spec.table_refs();
        join::table_schemas(&refs, &ONLY_SCHEMA, &[ONLY_SCHEMA])?;
        let names: Vec<&str> = refs.iter().map(|&(_, name)| name).collect();
        // Catalog lookups and the select share one connection and one
        // deadline (`spec/protocol.md` §5.11.5).
        self.bounded(opts.timeout_secs, async |conn| {
            let allowed = allowed_tables_on(conn).await?;
            let mut metas: HashMap<&str, TableMeta> = HashMap::new();
            for name in &names {
                if metas.contains_key(name) {
                    continue;
                }
                let table = Ident::find_in(&allowed, name, NotAllowedKind::Table)
                    .map_err(join::unknown_join_table)?;
                metas.insert(name, table_meta(conn, table).await?);
            }
            let tables = names.iter().map(|n| metas[n].clone()).collect();
            let plan = join::plan(spec, tables, &opts)?;
            let (body, values) = join::build_select(&plan, &JOIN_DIALECT);

            // AssertSqlSafe: the statement is built from catalog names and
            // generated aliases only; all values are bound.
            let mut query = sqlx::query(sqlx::AssertSqlSafe(format!("select {body}")));
            for value in &values {
                query = query.bind(value);
            }
            query = query.bind(opts.limit as i64 + 1).bind(opts.offset as i64);
            let mut sqlite_rows = query.fetch_all(&mut *conn).await?;

            let has_more = sqlite_rows.len() > opts.limit as usize;
            sqlite_rows.truncate(opts.limit as usize);
            Ok(JoinData {
                columns: plan.columns(Some(ONLY_SCHEMA)),
                rows: sqlite_rows
                    .iter()
                    .map(|r| row_to_json(r, plan.labels().iter().map(String::as_str)))
                    .collect(),
                has_more,
            })
        })
        .await
    }

    async fn common_values(
        &self,
        schema: Option<&str>,
        table: &str,
        column: &str,
    ) -> Result<Vec<(String, f32)>, DbError> {
        check_schema(schema)?;
        let tables = self.allowed_tables().await?;
        let table = Ident::find_in(&tables, table, NotAllowedKind::Table)?;
        let columns = self.allowed_columns(table).await?;
        columns
            .iter()
            .find(|c| c.as_str() == column)
            .ok_or_else(|| {
                DbError::not_allowed(NotAllowedKind::Column, format!("column {column:?}"))
            })?;

        // No pg_stats equivalent to read; an empty list is the documented
        // "no statistics available" answer (spec/protocol.md §5.5), not a
        // live GROUP BY scan. See docs/adapter-decisions.md.
        Ok(Vec::new())
    }

    async fn referenced_by(
        &self,
        schema: Option<&str>,
        table: &str,
    ) -> Result<Vec<ReferencedBy>, DbError> {
        check_schema(schema)?;
        let allowed = self.allowed_tables().await?;
        if !allowed.iter().any(|t| t.as_str() == table) {
            return Err(DbError::not_allowed(
                NotAllowedKind::Table,
                format!("table {table:?}"),
            ));
        }
        let table = table.to_string();

        // No reverse-FK index and no `information_schema`: walk every
        // table's `pragma_foreign_key_list` (the schema is already parsed
        // in memory). The TVF argument is a column reference — not spliced;
        // `fkl."table"` is bound. `COLLATE NOCASE` because the pragma
        // returns the referenced name as written in the DDL, which SQLite
        // itself resolves case-insensitively.
        //
        // `REFERENCES parent` with no parenthesised column list is valid
        // DDL meaning "parent's own primary key", and for that form the
        // pragma reports `to` as NULL rather than filling in the PK name.
        // `ppk` resolves it: `pragma_table_info(table)`'s `pk` column is the
        // 1-indexed position of a column within the parent's primary key,
        // matching `fkl.seq`'s 0-indexed position within the FK's column
        // list — SQLite requires an omitted column list to align
        // position-for-position with the parent PK, so this pairing holds
        // for composite keys too. The `'rowid'` fallback covers a parent
        // with no declared primary key, where SQLite's parent key is the
        // implicit rowid.
        let rows = self
            .bounded(CATALOG_TIMEOUT_SECS, async move |conn| {
                let rows = sqlx::query_as::<_, (String, i64, String, String)>(sqlx::AssertSqlSafe(
                    "select m.name, fkl.id, fkl.\"from\", \
                            coalesce(fkl.\"to\", ppk.name, 'rowid') \
                     from sqlite_master m \
                     join pragma_foreign_key_list(m.name) fkl \
                     left join pragma_table_info(?) ppk on ppk.pk = fkl.seq + 1 \
                     where m.type = 'table' \
                       and m.name not like 'sqlite\\_%' escape '\\' \
                       and fkl.\"table\" = ? collate nocase \
                     order by m.name, fkl.id, fkl.seq"
                        .to_string(),
                ))
                .bind(&table)
                .bind(&table)
                .fetch_all(&mut *conn)
                .await?;
                Ok(rows)
            })
            .await?;

        // SQLite FKs are unnamed; `fk_<id>` is a per-table-stable synthetic
        // label (`spec/protocol.md` §5.9 permits this). The query's
        // `sqlite_master` predicate matches `allowed_tables`, so every
        // referrer is already allow-listed.
        Ok(group_referenced_by(rows.into_iter().map(
            |(ref_table, fk_id, from, to)| ReferencedBy {
                table: ref_table,
                schema: None,
                constraint: format!("fk_{fk_id}"),
                columns: vec![ColumnPair { from, to }],
            },
        )))
    }

    async fn structure(&self, schema: Option<&str>, table: &str) -> Result<Structure, DbError> {
        check_schema(schema)?;
        let allowed = self.allowed_tables().await?;
        let table = Ident::find_in(&allowed, table, NotAllowedKind::Table)?;
        // PRAGMA table-valued functions take the table as a column-reference argument, so it is quoted, not bound.
        let quoted = quote_ident(table);
        let table = table.as_str().to_string();

        self.bounded(CATALOG_TIMEOUT_SECS, async move |conn| {
            // `key = 1` drops the trailing rowid/auxiliary entries. An
            // expression key part has a NULL `name` and no recoverable text.
            let index_rows = sqlx::query_as::<_, (String, i64, String, i64, Option<String>)>(
                sqlx::AssertSqlSafe(format!(
                    "select il.name, il.\"unique\", il.origin, il.partial, ix.name \
                     from pragma_index_list({quoted}) il \
                     join pragma_index_xinfo(il.name) ix \
                     where ix.key = 1 \
                     order by il.name, ix.seqno"
                )),
            )
            .fetch_all(&mut *conn)
            .await?;

            let sql_rows = sqlx::query_as::<_, (String, Option<String>)>(sqlx::AssertSqlSafe(
                "select name, sql from sqlite_master where type = 'index' and tbl_name = ?"
                    .to_string(),
            ))
            .bind(&table)
            .fetch_all(&mut *conn)
            .await?;
            let sql_of: HashMap<String, String> = sql_rows
                .into_iter()
                .filter_map(|(name, sql)| sql.map(|s| (name, s)))
                .collect();

            let mut indexes: Vec<IndexInfo> = Vec::new();
            let mut unique_origin: Vec<String> = Vec::new();
            for (name, unique, origin, partial, column) in index_rows {
                let column = column.unwrap_or_else(|| "<expression>".to_string());
                match indexes.last_mut() {
                    Some(last) if last.name == name => last.columns.push(column),
                    _ => {
                        if origin == "u" {
                            unique_origin.push(name.clone());
                        }
                        let predicate = if partial != 0 {
                            sql_of
                                .get(&name)
                                .and_then(|sql| partial_index_predicate(sql))
                        } else {
                            None
                        };
                        indexes.push(IndexInfo {
                            name,
                            columns: vec![column],
                            unique: unique != 0,
                            method: "btree".to_string(),
                            predicate,
                        });
                    }
                }
            }

            let unique = unique_origin
                .into_iter()
                .filter_map(|name| {
                    let columns = indexes.iter().find(|i| i.name == name)?.columns.clone();
                    Some(ConstraintUnique { name, columns })
                })
                .collect();

            let pk_columns = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(format!(
                "select name from pragma_table_info({quoted}) where pk > 0 order by pk"
            )))
            .fetch_all(&mut *conn)
            .await?;
            let primary_key = (!pk_columns.is_empty()).then_some(ConstraintPk {
                name: None,
                columns: pk_columns,
            });

            // `to` is NULL for `REFERENCES parent` shorthand; `ppk` resolves
            // it from the parent's primary key (`docs/adapter-decisions.md`
            // §5.4.1).
            let fk_rows = sqlx::query_as::<_, (i64, String, String, String, String, String)>(
                sqlx::AssertSqlSafe(format!(
                    "select fkl.id, fkl.\"table\", fkl.\"from\", \
                            coalesce(fkl.\"to\", ppk.name, 'rowid'), \
                            fkl.on_delete, fkl.on_update \
                     from pragma_foreign_key_list({quoted}) fkl \
                     left join pragma_table_info(fkl.\"table\") ppk on ppk.pk = fkl.seq + 1 \
                     order by fkl.id, fkl.seq"
                )),
            )
            .fetch_all(&mut *conn)
            .await?;
            let mut foreign_keys: Vec<ConstraintFk> = Vec::new();
            let mut last_id: Option<i64> = None;
            for (id, ref_table, from, to, on_delete, on_update) in fk_rows {
                match foreign_keys.last_mut() {
                    Some(last) if last_id == Some(id) => last.columns.push(ColumnPair { from, to }),
                    _ => foreign_keys.push(ConstraintFk {
                        name: format!("fk_{id}"),
                        table: ref_table,
                        schema: None,
                        columns: vec![ColumnPair { from, to }],
                        on_delete: on_delete.to_ascii_uppercase(),
                        on_update: on_update.to_ascii_uppercase(),
                    }),
                }
                last_id = Some(id);
            }

            Ok(Structure {
                indexes,
                constraints: Constraints {
                    primary_key,
                    unique,
                    foreign_keys,
                    check: Vec::new(),
                },
            })
        })
        .await
    }
}

/// The primary key (an INTEGER PRIMARY KEY has no index row), and every
/// unique, non-partial index whose key columns are all NOT NULL table
/// columns. An expression key part has no `pragma_table_info` row.
async fn unique_keys_on(
    conn: &mut sqlx::SqliteConnection,
    table: &Ident,
    pk_in_key_order: &[String],
) -> Result<Vec<UniqueKey>, DbError> {
    let table = quote_ident(table);
    let rows =
        sqlx::query_as::<_, (String, Option<String>, Option<i64>)>(sqlx::AssertSqlSafe(format!(
            "select il.name, ti.name, ti.\"notnull\" \
             from pragma_index_list({table}) il \
             join pragma_index_xinfo(il.name) ii \
             left join pragma_table_info({table}) ti on ti.cid = ii.cid \
             where il.\"unique\" = 1 and il.partial = 0 and il.origin <> 'pk' and ii.key = 1 \
             order by il.name, ii.seqno"
        )))
        .fetch_all(&mut *conn)
        .await?;
    let mut keys = Vec::new();
    if !pk_in_key_order.is_empty() {
        keys.push(UniqueKey {
            name: String::new(),
            primary: true,
            columns: pk_in_key_order.to_vec(),
        });
    }
    let mut current: Option<(UniqueKey, bool)> = None;
    for (index, column, not_null) in rows {
        if current.as_ref().is_none_or(|(k, _)| k.name != index) {
            keys.extend(current.take().filter(|(_, u)| *u).map(|(k, _)| k));
            current = Some((
                UniqueKey {
                    name: index,
                    primary: false,
                    columns: Vec::new(),
                },
                true,
            ));
        }
        let (key, usable) = current.as_mut().expect("set above");
        match column {
            Some(c) if not_null == Some(1) => key.columns.push(c),
            _ => *usable = false,
        }
    }
    keys.extend(current.filter(|(_, u)| *u).map(|(k, _)| k));
    Ok(keys)
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
                approved_by integer references users(id), \
                status text not null\
             );\
             create table order_extra (\
                order_id integer primary key references orders(id), \
                gift_message text\
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
        sqlx::query(sqlx::AssertSqlSafe(
            "insert into order_extra (order_id, gift_message) values (1, 'enjoy!')".to_string(),
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
        assert_eq!(names, vec!["order_extra", "orders", "users"]);
        assert!(tables.iter().all(|t| t.comment.is_none()));

        let listing = source.list_schemas().await.unwrap();
        assert_eq!(listing.schemas, vec!["main"]);
        assert_eq!(listing.default.as_deref(), Some("main"));
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

    #[test]
    fn partial_index_predicate_finds_the_top_level_where_only() {
        let p = partial_index_predicate;
        assert_eq!(
            p("CREATE INDEX i ON t(a) WHERE status = 'open'").as_deref(),
            Some("status = 'open'")
        );
        assert_eq!(
            p("CREATE INDEX i ON t(a)\nwhere\n  b > 1").as_deref(),
            Some("b > 1")
        );
        assert_eq!(
            p("CREATE INDEX i ON t(a) WHERE note = ' where '").as_deref(),
            Some("note = ' where '")
        );
        assert_eq!(p("CREATE INDEX i ON t(a || ' where ')"), None);
        assert_eq!(p("CREATE INDEX i ON t(lower(a) )"), None);
    }

    #[tokio::test]
    async fn structure_reports_indexes_partial_predicate_unique_and_fk_actions() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(
            "create table users (id integer primary key, email text unique); \
             create table orders (\
                id integer primary key, \
                user_id integer not null references users(id) on delete cascade, \
                kind text, \
                status text\
             ); \
             create index orders_kind_status_idx on orders(kind, status); \
             create index orders_open_idx on orders(user_id) where status = 'open';"
                .to_string(),
        ))
        .execute(&pool)
        .await
        .unwrap();
        let source = SqliteSource::new(pool);

        let s = source.structure(None, "orders").await.unwrap();
        let idx = |name: &str| s.indexes.iter().find(|i| i.name == name).unwrap();
        assert_eq!(idx("orders_kind_status_idx").columns, ["kind", "status"]);
        assert_eq!(
            idx("orders_open_idx").predicate.as_deref(),
            Some("status = 'open'")
        );
        assert!(idx("orders_kind_status_idx").predicate.is_none());
        assert_eq!(s.constraints.primary_key.as_ref().unwrap().columns, ["id"]);
        let fk = &s.constraints.foreign_keys[0];
        assert_eq!(fk.table, "users");
        assert_eq!(
            fk.columns[0].to, "id",
            "shorthand REFERENCES resolves the parent PK"
        );
        assert_eq!(
            (fk.on_delete.as_str(), fk.on_update.as_str()),
            ("CASCADE", "NO ACTION")
        );
        assert!(s.constraints.check.is_empty());

        let users = source.structure(None, "users").await.unwrap();
        assert_eq!(users.constraints.unique[0].columns, ["email"]);
        assert!(users
            .indexes
            .iter()
            .any(|i| i.unique && i.columns == ["email"]));

        assert!(matches!(
            source.structure(None, "nope").await,
            Err(DbError::NotAllowed(_))
        ));
        assert!(matches!(
            source.structure(Some("other"), "users").await,
            Err(DbError::NotAllowed(_))
        ));
    }

    #[tokio::test]
    async fn referenced_by_lists_incoming_fks() {
        let source = SqliteSource::new(seeded_pool().await);

        let refs = source.referenced_by(None, "users").await.unwrap();
        // orders references users via two FKs (user_id, approved_by).
        let orders: Vec<&ReferencedBy> = refs.iter().filter(|r| r.table == "orders").collect();
        assert_eq!(orders.len(), 2, "one entry per FK constraint");
        assert!(orders.iter().all(|r| r.schema.is_none()));
        assert!(orders.iter().all(|r| r.constraint.starts_with("fk_")));
        assert!(orders
            .iter()
            .all(|r| r.columns.len() == 1 && r.columns[0].to == "id"));
        let from: Vec<&str> = orders.iter().map(|r| r.columns[0].from.as_str()).collect();
        assert!(from.contains(&"user_id") && from.contains(&"approved_by"));

        // A table nothing points at is `[]`, not an error.
        assert!(source
            .referenced_by(None, "order_extra")
            .await
            .unwrap()
            .is_empty());

        // Unknown table → NotAllowed.
        assert!(matches!(
            source.referenced_by(None, "nope").await,
            Err(DbError::NotAllowed(_))
        ));
    }

    // Regression tests: `REFERENCES parent` with no named parent column is
    // valid SQLite DDL meaning "the parent's primary key", but
    // `pragma_foreign_key_list` reports `to` as NULL for that form rather
    // than filling in the PK name —
    // the query must resolve it itself, not assume `to` is always present.

    #[tokio::test]
    async fn referenced_by_resolves_shorthand_fk_with_no_named_parent_column() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(
            "create table users (id integer primary key, email text not null); \
             create table pets (id integer primary key, owner_id integer references users);"
                .to_string(),
        ))
        .execute(&pool)
        .await
        .unwrap();

        let source = SqliteSource::new(pool);
        let refs = source.referenced_by(None, "users").await.unwrap();

        let pets = refs
            .iter()
            .find(|r| r.table == "pets")
            .expect("pets' FK to users must be reported");
        assert_eq!(pets.columns.len(), 1);
        assert_eq!(pets.columns[0].from, "owner_id");
        assert_eq!(
            pets.columns[0].to, "id",
            "an unnamed parent column must resolve to users' primary key, not NULL/empty"
        );
    }

    #[tokio::test]
    async fn query_table_reports_each_columns_column_class() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(
            "create table t (id integer primary key, label text, meta json, loose);".to_string(),
        ))
        .execute(&pool)
        .await
        .unwrap();
        let source = SqliteSource::new(pool);
        let data = source
            .query_table(
                None,
                "t",
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
        let classes: Vec<_> = data.columns.iter().map(|c| c.class.clone()).collect();
        assert_eq!(
            classes,
            [
                ColumnClass::Number,
                ColumnClass::Text,
                ColumnClass::Json,
                ColumnClass::Untyped
            ]
        );
        let wire = serde_json::to_value(&data.columns).unwrap();
        assert_eq!(wire[0]["class"], "number");
        assert_eq!(wire[2]["class"], "json");
        assert_eq!(wire[3]["type"], "unknown");
    }

    // Same shorthand-FK bug, forward direction: `key_metadata_on` (which
    // supplies `query_table`'s per-column `references`) shares
    // `referenced_by`'s pre-fix bug — `pragma_foreign_key_list.to` is NULL
    // for `REFERENCES parent` with no named column, and until fixed
    // `key_metadata` doesn't resolve it the way `referenced_by` now does.
    #[tokio::test]
    async fn query_table_resolves_shorthand_fk_with_no_named_parent_column() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(
            "create table users (id integer primary key, email text not null); \
             create table pets (id integer primary key, owner_id integer references users);"
                .to_string(),
        ))
        .execute(&pool)
        .await
        .unwrap();

        let source = SqliteSource::new(pool);
        let data = source
            .query_table(
                None,
                "pets",
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

        let owner_id_col = data.columns.iter().find(|c| c.name == "owner_id").unwrap();
        assert_eq!(owner_id_col.key, Some(KeyKind::Fk));
        let refs = owner_id_col
            .references
            .as_ref()
            .expect("owner_id must report a references entry");
        assert_eq!(refs.table, "users");
        assert_eq!(
            refs.column, "id",
            "an unnamed parent column must resolve to users' primary key, not NULL/empty"
        );
    }

    #[tokio::test]
    async fn referenced_by_resolves_shorthand_fk_against_a_composite_primary_key() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(
            "create table warehouse_bins ( \
                warehouse_code text not null, \
                bin_code text not null, \
                primary key (warehouse_code, bin_code) \
             ); \
             create table bin_counts ( \
                id integer primary key, \
                warehouse_code text not null, \
                bin_code text not null, \
                qty integer not null, \
                foreign key (warehouse_code, bin_code) references warehouse_bins \
             );"
            .to_string(),
        ))
        .execute(&pool)
        .await
        .unwrap();

        let source = SqliteSource::new(pool);
        let refs = source.referenced_by(None, "warehouse_bins").await.unwrap();

        let bin_counts = refs
            .iter()
            .find(|r| r.table == "bin_counts")
            .expect("bin_counts' composite FK must be reported");
        assert_eq!(
            bin_counts.columns.len(),
            2,
            "a composite FK must resolve every parent PK column, not just the first"
        );
        let pairs: Vec<(&str, &str)> = bin_counts
            .columns
            .iter()
            .map(|c| (c.from.as_str(), c.to.as_str()))
            .collect();
        assert!(pairs.contains(&("warehouse_code", "warehouse_code")));
        assert!(pairs.contains(&("bin_code", "bin_code")));
    }

    #[tokio::test]
    async fn pk_and_fk_column_reports_both() {
        let source = SqliteSource::new(seeded_pool().await);
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
    }

    #[tokio::test]
    async fn table_counts_reports_no_estimate_sentinel() {
        let source = SqliteSource::new(seeded_pool().await);
        let counts = source.table_counts(None).await.unwrap();
        // No reltuples-equivalent catalog on SQLite; always -1
        // (spec/protocol.md §5.3), not a per-table COUNT(*).
        assert_eq!(
            counts,
            vec![
                ("order_extra".to_string(), -1),
                ("orders".to_string(), -1),
                ("users".to_string(), -1)
            ]
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
        assert!(
            matches!(err, Err(DbError::QueryTimeout)),
            "expected the interrupt to surface as QueryTimeout, got {err:?}"
        );

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

    fn join_opts() -> JoinOpts {
        JoinOpts {
            limit: 10,
            offset: 0,
            sort: None,
            sort_join: None,
            descending: false,
            timeout_secs: 5,
            filter: None,
        }
    }

    fn spec(raw: &str) -> JoinSpec {
        JoinSpec::parse(raw).unwrap()
    }

    const USERS_ORDERS: &str = r#"{"table":"users","joins":[{"type":"TYPE","table":"orders",
        "on":[{"left":{"join":0,"column":"id"},"right":"user_id"}]}]}"#;

    #[tokio::test]
    async fn left_join_keeps_unmatched_rows_and_inner_drops_them() {
        let source = SqliteSource::new(seeded_pool().await);
        let left = source
            .query_join(
                None,
                &spec(&USERS_ORDERS.replace("TYPE", "left")),
                join_opts(),
            )
            .await
            .unwrap();
        assert_eq!(left.rows.len(), 3);
        assert!(!left.has_more);
        let status = &left
            .columns
            .iter()
            .find(|c| c.column == "status")
            .unwrap()
            .name;
        let unmatched = left.rows.iter().filter(|r| r[status].is_null()).count();
        assert_eq!(unmatched, 2);

        let inner = source
            .query_join(
                None,
                &spec(&USERS_ORDERS.replace("TYPE", "inner")),
                join_opts(),
            )
            .await
            .unwrap();
        assert_eq!(inner.rows.len(), 1);
    }

    #[tokio::test]
    async fn self_join_has_more_and_distinct_labels() {
        let source = SqliteSource::new(seeded_pool().await);
        let self_join = spec(
            r#"{"table":"users","joins":[{"type":"inner","table":"users",
                "on":[{"left":{"join":0,"column":"age"},"right":"age"}]}],
                "columns":[{"join":0,"column":"id"},{"join":1,"column":"id"}]}"#,
        );
        let mut opts = join_opts();
        opts.limit = 2;
        let page = source.query_join(None, &self_join, opts).await.unwrap();
        assert_eq!(page.rows.len(), 2);
        assert!(page.has_more, "5 pairs exist, 2 returned");
        let labels: Vec<_> = page.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(labels, ["id_0", "id_1"]);
        assert!(page.rows[0].contains_key("id_0") && page.rows[0].contains_key("id_1"));
    }

    #[tokio::test]
    async fn three_tables_filter_and_sort_on_joined_columns() {
        let source = SqliteSource::new(seeded_pool().await);
        let three = spec(
            r#"{"table":"orders","joins":[
                {"type":"left","table":"users","on":[{"left":{"join":0,"column":"user_id"},"right":"id"}]},
                {"type":"left","table":"order_extra","on":[{"left":{"join":0,"column":"id"},"right":"order_id"}]}],
                "columns":[{"join":0,"column":"id"},{"join":1,"column":"email"},{"join":2,"column":"gift_message"}]}"#,
        );
        let mut opts = join_opts();
        opts.filter = Some(vec![crate::filter::Condition {
            logic: None,
            not: false,
            column: "email".into(),
            op: crate::filter::FilterOp::Like,
            value: Some("a@%".into()),
            join: Some(1),
        }]);
        opts.sort = Some("email".into());
        opts.sort_join = Some(1);
        let data = source.query_join(None, &three, opts).await.unwrap();
        assert_eq!(data.rows.len(), 1);
        assert_eq!(data.rows[0]["gift_message"], "enjoy!");
    }

    #[tokio::test]
    async fn rejects_hostile_names_and_incompatible_pairs() {
        let source = SqliteSource::new(seeded_pool().await);
        let hostile = spec(
            r#"{"table":"users\"; drop table users; --","joins":[{"type":"left","table":"orders",
                "on":[{"left":{"join":0,"column":"id"},"right":"user_id"}]}]}"#,
        );
        assert!(matches!(
            source.query_join(None, &hostile, join_opts()).await,
            Err(DbError::BadJoin(_))
        ));
        let mismatch = spec(
            r#"{"table":"users","joins":[{"type":"left","table":"orders",
                "on":[{"left":{"join":0,"column":"email"},"right":"user_id"}]}]}"#,
        );
        assert!(matches!(
            source.query_join(None, &mismatch, join_opts()).await,
            Err(DbError::BadJoin(_))
        ));
        assert!(matches!(
            source
                .query_join(
                    Some("other"),
                    &spec(&USERS_ORDERS.replace("TYPE", "left")),
                    join_opts()
                )
                .await,
            Err(DbError::NotAllowed(_))
        ));
    }

    #[test]
    fn column_classes_follow_declared_names_then_affinity() {
        use ColumnClass::*;
        for (declared, expected) in [
            ("INTEGER", Number),
            ("bigint", Number),
            ("DECIMAL(10,2)", Number),
            ("VARCHAR(20)", Text),
            ("TEXT", Text),
            ("BLOB", Binary),
            ("REAL", Float),
            ("DOUBLE PRECISION", Float),
            ("UUID", Uuid),
            ("BOOLEAN", Boolean),
            ("DATETIME", Temporal),
            ("TIMESTAMP(6)", Temporal),
            ("TIME", Time),
            ("JSON", Json),
            ("", Untyped),
        ] {
            assert_eq!(column_class(declared), expected, "{declared:?}");
        }
    }
}
