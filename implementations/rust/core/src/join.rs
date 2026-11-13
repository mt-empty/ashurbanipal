//! `GET /api/tables/join` (`spec/protocol.md` §5.11): request parsing,
//! catalog-driven validation, and the SQL text every backend shares.
//!
//! The client sends a structure, never SQL. A backend fills [`TableMeta`]
//! from its live catalog, [`plan`] resolves every name against it, and
//! [`build_select`] emits SQL from catalog names and generated aliases only.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::db::{ColumnInfo, ColumnRef, DbError, Ident, KeyKind, NotAllowedKind};
use crate::filter::{Condition, FilterOp, Logic};

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
}

impl Serialize for ColumnClass {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.wire_name())
    }
}

/// One column as the live catalog reports it.
#[derive(Debug, Clone)]
pub struct ColMeta {
    pub name: Ident,
    pub type_name: String,
    pub class: ColumnClass,
    /// Set where two text collations can clash (`spec/protocol.md` §5.4.1).
    pub collation: Option<String>,
    pub key: Option<KeyKind>,
    pub references: Option<ColumnRef>,
    pub comment: Option<String>,
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
    let mut keys: Vec<(UniqueKey, bool)> = Vec::new();
    for p in parts {
        if keys.last().is_none_or(|(k, _)| k.name != p.index) {
            keys.push((
                UniqueKey {
                    name: p.index,
                    primary: p.primary,
                    columns: Vec::new(),
                },
                true,
            ));
        }
        let (key, usable) = keys.last_mut().expect("pushed above");
        key.columns.push(p.column.unwrap_or_default());
        *usable &= p.usable;
    }
    keys.into_iter()
        .filter(|(_, u)| *u)
        .map(|(k, _)| k)
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
    value: Option<String>,
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
        if c.op.takes_value() != c.value.is_some() {
            return Err(DbError::FilterParse(format!(
                "condition {i}: op {:?} {} a value",
                c.op.as_wire(),
                if c.op.takes_value() {
                    "requires"
                } else {
                    "takes no"
                }
            )));
        }
        filter.push(ResolvedCondition {
            logic: c.logic,
            not: c.not,
            op: c.op,
            value: c.value.clone(),
            pos,
            col: column_index(table, &c.column)?,
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
    /// `$n` placeholders (Postgres) instead of `?`.
    pub numbered: bool,
    pub ilike: IlikeStyle,
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

    let mut values = Vec::new();
    let mut next_param = 3;
    let mut clause = String::new();
    for (i, c) in plan.filter.iter().enumerate() {
        let cast = (d.cast_text)(&alias(c.pos, c.col));
        let mut placeholder = || {
            if d.numbered {
                let p = format!("${next_param}");
                next_param += 1;
                p
            } else {
                "?".to_string()
            }
        };
        let inner = match (c.op, &c.value) {
            (op, None) => format!("{cast} {}", crate::db::op_sql(op)),
            (FilterOp::Ilike, Some(v)) => {
                values.push(v.clone());
                match d.ilike {
                    IlikeStyle::Native => format!("{cast} ILIKE {}", placeholder()),
                    IlikeStyle::Like => format!("{cast} LIKE {}", placeholder()),
                    IlikeStyle::LoweredLike => {
                        format!("LOWER({cast}) LIKE LOWER({})", placeholder())
                    }
                }
            }
            (op, Some(v)) => {
                values.push(v.clone());
                format!("{cast} {} {}", crate::db::op_sql(op), placeholder())
            }
        };
        if i > 0 {
            clause.push_str(match c.logic {
                Some(Logic::Or) => " OR ",
                _ => " AND ",
            });
        }
        clause.push_str(&if c.not {
            format!("(NOT ({inner}))")
        } else {
            format!("({inner})")
        });
    }
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

    fn col(name: &str, ty: &str, class: ColumnClass) -> ColMeta {
        ColMeta {
            name: Ident::for_test(name),
            type_name: ty.into(),
            class,
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
                col("status", "text", ColumnClass::Text),
                col("tags", "ARRAY", ColumnClass::Array),
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

    fn dialect() -> Dialect {
        Dialect {
            quote: crate::db::quote_ident,
            cast_text: |c| format!("{c}::text"),
            numbered: true,
            ilike: IlikeStyle::Native,
        }
    }

    const JOIN: &str = r#"{"table":"orders","joins":[{"type":"left","table":"users",
        "on":[{"left":{"join":0,"column":"user_id"},"right":"id"}]}]}"#;

    #[test]
    fn parses_a_valid_join() {
        let spec = JoinSpec::parse(JOIN).unwrap();
        assert_eq!(spec.table_refs(), [(None, "orders"), (None, "users")]);
        assert_eq!(spec.joins[0].kind, JoinType::Left);
    }

    #[test]
    fn rejects_structural_violations() {
        let cases = [
            "not json",
            "[]",
            r#"{"table":"o","joins":[]}"#,
            r#"{"table":"o","joins":[{"type":"right","table":"u","on":[{"left":{"join":0,"column":"a"},"right":"b"}]}]}"#,
            r#"{"table":"o","joins":[{"type":"LEFT","table":"u","on":[{"left":{"join":0,"column":"a"},"right":"b"}]}]}"#,
            r#"{"table":"o","joins":[{"type":"left","table":"u","on":[]}]}"#,
            r#"{"table":"o","joins":[{"type":"left","table":"u","on":[{"left":{"join":1,"column":"a"},"right":"b"}]}]}"#,
            r#"{"table":"o","joins":[{"type":"left","table":"u","on":[{"left":{"join":0,"column":"a"},"right":"b","op":">"}]}]}"#,
            r#"{"table":"o","joins":[{"type":"left","table":"u","on":[{"left":{"join":-1,"column":"a"},"right":"b"}]}]}"#,
            r#"{"table":"o","joins":[{"type":"left","table":"u","on":[{"left":{"join":0,"column":"a"},"right":"b"}]}],"columns":[]}"#,
            r#"{"table":"o","joins":[{"type":"left","table":"u","on":[{"left":{"join":0,"column":"a"},"right":"b"}]}],"columns":[{"join":0,"column":"a"},{"join":0,"column":"a"}]}"#,
        ];
        for raw in cases {
            assert!(JoinSpec::parse(raw).is_err(), "should reject {raw}");
        }
    }

    #[test]
    fn caps_tables_and_pairs_and_bytes() {
        let pair = r#"{"left":{"join":0,"column":"a"},"right":"b"}"#;
        let four_pairs = format!(
            r#"{{"table":"o","joins":[{{"type":"left","table":"u","on":[{pair},{pair},{pair},{pair}]}}]}}"#
        );
        assert!(JoinSpec::parse(&four_pairs).is_err());
        let entry = format!(r#"{{"type":"left","table":"u","on":[{pair}]}}"#);
        let five = format!(r#"{{"table":"o","joins":[{entry},{entry},{entry},{entry}]}}"#);
        assert!(JoinSpec::parse(&five).is_err());
        let four = format!(r#"{{"table":"o","joins":[{entry},{entry},{entry}]}}"#);
        assert!(JoinSpec::parse(&four).is_ok());
        let long = format!(r#"{{"table":"{}","joins":[]}}"#, "t".repeat(MAX_JOIN_BYTES));
        assert!(JoinSpec::parse(&long).is_err());
    }

    #[test]
    fn plan_rejects_unknown_names_and_incompatible_pairs() {
        let spec = JoinSpec::parse(JOIN).unwrap();
        let mut bad_name = spec.clone();
        bad_name.joins[0].on[0].right = "nope\"; drop".into();
        assert!(matches!(
            plan(&bad_name, vec![orders(), users()], &opts()),
            Err(DbError::BadJoin(_))
        ));

        let mut cross = spec.clone();
        cross.joins[0].on[0].left.column = "status".into();
        let Err(DbError::BadJoin(msg)) = plan(&cross, vec![orders(), users()], &opts()) else {
            panic!("expected BadJoin");
        };
        assert!(
            msg.contains("orders.status (text)") && msg.contains("users.id (uuid)"),
            "{msg}"
        );

        let mut array = spec;
        array.joins[0].on[0].left.column = "tags".into();
        assert!(matches!(
            plan(&array, vec![orders(), users()], &opts()),
            Err(DbError::BadJoin(_))
        ));
    }

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
    fn enum_classes_pair_only_when_equal() {
        let mut a = orders();
        a.columns[2] = col(
            "status",
            "USER-DEFINED",
            ColumnClass::Enum("public.status".into()),
        );
        let mut b = users();
        b.columns[1] = col(
            "kind",
            "USER-DEFINED",
            ColumnClass::Enum("public.kind".into()),
        );
        let mut spec = JoinSpec::parse(JOIN).unwrap();
        spec.joins[0].on[0].left.column = "status".into();
        spec.joins[0].on[0].right = "kind".into();
        assert!(matches!(
            plan(&spec, vec![a.clone(), b], &opts()),
            Err(DbError::BadJoin(_))
        ));
        let mut same = users();
        same.columns[1] = col(
            "kind",
            "USER-DEFINED",
            ColumnClass::Enum("public.status".into()),
        );
        assert!(plan(&spec, vec![a, same], &opts()).is_ok());
    }

    #[test]
    fn text_collation_clash_is_rejected() {
        let mut a = orders();
        a.columns[2].collation = Some("utf8mb4_bin".into());
        let mut b = users();
        b.columns[1].collation = Some("utf8mb4_general_ci".into());
        let mut spec = JoinSpec::parse(JOIN).unwrap();
        spec.joins[0].on[0].left.column = "status".into();
        spec.joins[0].on[0].right = "email".into();
        let Err(DbError::BadJoin(msg)) = plan(&spec, vec![a, b], &opts()) else {
            panic!("expected BadJoin");
        };
        assert!(msg.contains("collation"), "{msg}");
    }

    #[test]
    fn tie_break_prefers_the_primary_key_then_the_shortest_unique_key() {
        let cols = orders().columns;
        let key = |name: &str, primary, columns: &[&str]| UniqueKey {
            name: name.into(),
            primary,
            columns: columns.iter().map(|c| c.to_string()).collect(),
        };
        let pk = key("z_pkey", true, &["status", "id"]);
        let short = key("b", false, &["user_id"]);
        let tied = key("a", false, &["status"]);
        let hidden = key("0", false, &["hidden"]);
        assert_eq!(tie_break_keys(&cols, &[short, pk]), [2, 0]);
        let short = key("b", false, &["user_id"]);
        assert_eq!(tie_break_keys(&cols, &[short, tied, hidden]), [2]);
        assert!(tie_break_keys(&cols, &[]).is_empty());
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
    fn order_by_leaves_out_a_key_already_used_as_sort() {
        let render = |i: usize| format!("c{i}");
        assert_eq!(
            order_by_clause(Some(1), [1, 0], true, render),
            " order by c1 desc, c0 desc"
        );
        // `order` applies only with a `sort`.
        assert_eq!(order_by_clause(None, [0], true, render), " order by c0 asc");
        assert_eq!(order_by_clause(None, [], false, render), "");
    }

    #[test]
    fn labels_are_unique_and_stable() {
        let labels = assign_labels(&[(0, "id"), (1, "id"), (1, "email"), (0, "id_1")]);
        assert_eq!(labels, ["id_0", "id_1_2", "email", "id_1"]);
        let labels = assign_labels(&[(0, "id"), (1, "id"), (1, "email")]);
        assert_eq!(labels, ["id_0", "id_1", "email"]);
    }

    #[test]
    fn builds_sql_from_catalog_names_only() {
        let spec = JoinSpec::parse(JOIN).unwrap();
        let mut o = opts();
        o.sort = Some("email".into());
        o.sort_join = Some(1);
        o.filter = Some(vec![
            Condition {
                logic: None,
                not: false,
                column: "email".into(),
                op: FilterOp::Eq,
                value: Some("a@b.c".into()),
                join: Some(1),
            },
            Condition {
                logic: Some(Logic::Or),
                not: true,
                column: "status".into(),
                op: FilterOp::IsNull,
                value: None,
                join: None,
            },
        ]);
        let p = plan(&spec, vec![orders(), users()], &o).unwrap();
        let (sql, values) = build_select(&p, &dialect());
        assert!(sql.starts_with("t0.\"id\"::text as c0, "), "{sql}");
        assert!(
            sql.contains(
                " from \"public\".\"orders\" t0 left join \"public\".\"users\" t1 \
                 on t1.\"id\" = t0.\"user_id\""
            ),
            "{sql}"
        );
        assert!(
            sql.contains(" where (t1.\"email\"::text = $3) OR (NOT (t0.\"status\"::text IS NULL))"),
            "{sql}"
        );
        assert!(
            sql.ends_with(" order by t1.\"email\" asc, t0.\"id\" asc limit $1 offset $2"),
            "{sql}"
        );
        assert_eq!(values, ["a@b.c"]);
    }

    #[test]
    fn each_table_may_name_its_own_schema() {
        let spec = JoinSpec::parse(
            r#"{"table":"shipments","schema":"warehouse","joins":[{"type":"left","table":"orders",
            "schema":"public","on":[{"left":{"join":0,"column":"order_id"},"right":"id"}]}]}"#,
        )
        .unwrap();
        assert_eq!(
            spec.table_refs(),
            [(Some("warehouse"), "shipments"), (Some("public"), "orders")]
        );
        for bad in [
            r#"{"table":"orders","schema":null,"joins":[{"type":"left","table":"users",
            "on":[{"left":{"join":0,"column":"user_id"},"right":"id"}]}]}"#,
            r#"{"table":"orders","schema":1,"joins":[{"type":"left","table":"users",
            "on":[{"left":{"join":0,"column":"user_id"},"right":"id"}]}]}"#,
            r#"{"table":"orders","joins":[{"type":"left","table":"users","schema":["public"],
            "on":[{"left":{"join":0,"column":"user_id"},"right":"id"}]}]}"#,
        ] {
            assert!(JoinSpec::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_table_in_another_schema_is_spliced_and_reported_under_it() {
        let spec = JoinSpec::parse(JOIN).unwrap();
        let mut u = users();
        u.schema = Some(Ident::for_test("warehouse"));
        let p = plan(&spec, vec![orders(), u], &opts()).unwrap();
        let (sql, _) = build_select(&p, &dialect());
        assert!(
            sql.contains(" from \"public\".\"orders\" t0 left join \"warehouse\".\"users\" t1 "),
            "{sql}"
        );
        let schemas: Vec<_> = p
            .columns(Some("public"))
            .into_iter()
            .map(|c| (c.table, c.schema))
            .collect();
        assert!(schemas.contains(&("orders".into(), None)));
        assert!(schemas.contains(&("users".into(), Some("warehouse".into()))));
    }

    #[test]
    fn filter_and_sort_positions_are_range_checked() {
        let spec = JoinSpec::parse(JOIN).unwrap();
        let mut o = opts();
        o.filter = Some(vec![Condition {
            logic: None,
            not: false,
            column: "id".into(),
            op: FilterOp::IsNull,
            value: None,
            join: Some(2),
        }]);
        assert!(matches!(
            plan(&spec, vec![orders(), users()], &o),
            Err(DbError::FilterParse(_))
        ));
        let mut o = opts();
        o.sort_join = Some(1);
        assert!(matches!(
            plan(&spec, vec![orders(), users()], &o),
            Err(DbError::BadParameter(_))
        ));
        let mut o = opts();
        o.sort = Some("email".into());
        assert!(matches!(
            plan(&spec, vec![orders(), users()], &o),
            Err(DbError::NotAllowed(_))
        ));
    }

    fn keyed(name: &str, cols: &[(&str, &str)], key: Vec<usize>) -> TableMeta {
        TableMeta {
            schema: None,
            name: Ident::for_test(name),
            columns: cols
                .iter()
                .map(|&(n, t)| col(n, t, ColumnClass::Number))
                .collect(),
            order_keys: key,
        }
    }

    #[test]
    fn a_key_fully_bound_to_a_fixed_table_is_left_out() {
        let t0 = keyed("a", &[("id", "int4"), ("b_id", "int4")], vec![0]);
        let t1 = keyed("b", &[("id", "int4")], vec![0]);
        assert_eq!(join_order_keys(&[t0, t1], &[vec![(0, 1, 0)]]), [(0, 0)]);
    }

    #[test]
    fn a_partly_bound_key_is_kept() {
        let t0 = keyed("a", &[("id", "int4"), ("x", "int4")], vec![0]);
        let t1 = keyed("b", &[("x", "int4"), ("y", "int4")], vec![0, 1]);
        assert_eq!(
            join_order_keys(&[t0, t1], &[vec![(0, 1, 0)]]),
            [(0, 0), (1, 0), (1, 1)]
        );
    }

    #[test]
    fn a_composite_key_bound_column_by_column_is_left_out() {
        let t0 = keyed(
            "a",
            &[("id", "int4"), ("x", "int4"), ("y", "int4")],
            vec![0],
        );
        let t1 = keyed("b", &[("x", "int4"), ("y", "int4")], vec![0, 1]);
        assert_eq!(
            join_order_keys(&[t0, t1], &[vec![(0, 2, 1), (0, 1, 0)]]),
            [(0, 0)]
        );
    }

    #[test]
    fn a_key_bound_across_types_or_collations_is_kept() {
        let t0 = keyed("a", &[("id", "int4"), ("b_id", "int8")], vec![0]);
        let t1 = keyed("b", &[("id", "int4")], vec![0]);
        assert_eq!(
            join_order_keys(&[t0, t1], &[vec![(0, 1, 0)]]),
            [(0, 0), (1, 0)]
        );

        let mut t0 = keyed("a", &[("id", "int4"), ("b_code", "text")], vec![0]);
        t0.columns[1].collation = Some("C".into());
        let t1 = keyed("b", &[("code", "text")], vec![0]);
        assert_eq!(
            join_order_keys(&[t0, t1], &[vec![(0, 1, 0)]]),
            [(0, 0), (1, 0)]
        );
    }

    #[test]
    fn a_key_bound_to_a_keyless_table_is_kept() {
        let t0 = keyed("v", &[("b_id", "int4")], vec![]);
        let t1 = keyed("b", &[("id", "int4")], vec![0]);
        assert_eq!(join_order_keys(&[t0, t1], &[vec![(0, 0, 0)]]), [(1, 0)]);
    }

    #[test]
    fn a_left_out_key_still_fixes_its_table_for_later_joins() {
        let t0 = keyed("a", &[("id", "int4"), ("b_id", "int4")], vec![0]);
        let t1 = keyed("b", &[("id", "int4"), ("c_id", "int4")], vec![0]);
        let t2 = keyed("c", &[("id", "int4")], vec![0]);
        assert_eq!(
            join_order_keys(&[t0, t1, t2], &[vec![(0, 1, 0)], vec![(1, 1, 0)]]),
            [(0, 0)]
        );
    }

    #[test]
    fn one_binding_from_a_fixed_table_is_enough() {
        let t0 = keyed("v", &[("b_id", "int4")], vec![]);
        let t1 = keyed("a", &[("id", "int4"), ("b_id", "int4")], vec![0]);
        let t2 = keyed("b", &[("id", "int4")], vec![0]);
        assert_eq!(
            join_order_keys(
                &[t0, t1, t2],
                &[vec![(0, 0, 1)], vec![(0, 0, 0), (1, 1, 0)]]
            ),
            [(1, 0)]
        );
    }
}
