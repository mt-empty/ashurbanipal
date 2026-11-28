//! `GET /api/tables/join` (`spec/protocol.md` §5.11): request parsing,
//! catalog-driven validation, and the SQL text every backend shares.
//!
//! The client sends a structure, never SQL. A backend fills [`TableMeta`]
//! from its live catalog, [`plan`] resolves every name against it, and
//! [`build_select`] emits SQL from catalog names and generated aliases only.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::db::{ColumnInfo, ColumnRef, DbError, Ident, KeyKind, NotAllowedKind};
use crate::filter::{
    check_path, check_value_shape, Condition, FilterOp, FilterValue, Logic, PathStep, ValueForm,
};

pub const MAX_JOIN_BYTES: usize = 8192;
pub const MAX_TABLES: usize = 4;
pub const MAX_PAIRS: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JoinType {
    Inner,
    Left,
}

impl JoinType {
    fn sql(self) -> &'static str {
        match self {
            Self::Inner => "inner join",
            Self::Left => "left join",
        }
    }
}

/// An optional field that, when present, must be a string: `null` is a
/// wrong type (§5.11.1), not an absent value.
fn present_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    String::deserialize(d).map(Some)
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ColumnPos {
    pub join: usize,
    pub column: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OnPair {
    pub left: ColumnPos,
    pub right: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JoinEntry {
    #[serde(rename = "type")]
    pub kind: JoinType,
    pub table: String,
    #[serde(default, deserialize_with = "present_string")]
    pub schema: Option<String>,
    pub on: Vec<OnPair>,
}

/// The decoded `join` parameter. Positions: `0` is `table`, `1..` the
/// entries of `joins` in order.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JoinSpec {
    pub table: String,
    #[serde(default, deserialize_with = "present_string")]
    pub schema: Option<String>,
    pub joins: Vec<JoinEntry>,
    #[serde(default)]
    pub columns: Option<Vec<ColumnPos>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinError(pub String);

impl std::fmt::Display for JoinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for JoinError {}

fn err(message: impl Into<String>) -> JoinError {
    JoinError(message.into())
}

impl JoinSpec {
    /// Structural validation only; names and types are checked by [`plan`]
    /// against the catalog.
    pub fn parse(raw: &str) -> Result<JoinSpec, JoinError> {
        if raw.len() > MAX_JOIN_BYTES {
            return Err(err(format!(
                "join too long: {} bytes (max {MAX_JOIN_BYTES})",
                raw.len()
            )));
        }
        let spec: JoinSpec = serde_json::from_str(raw).map_err(|e| {
            err(format!(
                "join must be a JSON object of the documented shape: {e}"
            ))
        })?;
        if spec.joins.is_empty() {
            return Err(err("join needs at least one entry in joins"));
        }
        if spec.joins.len() + 1 > MAX_TABLES {
            return Err(err(format!(
                "too many tables: {} (max {MAX_TABLES})",
                spec.joins.len() + 1
            )));
        }
        for (i, entry) in spec.joins.iter().enumerate() {
            let position = i + 1;
            if entry.on.is_empty() || entry.on.len() > MAX_PAIRS {
                return Err(err(format!(
                    "join {position}: on needs 1 to {MAX_PAIRS} pairs, got {}",
                    entry.on.len()
                )));
            }
            for pair in &entry.on {
                if pair.left.join >= position {
                    return Err(err(format!(
                        "join {position}: on.left refers to position {}, which is not an earlier table",
                        pair.left.join
                    )));
                }
            }
        }
        if let Some(columns) = &spec.columns {
            if columns.is_empty() {
                return Err(err("columns must not be empty when present"));
            }
            let mut seen = HashSet::new();
            for c in columns {
                if !seen.insert((c.join, c.column.as_str())) {
                    return Err(err(format!(
                        "columns lists ({}, {:?}) twice",
                        c.join, c.column
                    )));
                }
            }
        }
        Ok(spec)
    }

    /// `(own schema, table)` by position; `None` means the request's schema.
    pub fn table_refs(&self) -> Vec<(Option<&str>, &str)> {
        std::iter::once((self.schema.as_deref(), self.table.as_str()))
            .chain(
                self.joins
                    .iter()
                    .map(|j| (j.schema.as_deref(), j.table.as_str())),
            )
            .collect()
    }
}

/// Engine-neutral class of a column type (`spec/protocol.md` §5.4.1,
/// §5.11.2). Each backend maps its native types onto these; `Float`, `Json`,
/// `Array` and `Other` cannot be joined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ColumnClass {
    Number,
    Text,
    Uuid,
    Boolean,
    Temporal,
    Time,
    Binary,
    /// Joinable only to an equal value: the enumerated type's identity.
    Enum(String),
    /// A SQLite column with no declared type; pairs only with itself.
    Untyped,
    /// Floating point: not compared exactly.
    Float,
    Json,
    Array,
    /// Any type not named above.
    Other,
}

impl ColumnClass {
    /// The class name on the wire (`spec/protocol.md` §5.4.1); an enum's
    /// identity travels separately as `enum_type`.
    fn wire_name(&self) -> &'static str {
        match self {
            ColumnClass::Number => "number",
            ColumnClass::Text => "text",
            ColumnClass::Uuid => "uuid",
            ColumnClass::Boolean => "boolean",
            ColumnClass::Temporal => "temporal",
            ColumnClass::Time => "time",
            ColumnClass::Binary => "binary",
            ColumnClass::Enum(_) => "enum",
            ColumnClass::Untyped => "untyped",
            ColumnClass::Float => "float",
            ColumnClass::Json => "json",
            ColumnClass::Array => "array",
            ColumnClass::Other => "other",
        }
    }

    /// The collation to send: only a text column's can clash in a comparison.
    pub fn wire_collation(&self, collation: Option<&String>) -> Option<String> {
        collation.filter(|_| *self == ColumnClass::Text).cloned()
    }

    fn is_joinable(&self) -> bool {
        !matches!(
            self,
            ColumnClass::Float | ColumnClass::Json | ColumnClass::Array | ColumnClass::Other
        )
    }

    /// The enumerated type's identity, which two enum columns must share to join.
    pub fn enum_type(&self) -> Option<String> {
        match self {
            ColumnClass::Enum(id) => Some(id.clone()),
            _ => None,
        }
    }

    /// The class of a typed column, read from its value form so a backend's
    /// class and typed comparison can't disagree.
    pub(crate) fn of_form(form: ValueForm) -> Self {
        match form {
            ValueForm::MysqlDecimal | ValueForm::PgNumeric => ColumnClass::Number,
            ValueForm::MysqlFloat | ValueForm::PgFloat => ColumnClass::Float,
            ValueForm::MysqlDate
            | ValueForm::MysqlDatetime
            | ValueForm::PgDate
            | ValueForm::PgTimestamp
            | ValueForm::PgTimestampTz => ColumnClass::Temporal,
            ValueForm::MysqlTime | ValueForm::PgTime | ValueForm::PgTimeTz => ColumnClass::Time,
        }
    }
}

impl Serialize for ColumnClass {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.wire_name())
    }
}

/// How a filter compares a column in its own type (`spec/protocol.md`
/// §5.4.2): the form a value must have, and the engine's cast target for the
/// bound value, from a hardcoded per-engine table (`None` binds it bare).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TypedCompare {
    /// `None` skips the value check: SQLite does not enforce column types.
    pub form: Option<ValueForm>,
    pub cast: Option<&'static str>,
    /// The target for a whole number that fits 64 bits, so an integer
    /// column keeps its index (Postgres compares `int = numeric` by
    /// converting the column).
    pub int_cast: Option<&'static str>,
}

impl TypedCompare {
    /// The cast target for one bound value.
    pub fn cast_for(&self, value: &str) -> Option<&'static str> {
        match self.int_cast {
            Some(target) if value.parse::<i64>().is_ok() => Some(target),
            _ => self.cast,
        }
    }

    /// MySQL's `NO_ZERO_DATE` mode rejects a zero-date literal (error 1525),
    /// so a condition naming one compares the column's text instead.
    pub fn names_zero_date(&self, values: &[String]) -> bool {
        matches!(
            self.form,
            Some(ValueForm::MysqlDate | ValueForm::MysqlDatetime)
        ) && values.iter().any(|v| v.starts_with("0000-00-00"))
    }
}

/// One column as the live catalog reports it.
#[derive(Debug, Clone)]
pub struct ColMeta {
    pub name: Ident,
    pub type_name: String,
    pub class: ColumnClass,
    /// `None`: filters compare the column's text cast.
    pub compare: Option<TypedCompare>,
    /// Set where two text collations can clash (`spec/protocol.md` §5.4.1).
    pub collation: Option<String>,
    pub key: Option<KeyKind>,
    pub references: Option<ColumnRef>,
    pub comment: Option<String>,
}

impl ColMeta {
    fn is_utf8mb4_text(&self) -> bool {
        matches!(self.class, ColumnClass::Text)
            && self
                .collation
                .as_deref()
                .is_some_and(|c| c.starts_with("utf8mb4"))
    }
}

impl From<ColMeta> for ColumnInfo {
    fn from(c: ColMeta) -> Self {
        ColumnInfo {
            name: c.name.into_string(),
            type_name: c.type_name,
            enum_type: c.class.enum_type(),
            collation: c.class.wire_collation(c.collation.as_ref()),
            class: c.class,
            key: c.key,
            references: c.references,
            comment: c.comment,
        }
    }
}

#[derive(Debug, Clone)]
pub struct TableMeta {
    /// The catalog-checked schema the table is spliced under; `None` on an
    /// engine with no schema above the database (SQLite).
    pub schema: Option<Ident>,
    pub name: Ident,
    pub columns: Vec<ColMeta>,
    /// Indexes into `columns` that break ties after `sort` (`spec/protocol.md`
    /// §5.4); built by [`tie_break_keys`].
    pub order_keys: Vec<usize>,
}

/// A unique key a backend's catalog reports for one table. Backends pass a
/// unique index only when its key columns are plain (no expression), it is
/// not partial, and every key column is NOT NULL.
pub struct UniqueKey {
    pub name: String,
    pub primary: bool,
    pub columns: Vec<String>,
}

/// The primary key's columns in key order, else those of the unique key with
/// the fewest columns (then the lowest name). A key with a column the role
/// cannot see is skipped, and none left means no tie-break.
pub fn tie_break_keys(columns: &[ColMeta], keys: &[UniqueKey]) -> Vec<usize> {
    keys.iter()
        .filter_map(|k| {
            let idx: Option<Vec<usize>> = k
                .columns
                .iter()
                .map(|n| columns.iter().position(|c| c.name.as_str() == n))
                .collect();
            idx.filter(|v| !v.is_empty()).map(|v| (k, v))
        })
        .min_by(|(a, av), (b, bv)| {
            b.primary
                .cmp(&a.primary)
                .then(av.len().cmp(&bv.len()))
                .then(a.name.cmp(&b.name))
        })
        .map(|(_, v)| v)
        .unwrap_or_default()
}

/// One key column of a candidate unique key; `usable` is false when the part
/// rules the whole key out (an expression, or a nullable column).
pub struct KeyPart {
    pub index: String,
    pub primary: bool,
    pub column: Option<String>,
    pub usable: bool,
}

/// Folds parts, ordered by index and then key position, into keys, dropping
/// a key with any unusable part.
pub fn group_unique_keys(parts: impl IntoIterator<Item = KeyPart>) -> Vec<UniqueKey> {
    let mut unusable = HashSet::new();
    let keys = crate::db::merge_runs(
        parts.into_iter().map(|p| {
            if !p.usable {
                unusable.insert(p.index.clone());
            }
            UniqueKey {
                name: p.index,
                primary: p.primary,
                columns: vec![p.column.unwrap_or_default()],
            }
        }),
        |a, b| a.name == b.name,
        |a, b| a.columns.extend(b.columns),
    );
    keys.into_iter()
        .filter(|k| !unusable.contains(&k.name))
        .collect()
}

/// A single-table query's order by, every column qualified by the table name
/// so it never resolves to a text-cast output column in the select list.
pub fn table_order_clause(
    meta: &TableMeta,
    sort: Option<&Ident>,
    descending: bool,
    quote: impl Fn(&Ident) -> String,
) -> String {
    let sort_index = sort.and_then(|s| meta.columns.iter().position(|c| &c.name == s));
    order_by_clause(
        sort_index,
        meta.order_keys.iter().copied(),
        descending,
        |i| format!("{}.{}", quote(&meta.name), quote(&meta.columns[i].name)),
    )
}

/// ` order by <sort>, <keys…>` with a key equal to `sort` left out, every
/// term in one direction (`asc` when there is no `sort`); empty when there
/// is nothing to order by.
pub fn order_by_clause<T: Copy + PartialEq>(
    sort: Option<T>,
    keys: impl IntoIterator<Item = T>,
    descending: bool,
    render: impl Fn(T) -> String,
) -> String {
    let dir = if descending && sort.is_some() {
        "desc"
    } else {
        "asc"
    };
    let terms: Vec<String> = sort
        .into_iter()
        .chain(keys.into_iter().filter(|&k| Some(k) != sort))
        .map(|t| format!("{} {dir}", render(t)))
        .collect();
    if terms.is_empty() {
        String::new()
    } else {
        format!(" order by {}", terms.join(", "))
    }
}

/// A response column: where it came from and the label rows are keyed by.
#[derive(Debug, Serialize)]
pub struct JoinColumnInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub join: usize,
    pub table: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub column: String,
    pub class: ColumnClass,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enum_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<KeyKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references: Option<ColumnRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct JoinData {
    pub columns: Vec<JoinColumnInfo>,
    pub rows: Vec<serde_json::Map<String, serde_json::Value>>,
    pub has_more: bool,
}

/// Request options other than the `join` object itself.
#[derive(Debug, Clone)]
pub struct JoinOpts {
    pub limit: u32,
    pub offset: u32,
    pub sort: Option<String>,
    pub sort_join: Option<usize>,
    pub descending: bool,
    pub timeout_secs: u32,
    pub filter: Option<Vec<Condition>>,
}

struct ResolvedCondition {
    logic: Option<Logic>,
    not: bool,
    op: FilterOp,
    value: Option<FilterValue>,
    path: Option<Vec<PathStep>>,
    pos: usize,
    col: usize,
}

/// A request resolved against the catalog. Everything that reaches SQL text
/// in [`build_select`] comes from `tables`, never from the request.
pub struct Plan {
    pub tables: Vec<TableMeta>,
    kinds: Vec<JoinType>,
    /// Per join entry: `(left position, left column, right column)` triples.
    ons: Vec<Vec<(usize, usize, usize)>>,
    /// `(position, column index)` per returned column.
    selection: Vec<(usize, usize)>,
    labels: Vec<String>,
    filter: Vec<ResolvedCondition>,
    sort: Option<(usize, usize)>,
    descending: bool,
}

impl Plan {
    pub fn labels(&self) -> &[String] {
        &self.labels
    }

    /// `request_schema` is the operation's resolved schema; a column's
    /// `schema` is reported only when its table is elsewhere.
    pub fn columns(&self, request_schema: Option<&str>) -> Vec<JoinColumnInfo> {
        self.selection
            .iter()
            .zip(&self.labels)
            .map(|(&(pos, col), label)| {
                let table = &self.tables[pos];
                let c = &table.columns[col];
                JoinColumnInfo {
                    name: label.clone(),
                    type_name: c.type_name.clone(),
                    join: pos,
                    table: table.name.as_str().to_string(),
                    schema: table
                        .schema
                        .as_ref()
                        .map(Ident::as_str)
                        .filter(|s| Some(*s) != request_schema)
                        .map(str::to_string),
                    column: c.name.as_str().to_string(),
                    class: c.class.clone(),
                    enum_type: c.class.enum_type(),
                    collation: c.class.wire_collation(c.collation.as_ref()),
                    key: c.key,
                    references: c.references.clone(),
                    comment: c.comment.clone(),
                }
            })
            .collect()
    }
}

pub(crate) fn column_index(table: &TableMeta, column: &str) -> Result<usize, DbError> {
    table
        .columns
        .iter()
        .position(|c| c.name.as_str() == column)
        .ok_or_else(|| DbError::not_allowed(NotAllowedKind::Column, format!("column {column:?}")))
}

// A name inside the `join` value is part of the join, so a miss is `invalid_join`, not `unknown_column`.
fn join_column_index(table: &TableMeta, column: &str) -> Result<usize, DbError> {
    column_index(table, column)
        .map_err(|_| DbError::BadJoin(format!("{} has no column {column:?}", table.name.as_str())))
}

/// The schema each position resolves in: its own, which must be in `listed`
/// (§5.7), or else `request`. An unlisted one is `invalid_join`, never
/// `unknown_schema`, which belongs to the `schema` parameter.
pub(crate) fn table_schemas<S: Clone + std::borrow::Borrow<str>>(
    refs: &[(Option<&str>, &str)],
    request: &S,
    listed: &[S],
) -> Result<Vec<S>, DbError> {
    refs.iter()
        .map(|&(own, _)| match own {
            None => Ok(request.clone()),
            Some(s) => listed
                .iter()
                .find(|l| (*l).borrow() == s)
                .cloned()
                .ok_or_else(|| DbError::BadJoin(format!("unknown schema {s:?}"))),
        })
        .collect()
}

/// The same for a table: `not_readable` stays as it is.
pub(crate) fn unknown_join_table(e: DbError) -> DbError {
    match e {
        DbError::NotAllowed(d) if d.kind == NotAllowedKind::Table => {
            DbError::BadJoin(format!("unknown {}", d.what))
        }
        e => e,
    }
}

fn describe(table: &TableMeta, col: &ColMeta) -> String {
    format!(
        "{}.{} ({})",
        table.name.as_str(),
        col.name.as_str(),
        col.type_name
    )
}

fn unjoinable(position: usize, table: &TableMeta, col: &ColMeta) -> DbError {
    let why = if col.class == ColumnClass::Float {
        ": floating-point values are not compared exactly"
    } else {
        ""
    };
    DbError::BadJoin(format!(
        "join {position} on: {} cannot be used in a join{why}",
        describe(table, col)
    ))
}

fn check_pair(
    position: usize,
    lt: &TableMeta,
    lc: &ColMeta,
    rt: &TableMeta,
    rc: &ColMeta,
) -> Result<(), DbError> {
    for (table, col) in [(lt, lc), (rt, rc)] {
        if !col.class.is_joinable() {
            return Err(unjoinable(position, table, col));
        }
    }
    let (a, b) = (&lc.class, &rc.class);
    if a != b {
        return Err(DbError::BadJoin(format!(
            "join {position} on: {} cannot be joined to {}",
            describe(lt, lc),
            describe(rt, rc)
        )));
    }
    if *a == ColumnClass::Text {
        if let (Some(x), Some(y)) = (&lc.collation, &rc.collation) {
            if x != y {
                return Err(DbError::BadJoin(format!(
                    "join {position} on: {} and {} use different text collations ({x} and {y})",
                    describe(lt, lc),
                    describe(rt, rc)
                )));
            }
        }
    }
    Ok(())
}

/// Unique labels: a column keeps its own name when that is unique among the
/// returned columns, otherwise it becomes `{column}_{join}`; a numeric suffix
/// breaks any remaining tie.
fn assign_labels(names: &[(usize, &str)]) -> Vec<String> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for (_, name) in names {
        *counts.entry(name).or_default() += 1;
    }
    let mut used: HashSet<String> = names
        .iter()
        .filter(|(_, n)| counts[n] == 1)
        .map(|(_, n)| n.to_string())
        .collect();
    names
        .iter()
        .map(|&(join, name)| {
            if counts[name] == 1 {
                return name.to_string();
            }
            let base = format!("{name}_{join}");
            let mut label = base.clone();
            let mut n = 2;
            while used.contains(&label) {
                label = format!("{base}_{n}");
                n += 1;
            }
            used.insert(label.clone());
            label
        })
        .collect()
}

/// Resolves a request against the catalog. `tables[i]` is the metadata of
/// position `i`.
pub fn plan(spec: &JoinSpec, tables: Vec<TableMeta>, opts: &JoinOpts) -> Result<Plan, DbError> {
    debug_assert_eq!(tables.len(), spec.joins.len() + 1);

    let mut ons = Vec::new();
    for (i, entry) in spec.joins.iter().enumerate() {
        let position = i + 1;
        let mut resolved = Vec::new();
        for pair in &entry.on {
            let left_table = &tables[pair.left.join];
            let lc = join_column_index(left_table, &pair.left.column)?;
            let rc = join_column_index(&tables[position], &pair.right)?;
            check_pair(
                position,
                left_table,
                &left_table.columns[lc],
                &tables[position],
                &tables[position].columns[rc],
            )?;
            resolved.push((pair.left.join, lc, rc));
        }
        ons.push(resolved);
    }

    let selection = match &spec.columns {
        Some(columns) => columns
            .iter()
            .map(|c| {
                let table = tables.get(c.join).ok_or_else(|| {
                    DbError::BadJoin(format!("columns: position {} is not in the join", c.join))
                })?;
                Ok((c.join, join_column_index(table, &c.column)?))
            })
            .collect::<Result<Vec<_>, DbError>>()?,
        None => tables
            .iter()
            .enumerate()
            .flat_map(|(p, t)| (0..t.columns.len()).map(move |c| (p, c)))
            .collect(),
    };
    let names: Vec<(usize, &str)> = selection
        .iter()
        .map(|&(p, c)| (p, tables[p].columns[c].name.as_str()))
        .collect();
    let labels = assign_labels(&names);

    let mut filter = Vec::new();
    for (i, c) in opts.filter.iter().flatten().enumerate() {
        let pos = c.join.unwrap_or(0);
        let table = tables.get(pos).ok_or_else(|| {
            DbError::FilterParse(format!(
                "condition {i}: join position {pos} is not in the join"
            ))
        })?;
        check_value_shape(c.op, c.value.as_ref())
            .map_err(|e| DbError::FilterParse(format!("condition {i}: {e}")))?;
        let col = column_index(table, &c.column)?;
        check_path_column(i, &table.columns[col], c.path.as_deref())?;
        check_typed_values(&table.columns[col], c)?;
        filter.push(ResolvedCondition {
            logic: c.logic,
            not: c.not,
            op: c.op,
            value: c.value.clone(),
            path: c.path.clone(),
            pos,
            col,
        });
    }

    let sort = match (&opts.sort, opts.sort_join) {
        (None, None) => None,
        (None, Some(_)) => return Err(DbError::BadParameter("sort_join needs sort".into())),
        (Some(column), join) => {
            let pos = join.unwrap_or(0);
            let table = tables.get(pos).ok_or_else(|| {
                DbError::BadParameter(format!("sort_join: position {pos} is not in the join"))
            })?;
            Some((pos, column_index(table, column)?))
        }
    };

    Ok(Plan {
        kinds: spec.joins.iter().map(|j| j.kind).collect(),
        tables,
        ons,
        selection,
        labels,
        filter,
        sort,
        descending: opts.descending,
    })
}

/// Each table's tie-break key as `(position, column)`, in position order. A
/// key whose every column an `on` pair binds, at the same type and collation,
/// to a table already fixed by earlier keys is left out: it cannot change the
/// order (`spec/protocol.md` §5.11.3).
fn join_order_keys(
    tables: &[TableMeta],
    ons: &[Vec<(usize, usize, usize)>],
) -> Vec<(usize, usize)> {
    let mut fixed = Vec::with_capacity(tables.len());
    let mut keys = Vec::new();
    for (p, t) in tables.iter().enumerate() {
        let bound = p > 0
            && !t.order_keys.is_empty()
            && t.order_keys.iter().all(|&k| {
                ons[p - 1].iter().any(|&(lp, lc, rc)| {
                    let (l, r) = (&tables[lp].columns[lc], &t.columns[rc]);
                    rc == k && fixed[lp] && l.type_name == r.type_name && l.collation == r.collation
                })
            });
        if !bound {
            keys.extend(t.order_keys.iter().map(|&c| (p, c)));
        }
        fixed.push(!t.order_keys.is_empty());
    }
    keys
}

/// How a backend spells the pieces that differ between engines.
pub struct Dialect {
    pub quote: fn(&Ident) -> String,
    /// The expression rendering a column as text.
    pub cast_text: fn(&str) -> String,
    /// Converts a bound placeholder to a [`TypedCompare::cast`] target.
    pub cast_param: fn(&str, &str) -> String,
    /// `$n` placeholders (Postgres) instead of `?`.
    pub numbered: bool,
    pub ilike: IlikeStyle,
    /// A `utf8mb4` text-class column compares as stored, so its own collation
    /// decides case; any other charset keeps the cast, since a value it cannot
    /// store would be a database error (`spec/protocol.md` §5.4.2).
    pub text_bare: bool,
    pub json_path: JsonPathFn,
}

/// Renders the text at a validated `path` inside a JSON column expression;
/// the callback binds each value it is given and returns its placeholder.
pub type JsonPathFn = fn(&str, &[PathStep], &mut dyn FnMut(String) -> String) -> String;

/// `$."key"[0]…` for MySQL and SQLite, bound as one parameter. Safe without
/// escaping only because [`check_path`] refuses keys with `"`, `\` or a
/// control character.
#[cfg(any(feature = "mysql", feature = "sqlite"))]
pub(crate) fn json_path_string(path: &[PathStep]) -> String {
    let mut out = String::from("$");
    for step in path {
        match step {
            PathStep::Key(k) => {
                out.push_str(".\"");
                out.push_str(k);
                out.push('"');
            }
            PathStep::Index(i) => out.push_str(&format!("[{i}]")),
        }
    }
    out
}

/// A `path` is checked again here for callers that bypass `filter::parse`,
/// and is valid only on a class `json` column.
fn check_path_column(i: usize, col: &ColMeta, path: Option<&[PathStep]>) -> Result<(), DbError> {
    let Some(path) = path else { return Ok(()) };
    check_path(path).map_err(|e| DbError::FilterParse(format!("condition {i}: {e}")))?;
    if col.class != ColumnClass::Json {
        return Err(DbError::FilterParse(format!(
            "condition {i}: column {:?} is not JSON; only json columns take a path",
            col.name.as_str()
        )));
    }
    Ok(())
}

/// The column-typed half of the `spec/protocol.md` §5.4.2 value check.
fn check_typed_values(col: &ColMeta, c: &Condition) -> Result<(), DbError> {
    let (Some(form), Some(value)) = (col.compare.and_then(|c| c.form), c.value.as_ref()) else {
        return Ok(());
    };
    if c.op.is_pattern() || c.path.is_some() {
        return Ok(());
    }
    match value.items().iter().find(|v| !form.accepts(v)) {
        Some(bad) => Err(DbError::FilterParse(format!(
            "value {bad:?} for column {:?} must be {}",
            col.name.as_str(),
            form.describe()
        ))),
        None => Ok(()),
    }
}

/// One condition with its column resolved; `expr` is the column as SQL.
struct FilterTerm<'a> {
    logic: Option<Logic>,
    not: bool,
    op: FilterOp,
    value: Option<&'a FilterValue>,
    path: Option<&'a [PathStep]>,
    expr: String,
    col: &'a ColMeta,
}

/// The conditions joined by their logic, without `where`, and their values
/// in placeholder order; numbered placeholders start at `$3`, after limit and
/// offset.
fn filter_sql(terms: &[FilterTerm], d: &Dialect) -> (String, Vec<String>) {
    let mut next_param = 3;
    let mut values = Vec::new();
    let mut bind = |value: String| {
        values.push(value);
        if d.numbered {
            next_param += 1;
            format!("${}", next_param - 1)
        } else {
            "?".to_string()
        }
    };
    let mut clause = String::new();
    for (i, t) in terms.iter().enumerate() {
        let items = t.value.map(FilterValue::items).unwrap_or_default();
        let typed = t
            .col
            .compare
            .filter(|c| t.path.is_none() && !t.op.is_pattern() && !c.names_zero_date(items));
        let lhs = match (t.path, typed) {
            (Some(path), _) => (d.json_path)(&t.expr, path, &mut bind),
            (None, Some(_)) => t.expr.clone(),
            (None, None) if d.text_bare && t.col.is_utf8mb4_text() => t.expr.clone(),
            (None, None) => (d.cast_text)(&t.expr),
        };
        let mut placeholder = |value: &str| {
            let p = bind(value.to_string());
            match typed.and_then(|c| c.cast_for(value)) {
                Some(target) => (d.cast_param)(&p, target),
                None => p,
            }
        };
        let inner = match t.op {
            FilterOp::IsNull | FilterOp::IsNotNull => {
                format!("{lhs} {}", crate::db::op_sql(t.op))
            }
            FilterOp::In => {
                let list = items.iter().map(|v| placeholder(v)).collect::<Vec<_>>();
                format!("{lhs} IN ({})", list.join(", "))
            }
            FilterOp::Between => {
                let (lo, hi) = (placeholder(&items[0]), placeholder(&items[1]));
                format!("{lhs} BETWEEN {lo} AND {hi}")
            }
            FilterOp::Ilike => match d.ilike {
                IlikeStyle::Native => format!("{lhs} ILIKE {}", placeholder(&items[0])),
                IlikeStyle::Like => format!("{lhs} LIKE {}", placeholder(&items[0])),
                IlikeStyle::LoweredLike => {
                    format!("LOWER({lhs}) LIKE LOWER({})", placeholder(&items[0]))
                }
            },
            op => format!("{lhs} {} {}", crate::db::op_sql(op), placeholder(&items[0])),
        };
        if i > 0 {
            clause.push_str(match t.logic {
                Some(Logic::Or) => " OR ",
                _ => " AND ",
            });
        }
        clause.push_str(&if t.not {
            format!("(NOT ({inner}))")
        } else {
            format!("({inner})")
        });
    }
    (clause, values)
}

/// The data route's ` where …` (empty without conditions) and its values,
/// with each condition's column checked against `table`
/// (`spec/protocol.md` §5.4.2).
pub(crate) fn table_where_clause(
    conditions: &[Condition],
    table: &TableMeta,
    d: &Dialect,
) -> Result<(String, Vec<String>), DbError> {
    let mut terms = Vec::with_capacity(conditions.len());
    for (i, c) in conditions.iter().enumerate() {
        let col = &table.columns[column_index(table, &c.column)?];
        // Defends the SQL boundary when a caller bypasses filter::parse.
        check_value_shape(c.op, c.value.as_ref())
            .map_err(|e| DbError::FilterParse(format!("condition {i}: {e}")))?;
        if i > 0 && c.logic.is_none() {
            return Err(DbError::FilterParse(format!(
                "condition {i} is missing logic"
            )));
        }
        check_path_column(i, col, c.path.as_deref())?;
        check_typed_values(col, c)?;
        terms.push(FilterTerm {
            logic: c.logic,
            not: c.not,
            op: c.op,
            value: c.value.as_ref(),
            path: c.path.as_deref(),
            expr: (d.quote)(&col.name),
            col,
        });
    }
    let (clause, values) = filter_sql(&terms, d);
    if clause.is_empty() {
        return Ok((String::new(), values));
    }
    Ok((format!(" where {clause}"), values))
}

#[derive(Clone, Copy)]
pub enum IlikeStyle {
    Native,
    Like,
    LoweredLike,
}

/// Builds `<select list> from … limit … offset …` (no leading `select`, so
/// MySQL can wrap it in its timeout hint). Returns the filter values in
/// placeholder order. On numbered dialects `$1`/`$2` are limit and offset
/// and filter values start at `$3`; otherwise bind filter values first,
/// then limit, then offset.
pub fn build_select(plan: &Plan, d: &Dialect) -> (String, Vec<String>) {
    let q = d.quote;
    let alias =
        |pos: usize, col: usize| format!("t{pos}.{}", q(&plan.tables[pos].columns[col].name));

    let select_list = plan
        .selection
        .iter()
        .enumerate()
        .map(|(i, &(p, c))| format!("{} as c{i}", (d.cast_text)(&alias(p, c))))
        .collect::<Vec<_>>()
        .join(", ");

    let from_item = |pos: usize| {
        let table = &plan.tables[pos];
        let name = q(&table.name);
        match &table.schema {
            Some(s) => format!("{}.{name} t{pos}", q(s)),
            None => format!("{name} t{pos}"),
        }
    };
    let mut sql = format!("{select_list} from {}", from_item(0));
    for (i, kind) in plan.kinds.iter().enumerate() {
        let position = i + 1;
        let on = plan.ons[i]
            .iter()
            // Right column first: SQLite compares with the left operand's collation, which key pruning (join_order_keys) relies on.
            .map(|&(lp, lc, rc)| format!("{} = {}", alias(position, rc), alias(lp, lc)))
            .collect::<Vec<_>>()
            .join(" and ");
        sql.push_str(&format!(" {} {} on {on}", kind.sql(), from_item(position)));
    }

    let terms: Vec<FilterTerm> = plan
        .filter
        .iter()
        .map(|c| FilterTerm {
            logic: c.logic,
            not: c.not,
            op: c.op,
            value: c.value.as_ref(),
            path: c.path.as_deref(),
            expr: alias(c.pos, c.col),
            col: &plan.tables[c.pos].columns[c.col],
        })
        .collect();
    let (clause, values) = filter_sql(&terms, d);
    if !clause.is_empty() {
        sql.push_str(&format!(" where {clause}"));
    }

    sql.push_str(&order_by_clause(
        plan.sort,
        join_order_keys(&plan.tables, &plan.ons),
        plan.descending,
        |(p, c)| alias(p, c),
    ));
    if d.numbered {
        sql.push_str(" limit $1 offset $2");
    } else {
        sql.push_str(" limit ? offset ?");
    }
    (sql, values)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Planning and SQL building are covered per engine by
    // spec/fixtures/join-builder-tests.json (db::join_fixture).

    fn col(name: &str, ty: &str, class: ColumnClass) -> ColMeta {
        ColMeta {
            name: Ident::for_test(name),
            type_name: ty.into(),
            class,
            compare: None,
            collation: None,
            key: None,
            references: None,
            comment: None,
        }
    }

    fn orders() -> TableMeta {
        TableMeta {
            schema: Some(Ident::for_test("public")),
            name: Ident::for_test("orders"),
            columns: vec![
                col("id", "uuid", ColumnClass::Uuid),
                col("user_id", "uuid", ColumnClass::Uuid),
            ],
            order_keys: vec![0],
        }
    }

    fn users() -> TableMeta {
        TableMeta {
            schema: Some(Ident::for_test("public")),
            name: Ident::for_test("users"),
            columns: vec![
                col("id", "uuid", ColumnClass::Uuid),
                col("email", "text", ColumnClass::Text),
            ],
            order_keys: vec![0],
        }
    }

    fn opts() -> JoinOpts {
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

    const JOIN: &str = r#"{"table":"orders","joins":[{"type":"left","table":"users",
        "on":[{"left":{"join":0,"column":"user_id"},"right":"id"}]}]}"#;

    #[test]
    fn only_a_text_column_reports_its_collation() {
        let mut text = col("name", "varchar(20)", ColumnClass::Text);
        text.collation = Some("utf8mb4_bin".into());
        let mut doc = col("doc", "json", ColumnClass::Json);
        doc.collation = Some("utf8mb4_bin".into());
        assert_eq!(
            ColumnInfo::from(text).collation.as_deref(),
            Some("utf8mb4_bin")
        );
        assert_eq!(ColumnInfo::from(doc).collation, None);
    }

    #[test]
    fn a_float_key_says_why_it_cannot_join() {
        let mut o = orders();
        o.columns
            .push(col("score", "double precision", ColumnClass::Float));
        let mut spec = JoinSpec::parse(JOIN).unwrap();
        spec.joins[0].on[0].left.column = "score".into();
        let Err(DbError::BadJoin(msg)) = plan(&spec, vec![o, users()], &opts()) else {
            panic!("expected BadJoin");
        };
        assert!(
            msg.contains("orders.score (double precision)")
                && msg.contains("floating-point values are not compared exactly"),
            "{msg}"
        );
    }

    #[test]
    fn a_key_with_an_unusable_part_is_dropped() {
        let part = |index: &str, column: &str, usable| KeyPart {
            index: index.into(),
            primary: false,
            column: Some(column.into()),
            usable,
        };
        let keys = group_unique_keys([
            part("a", "x", true),
            part("a", "y", false),
            part("b", "x", true),
        ]);
        assert_eq!(keys.len(), 1);
        assert_eq!(
            (keys[0].name.as_str(), keys[0].columns.as_slice()),
            ("b", ["x".to_string()].as_slice())
        );
    }

    #[test]
    fn a_table_in_another_schema_is_reported_under_it() {
        let spec = JoinSpec::parse(JOIN).unwrap();
        let mut u = users();
        u.schema = Some(Ident::for_test("warehouse"));
        let p = plan(&spec, vec![orders(), u], &opts()).unwrap();
        let schemas: Vec<_> = p
            .columns(Some("public"))
            .into_iter()
            .map(|c| (c.table, c.schema))
            .collect();
        assert!(schemas.contains(&("orders".into(), None)));
        assert!(schemas.contains(&("users".into(), Some("warehouse".into()))));
    }

    #[test]
    fn a_mysql_zero_date_compares_the_columns_text_on_the_table_route() {
        let dialect = Dialect {
            quote: crate::db::quote_ident,
            cast_text: |c| format!("{c}::text"),
            cast_param: |p, t| format!("{p}::{t}"),
            numbered: true,
            ilike: IlikeStyle::Native,
            text_bare: false,
            json_path: |_, _, _| unreachable!(),
        };
        let table = TableMeta {
            schema: None,
            name: Ident::for_test("t"),
            columns: vec![ColMeta {
                compare: Some(TypedCompare {
                    form: Some(ValueForm::MysqlDate),
                    cast: None,
                    int_cast: None,
                }),
                ..col("d", "date", ColumnClass::Temporal)
            }],
            order_keys: Vec::new(),
        };
        let cond = |op, value| Condition {
            logic: None,
            not: false,
            column: "d".into(),
            op,
            value: Some(value),
            join: None,
            path: None,
        };
        let list = |v: &[&str]| FilterValue::List(v.iter().map(|s| s.to_string()).collect());
        for (filter, want) in [
            (
                cond(FilterOp::Eq, "2016-02-29".into()),
                " where (\"d\" = $3)",
            ),
            (
                cond(FilterOp::Eq, "0000-00-00".into()),
                " where (\"d\"::text = $3)",
            ),
            (
                cond(FilterOp::In, list(&["2016-02-29", "0000-00-00"])),
                " where (\"d\"::text IN ($3, $4))",
            ),
        ] {
            let (sql, _) = table_where_clause(&[filter], &table, &dialect).unwrap();
            assert_eq!(sql, want);
        }
    }
}
