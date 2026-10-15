//! `GET /api/tables/join` (`spec/protocol.md` §5.11): request parsing,
//! catalog-driven validation, and the SQL text every backend shares.
//!
//! The client sends a structure, never SQL. A backend fills [`TableMeta`]
//! from its live catalog, [`plan`] resolves every name against it, and
//! [`build_select`] emits SQL from catalog names and generated aliases only.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::db::{ColumnRef, DbError, KeyKind, NotAllowedKind};
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
    pub on: Vec<OnPair>,
}

/// The decoded `join` parameter. Positions: `0` is `table`, `1..` the
/// entries of `joins` in order.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JoinSpec {
    pub table: String,
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

    /// Table names by position.
    pub fn table_names(&self) -> Vec<&str> {
        std::iter::once(self.table.as_str())
            .chain(self.joins.iter().map(|j| j.table.as_str()))
            .collect()
    }
}

/// Engine-neutral comparison class of a column type (`spec/protocol.md`
/// §5.11.2). Each backend maps its native types onto these.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeClass {
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
}

/// One column as the live catalog reports it.
#[derive(Debug, Clone)]
pub struct ColMeta {
    pub name: String,
    pub type_name: String,
    pub class: Option<TypeClass>,
    /// Set on engines where two text collations can clash (MySQL).
    pub collation: Option<String>,
    pub key: Option<KeyKind>,
    pub references: Option<ColumnRef>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TableMeta {
    pub name: String,
    pub columns: Vec<ColMeta>,
}

/// A response column: where it came from and the label rows are keyed by.
#[derive(Debug, Serialize)]
pub struct JoinColumnInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub join: usize,
    pub table: String,
    pub column: String,
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

    pub fn columns(&self) -> Vec<JoinColumnInfo> {
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
                    table: table.name.clone(),
                    column: c.name.clone(),
                    key: c.key,
                    references: c.references.clone(),
                    comment: c.comment.clone(),
                }
            })
            .collect()
    }
}

fn column_index(table: &TableMeta, column: &str) -> Result<usize, DbError> {
    table
        .columns
        .iter()
        .position(|c| c.name == column)
        .ok_or_else(|| DbError::not_allowed(NotAllowedKind::Column, format!("column {column:?}")))
}

fn describe(table: &TableMeta, col: &ColMeta) -> String {
    format!("{}.{} ({})", table.name, col.name, col.type_name)
}

fn check_pair(
    position: usize,
    lt: &TableMeta,
    lc: &ColMeta,
    rt: &TableMeta,
    rc: &ColMeta,
) -> Result<(), DbError> {
    let (Some(a), Some(b)) = (&lc.class, &rc.class) else {
        let bad = if lc.class.is_none() {
            (lt, lc)
        } else {
            (rt, rc)
        };
        return Err(DbError::BadJoin(format!(
            "join {position} on: {} cannot be used in a join",
            describe(bad.0, bad.1)
        )));
    };
    if a != b {
        return Err(DbError::BadJoin(format!(
            "join {position} on: {} cannot be joined to {}",
            describe(lt, lc),
            describe(rt, rc)
        )));
    }
    if *a == TypeClass::Text {
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
            let lc = column_index(left_table, &pair.left.column)?;
            let rc = column_index(&tables[position], &pair.right)?;
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
                Ok((c.join, column_index(table, &c.column)?))
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
        (None, Some(_)) => return Err(DbError::BadJoin("sort_join needs sort".into())),
        (Some(column), join) => {
            let pos = join.unwrap_or(0);
            let table = tables.get(pos).ok_or_else(|| {
                DbError::BadJoin(format!("sort_join: position {pos} is not in the join"))
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

/// How a backend spells the pieces that differ between engines.
pub struct Dialect {
    pub quote: fn(&str) -> String,
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
pub fn build_select(plan: &Plan, d: &Dialect, schema: Option<&str>) -> (String, Vec<String>) {
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
        let name = q(&plan.tables[pos].name);
        match schema {
            Some(s) => format!("{}.{name} t{pos}", q(s)),
            None => format!("{name} t{pos}"),
        }
    };
    let mut sql = format!("{select_list} from {}", from_item(0));
    for (i, kind) in plan.kinds.iter().enumerate() {
        let position = i + 1;
        let on = plan.ons[i]
            .iter()
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

    if let Some((p, c)) = plan.sort {
        sql.push_str(&format!(
            " order by {} {}",
            alias(p, c),
            if plan.descending { "desc" } else { "asc" }
        ));
    }
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

    fn col(name: &str, ty: &str, class: Option<TypeClass>) -> ColMeta {
        ColMeta {
            name: name.into(),
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
            name: "orders".into(),
            columns: vec![
                col("id", "uuid", Some(TypeClass::Uuid)),
                col("user_id", "uuid", Some(TypeClass::Uuid)),
                col("status", "text", Some(TypeClass::Text)),
                col("tags", "ARRAY", None),
            ],
        }
    }

    fn users() -> TableMeta {
        TableMeta {
            name: "users".into(),
            columns: vec![
                col("id", "uuid", Some(TypeClass::Uuid)),
                col("email", "text", Some(TypeClass::Text)),
            ],
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
        assert_eq!(spec.table_names(), ["orders", "users"]);
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
            Err(DbError::NotAllowed(_))
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
    fn enum_classes_pair_only_when_equal() {
        let mut a = orders();
        a.columns[2] = col(
            "status",
            "USER-DEFINED",
            Some(TypeClass::Enum("public.status".into())),
        );
        let mut b = users();
        b.columns[1] = col(
            "kind",
            "USER-DEFINED",
            Some(TypeClass::Enum("public.kind".into())),
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
            Some(TypeClass::Enum("public.status".into())),
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
        let (sql, values) = build_select(&p, &dialect(), Some("public"));
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
            sql.ends_with(" order by t1.\"email\" asc limit $1 offset $2"),
            "{sql}"
        );
        assert_eq!(values, ["a@b.c"]);
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
            Err(DbError::BadJoin(_))
        ));
        let mut o = opts();
        o.sort = Some("email".into());
        assert!(matches!(
            plan(&spec, vec![orders(), users()], &o),
            Err(DbError::NotAllowed(_))
        ));
    }
}
