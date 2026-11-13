"""`GET /api/tables/join` (`spec/protocol.md` §5.11): request parsing,
catalog-driven validation, and the SQL text every backend shares.

The client sends a structure, never SQL. A backend fills `TableMeta` from its
live catalog, `plan_join` resolves every name against it, and `build_select`
emits SQL from catalog names and generated aliases only.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any, TypeGuard

from .db import OP_SQL, BadJoin, BadParam, ColumnInfo, ColumnRef, DbError, KeyKind, NotAllowed, NotAllowedKind
from .db import FilterParseError as _FilterParseError
from .filter import (
    PATTERN_OPS,
    Comparison,
    Condition,
    NullCheck,
    ValueForm,
    condition_values,
    describe_form,
    form_accepts,
    load_json,
)

MAX_JOIN_BYTES = 8192
MAX_JOIN_TABLES = 4
MAX_JOIN_PAIRS = 3


@dataclass(frozen=True)
class ColumnPos:
    join: int
    column: str


@dataclass(frozen=True)
class OnPair:
    left: ColumnPos
    right: str


@dataclass(frozen=True)
class JoinEntry:
    left: bool  # False is an inner join
    table: str
    on: tuple[OnPair, ...]
    schema: str | None = None  # None means the request's resolved schema


@dataclass(frozen=True)
class JoinSpec:
    """Positions: 0 is `table`, 1.. the entries of `joins` in order."""

    table: str
    joins: tuple[JoinEntry, ...]
    columns: tuple[ColumnPos, ...] | None = None
    schema: str | None = None  # None means the request's resolved schema

    def table_refs(self) -> list[tuple[str | None, str]]:
        """`(own schema, table)` by position."""
        return [(self.schema, self.table), *((j.schema, j.table) for j in self.joins)]


def table_schemas(refs: list[tuple[str | None, str]], request: str, listed: list[str]) -> list[str]:
    """Each position's schema: its own, which must be in `listed` (§5.7), or
    else `request`. An unlisted one is invalid_join, never unknown_schema,
    which belongs to the schema parameter.
    """
    out = []
    for own, _ in refs:
        if own is None:
            out.append(request)
        elif own in listed:
            out.append(own)
        else:
            raise BadJoin(f"unknown schema {own!r}")
    return out


def _optional_schema(obj: dict[str, Any], what: str) -> str | None:
    if "schema" not in obj:
        return None
    if not isinstance(obj["schema"], str):
        raise BadJoin(f"{what}: schema must be a string")
    return obj["schema"]


def _is_int(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool)


def _check_keys(obj: dict[str, Any], allowed: set[str], what: str) -> None:
    unknown = set(obj) - allowed
    if unknown:
        raise BadJoin(f"{what} has unknown field(s): {sorted(unknown)}")


def _to_pos(raw: object, what: str) -> ColumnPos:
    if not isinstance(raw, dict):
        raise BadJoin(f"{what} must be an object with join and column")
    _check_keys(raw, {"join", "column"}, what)
    join = raw.get("join")
    if not _is_int(join) or join < 0:
        raise BadJoin(f"{what}: join must be a non-negative integer position")
    column = raw.get("column")
    if not isinstance(column, str):
        raise BadJoin(f"{what}: column must be a string")
    return ColumnPos(join=join, column=column)


def parse_join(raw: str) -> JoinSpec:
    """Validates the join object's structure only; names and types are
    checked against the catalog by `plan_join`.
    """
    size = len(raw.encode("utf-8"))
    if size > MAX_JOIN_BYTES:
        raise BadJoin(f"join too long: {size} bytes (max {MAX_JOIN_BYTES})")
    try:
        parsed = load_json(raw)
    except ValueError as e:
        raise BadJoin(f"join must be a JSON object of the documented shape: {e}") from e
    if not isinstance(parsed, dict):
        raise BadJoin("join must be a JSON object")
    _check_keys(parsed, {"table", "schema", "joins", "columns"}, "join")
    if not isinstance(parsed.get("table"), str):
        raise BadJoin("join needs a string table")
    schema = _optional_schema(parsed, "join")
    raw_joins = parsed.get("joins")
    if not isinstance(raw_joins, list) or not raw_joins:
        raise BadJoin("join needs at least one entry in joins")
    if len(raw_joins) + 1 > MAX_JOIN_TABLES:
        raise BadJoin(f"too many tables: {len(raw_joins) + 1} (max {MAX_JOIN_TABLES})")

    joins: list[JoinEntry] = []
    for i, entry in enumerate(raw_joins):
        position = i + 1
        if not isinstance(entry, dict):
            raise BadJoin(f"join {position} must be an object")
        _check_keys(entry, {"type", "table", "schema", "on"}, f"join {position}")
        kind = entry.get("type")
        if kind not in ("inner", "left"):
            raise BadJoin(f'join {position}: type must be "inner" or "left"')
        if not isinstance(entry.get("table"), str):
            raise BadJoin(f"join {position}: table must be a string")
        entry_schema = _optional_schema(entry, f"join {position}")
        raw_on = entry.get("on")
        if not isinstance(raw_on, list) or not 1 <= len(raw_on) <= MAX_JOIN_PAIRS:
            raise BadJoin(f"join {position}: on needs 1 to {MAX_JOIN_PAIRS} pairs")
        pairs: list[OnPair] = []
        for pair in raw_on:
            if not isinstance(pair, dict):
                raise BadJoin(f"join {position}: an on pair must be an object")
            _check_keys(pair, {"left", "right"}, f"join {position}: on pair")
            left = _to_pos(pair.get("left"), f"join {position}: on.left")
            if not isinstance(pair.get("right"), str):
                raise BadJoin(f"join {position}: on.right must be a string")
            if left.join >= position:
                raise BadJoin(
                    f"join {position}: on.left refers to position {left.join}, which is not an earlier table"
                )
            pairs.append(OnPair(left=left, right=pair["right"]))
        joins.append(JoinEntry(left=kind == "left", table=entry["table"], on=tuple(pairs), schema=entry_schema))

    columns: tuple[ColumnPos, ...] | None = None
    if "columns" in parsed:
        raw_columns = parsed["columns"]
        if not isinstance(raw_columns, list) or not raw_columns:
            raise BadJoin("columns must be a non-empty array when present")
        seen: set[ColumnPos] = set()
        picked: list[ColumnPos] = []
        for c in raw_columns:
            pos = _to_pos(c, "columns")
            if pos in seen:
                raise BadJoin(f"columns lists ({pos.join}, {pos.column!r}) twice")
            seen.add(pos)
            picked.append(pos)
        columns = tuple(picked)
    return JoinSpec(table=parsed["table"], joins=tuple(joins), columns=columns, schema=schema)


@dataclass(frozen=True)
class ColumnClass:
    """Class of a column type (`spec/protocol.md` §5.4.1, §5.11.2). `enum_type`
    carries an enumerated type's identity; `untyped` is a SQLite column with
    no declared type and pairs only with itself.
    """

    kind: str
    enum_type: str = ""


NUMBER = ColumnClass("number")
TEXT = ColumnClass("text")
UUID = ColumnClass("uuid")
BOOLEAN = ColumnClass("boolean")
TEMPORAL = ColumnClass("temporal")
TIME = ColumnClass("time")
BINARY = ColumnClass("binary")
UNTYPED = ColumnClass("untyped")
FLOAT = ColumnClass("float")
JSON = ColumnClass("json")
ARRAY = ColumnClass("array")
OTHER = ColumnClass("other")

# Classes whose columns cannot be joined (§5.11.2).
_NOT_JOINABLE = frozenset({FLOAT, JSON, ARRAY, OTHER})


def enum_class(identity: str) -> ColumnClass:
    return ColumnClass("enum", identity)


@dataclass(frozen=True)
class TypedCompare:
    """How a filter compares a column in its own type (`spec/protocol.md`
    §5.4.2): the form a value must have, and the engine's cast target for the
    bound value, from a hardcoded per-engine table (None binds it bare)."""

    form: ValueForm | None
    """None skips the value check: SQLite does not enforce column types."""
    cast: str | None = None
    int_cast: str | None = None
    """The target for a whole number that fits 64 bits, so an integer column
    keeps its index (Postgres compares int = numeric by converting the column)."""

    def cast_for(self, value: str) -> str | None:
        """The cast target for one bound value."""
        if self.int_cast is not None and _INT_RE.fullmatch(value) and -(2**63) <= int(value) < 2**63:
            return self.int_cast
        return self.cast


_INT_RE = re.compile(r"[+-]?[0-9]+")


@dataclass
class ColMeta:
    """One column as the live catalog reports it."""

    name: str
    type_name: str
    column_class: ColumnClass
    compare: TypedCompare | None = None  # None: filters compare the column's text cast
    collation: str | None = None  # set where two text collations can clash (`spec/protocol.md` §5.4.1)
    key: KeyKind | None = None
    references: ColumnRef | None = None
    comment: str | None = None

    def column_info(self) -> ColumnInfo:
        """The §5.4.1 shape of this column."""
        return ColumnInfo(
            name=self.name,
            type_name=self.type_name,
            key=self.key,
            references=self.references,
            comment=self.comment,
            column_class=self.column_class.kind,
            enum_type=self.column_class.enum_type or None,
            collation=self.collation if self.column_class == TEXT else None,
        )


@dataclass
class UniqueKey:
    """A unique key a backend's catalog reports for one table. Backends pass a unique
    index only when its key columns are plain (no expression), it is not partial, and
    every key column is NOT NULL."""

    name: str
    primary: bool
    columns: list[str]


def tie_break_keys(columns: Sequence[ColMeta], keys: Sequence[UniqueKey]) -> list[int]:
    """The primary key's column indexes in key order, else those of the unique key with
    the fewest columns (then the lowest name). A key with a column the role cannot see
    is skipped; none left means no tie-break."""
    names = [c.name for c in columns]
    usable = [
        (k, [names.index(n) for n in k.columns]) for k in keys if k.columns and all(n in names for n in k.columns)
    ]
    if not usable:
        return []
    return min(usable, key=lambda u: (not u[0].primary, len(u[1]), u[0].name))[1]


def group_unique_keys(parts: Iterable[tuple[str, bool, str | None, bool]]) -> list[UniqueKey]:
    """Folds `(index, primary, column, usable)` parts, ordered by index and then key
    position, into keys, dropping a key with any unusable part."""
    keys: list[tuple[UniqueKey, bool]] = []
    for index, primary, column, usable in parts:
        if not keys or keys[-1][0].name != index:
            keys.append((UniqueKey(index, primary, []), True))
        key, ok = keys[-1]
        key.columns.append(column or "")
        keys[-1] = (key, ok and usable)
    return [k for k, ok in keys if ok]


def order_by_clause(sort: Any, keys: Sequence[Any], descending: bool, render: Callable[[Any], str]) -> str:
    """` order by <sort>, <keys…>` with a key equal to `sort` left out, every term in
    one direction (asc when there is no sort); "" when there is nothing to order by."""
    direction = "desc" if descending and sort is not None else "asc"
    terms = ([] if sort is None else [sort]) + [k for k in keys if k != sort]
    if not terms:
        return ""
    return " order by " + ", ".join(f"{render(t)} {direction}" for t in terms)


@dataclass
class TableMeta:
    name: str
    columns: list[ColMeta]
    # The catalog-checked schema the table is spliced under; None on SQLite.
    schema: str | None = None
    # Indexes into `columns` that break ties after `sort` (`spec/protocol.md` §5.4).
    order_keys: list[int] = field(default_factory=list)

    def index(self, column: str) -> int:
        for i, c in enumerate(self.columns):
            if c.name == column:
                return i
        raise NotAllowed(f"column {column!r}", kind=NotAllowedKind.COLUMN)

    def join_index(self, column: str) -> int:
        """`index` for a name inside the join value, where a miss is a bad join."""
        try:
            return self.index(column)
        except NotAllowed:
            raise BadJoin(f"{self.name} has no column {column!r}") from None


def table_order_clause(meta: TableMeta, sort: str | None, descending: bool, quote: Callable[[str], str]) -> str:
    """A single-table query's order by, every column qualified by the table name so it
    never resolves to a text-cast output column."""
    sort_index = None if sort is None else meta.index(sort)
    return order_by_clause(
        sort_index, meta.order_keys, descending, lambda i: f"{quote(meta.name)}.{quote(meta.columns[i].name)}"
    )


def unknown_join_table(err: DbError, table: str) -> DbError:
    """A table named in the join value is part of the join; not_readable stays as it is."""
    if isinstance(err, NotAllowed) and err.kind == NotAllowedKind.TABLE:
        return BadJoin(f"unknown table {table!r}")
    return err


@dataclass
class JoinOpts:
    limit: int
    offset: int
    timeout_secs: int
    sort: str | None = None
    sort_join: int | None = None
    descending: bool = False
    filter: list[Condition] | None = None


@dataclass
class JoinColumnInfo:
    name: str
    type_name: str
    join: int
    table: str
    column: str
    column_class: str
    key: KeyKind | None = None
    references: ColumnRef | None = None
    comment: str | None = None
    enum_type: str | None = None
    collation: str | None = None
    schema: str | None = None


@dataclass
class JoinData:
    columns: list[JoinColumnInfo]
    rows: list[dict[str, str | None]]
    has_more: bool


@dataclass
class _ResolvedCondition:
    cond: Condition
    pos: int
    col: int


@dataclass
class JoinPlan:
    """A request resolved against the catalog; every name in SQL text comes from `tables`, never the request."""

    tables: list[TableMeta]
    left: list[bool]
    ons: list[list[tuple[int, int, int]]]  # per join entry: (left position, left column, right column)
    selection: list[tuple[int, int]]  # (position, column index) per returned column
    labels: list[str]
    filter: list[_ResolvedCondition] = field(default_factory=list)
    sort: tuple[int, int] | None = None
    descending: bool = False

    def column_infos(self, request_schema: str) -> list[JoinColumnInfo]:
        """A column's `schema` is reported only when its table is outside `request_schema`."""
        out = []
        for (pos, col), label in zip(self.selection, self.labels, strict=True):
            t = self.tables[pos]
            c = t.columns[col].column_info()
            out.append(
                JoinColumnInfo(
                    name=label,
                    type_name=c.type_name,
                    join=pos,
                    table=t.name,
                    column=c.name,
                    key=c.key,
                    references=c.references,
                    comment=c.comment,
                    column_class=c.column_class,
                    enum_type=c.enum_type,
                    collation=c.collation,
                    schema=t.schema if t.schema != request_schema else None,
                )
            )
        return out

    def rows_from(
        self, db_rows: Sequence[Sequence[Any]], limit: int, decode: Callable[[Any], Any] = lambda v: v
    ) -> tuple[list[dict[str, Any]], bool]:
        """Keys result rows by label and trims the extra row asked for has_more."""
        has_more = len(db_rows) > limit
        out = [dict(zip(self.labels, (decode(v) for v in row), strict=True)) for row in db_rows[:limit]]
        return out, has_more


def _describe(t: TableMeta, c: ColMeta) -> str:
    return f"{t.name}.{c.name} ({c.type_name})"


def _unjoinable(position: int, t: TableMeta, c: ColMeta) -> BadJoin:
    why = ": floating-point values are not compared exactly" if c.column_class == FLOAT else ""
    return BadJoin(f"join {position} on: {_describe(t, c)} cannot be used in a join{why}")


def _check_pair(position: int, lt: TableMeta, lc: ColMeta, rt: TableMeta, rc: ColMeta) -> None:
    if lc.column_class in _NOT_JOINABLE:
        raise _unjoinable(position, lt, lc)
    if rc.column_class in _NOT_JOINABLE:
        raise _unjoinable(position, rt, rc)
    if lc.column_class != rc.column_class:
        raise BadJoin(f"join {position} on: {_describe(lt, lc)} cannot be joined to {_describe(rt, rc)}")
    if lc.column_class == TEXT and lc.collation and rc.collation and lc.collation != rc.collation:
        raise BadJoin(
            f"join {position} on: {_describe(lt, lc)} and {_describe(rt, rc)} "
            f"use different text collations ({lc.collation} and {rc.collation})"
        )


def assign_labels(names: list[str], joins: list[int]) -> list[str]:
    """A column keeps its own name when that is unique among the returned
    columns, otherwise it becomes `{name}_{join}`; a numeric suffix breaks any
    remaining tie.
    """
    counts: dict[str, int] = {}
    for n in names:
        counts[n] = counts.get(n, 0) + 1
    used = {n for n in names if counts[n] == 1}
    labels = []
    for n, j in zip(names, joins, strict=True):
        if counts[n] == 1:
            labels.append(n)
            continue
        base = f"{n}_{j}"
        label = base
        k = 2
        while label in used:
            label = f"{base}_{k}"
            k += 1
        used.add(label)
        labels.append(label)
    return labels


def plan_join(spec: JoinSpec, tables: list[TableMeta], opts: JoinOpts) -> JoinPlan:
    """Resolves a request against the catalog; `tables[i]` is the metadata of position i."""
    left_flags: list[bool] = []
    ons: list[list[tuple[int, int, int]]] = []
    for i, entry in enumerate(spec.joins):
        position = i + 1
        left_flags.append(entry.left)
        resolved = []
        for pair in entry.on:
            lt = tables[pair.left.join]
            lc = lt.join_index(pair.left.column)
            rc = tables[position].join_index(pair.right)
            _check_pair(position, lt, lt.columns[lc], tables[position], tables[position].columns[rc])
            resolved.append((pair.left.join, lc, rc))
        ons.append(resolved)

    if spec.columns is not None:
        selection = []
        for c in spec.columns:
            if c.join >= len(tables):
                raise BadJoin(f"columns: position {c.join} is not in the join")
            selection.append((c.join, tables[c.join].join_index(c.column)))
    else:
        selection = [(pos, col) for pos, t in enumerate(tables) for col in range(len(t.columns))]
    labels = assign_labels(
        [tables[p].columns[c].name for p, c in selection],
        [p for p, _ in selection],
    )

    resolved_filter = []
    for i, cond in enumerate(opts.filter or []):
        pos = cond.join if cond.join is not None else 0
        if pos < 0 or pos >= len(tables):
            raise _FilterParseError(f"condition {i}: join position {pos} is not in the join")
        col = tables[pos].index(cond.column)
        _check_typed_values(tables[pos].columns[col], cond)
        resolved_filter.append(_ResolvedCondition(cond=cond, pos=pos, col=col))

    sort = None
    if opts.sort is None and opts.sort_join is not None:
        raise BadParam("sort_join needs sort")
    if opts.sort is not None:
        pos = opts.sort_join if opts.sort_join is not None else 0
        if pos < 0 or pos >= len(tables):
            raise BadParam(f"sort_join: position {pos} is not in the join")
        sort = (pos, tables[pos].index(opts.sort))

    return JoinPlan(
        tables=tables,
        left=left_flags,
        ons=ons,
        selection=selection,
        labels=labels,
        filter=resolved_filter,
        sort=sort,
        descending=opts.descending,
    )


@dataclass(frozen=True)
class Dialect:
    """How a backend spells the pieces that differ between engines."""

    quote: Callable[[str], str]
    cast_text: Callable[[str], str]
    # Converts a bound placeholder to a TypedCompare cast target.
    cast_param: Callable[[str, str], str]
    placeholder: str  # "%s" (psycopg, pymysql) or "?" (sqlite3)
    ilike: str  # "native", "like" or "lowered-like"


def join_order_keys(
    tables: Sequence[TableMeta], ons: Sequence[Sequence[tuple[int, int, int]]]
) -> list[tuple[int, int]]:
    """Each table's tie-break key as `(position, column)`, in position order.
    A key whose every column an `on` pair binds, at the same type and
    collation, to a table already fixed by earlier keys is left out: it cannot
    change the order (`spec/protocol.md` §5.11.3).
    """
    fixed: list[bool] = []
    keys: list[tuple[int, int]] = []
    for p, t in enumerate(tables):
        bound = (
            p > 0
            and bool(t.order_keys)
            and all(
                any(
                    rc == k
                    and fixed[lp]
                    and tables[lp].columns[lc].type_name == t.columns[rc].type_name
                    and tables[lp].columns[lc].collation == t.columns[rc].collation
                    for lp, lc, rc in ons[p - 1]
                )
                for k in t.order_keys
            )
        )
        if not bound:
            keys.extend((p, c) for c in t.order_keys)
        fixed.append(bool(t.order_keys))
    return keys


def _check_typed_values(col: ColMeta, cond: Condition) -> None:
    """The column-typed half of the `spec/protocol.md` §5.4.2 value check."""
    form = col.compare.form if col.compare is not None else None
    if form is None or cond.op in PATTERN_OPS:
        return
    for v in condition_values(cond):
        if not form_accepts(form, v):
            expected = describe_form(form)
            raise _FilterParseError(f"value {v!r} for column {col.name!r} must be {expected}")


def _filter_sql(terms: list[tuple[Condition, str, ColMeta]], d: Dialect) -> tuple[str, list[str]]:
    """The conditions joined by their logic, without `where`, and the values
    in placeholder order. Each term is a condition, its column as SQL, and
    that column's metadata."""
    values: list[str] = []
    clause = ""
    for i, (cond, expr, col) in enumerate(terms):
        typed = None if cond.op in PATTERN_OPS else col.compare

        def ph_for(value: str, typed: TypedCompare | None = typed) -> str:
            target = typed.cast_for(value) if typed is not None else None
            return d.placeholder if target is None else d.cast_param(d.placeholder, target)

        lhs = expr if typed is not None else d.cast_text(expr)
        if isinstance(cond, NullCheck):
            inner = f"{expr} {OP_SQL[cond.op]}"
        elif isinstance(cond, Comparison):
            ph = ph_for(cond.value)
            if cond.op == "ILIKE":
                if d.ilike == "native":
                    inner = f"{lhs} ILIKE {ph}"
                elif d.ilike == "like":
                    inner = f"{lhs} LIKE {ph}"
                else:
                    inner = f"LOWER({lhs}) LIKE LOWER({ph})"
            else:
                inner = f"{lhs} {OP_SQL[cond.op]} {ph}"
        elif cond.op == "IN":
            inner = f"{lhs} IN ({', '.join(ph_for(v) for v in cond.value)})"
        else:
            inner = f"{lhs} BETWEEN {ph_for(cond.value[0])} AND {ph_for(cond.value[1])}"
        values.extend(condition_values(cond))
        if i > 0:
            clause += " OR " if cond.logic == "OR" else " AND "
        clause += f"(NOT ({inner}))" if cond.not_ else f"({inner})"
    return clause, values


def table_where_clause(conditions: list[Condition], table: TableMeta, d: Dialect) -> tuple[str, list[str]]:
    """The data route's ` where …` ("" without conditions) and its values, with
    each condition's column checked against the live catalog's columns
    (`spec/protocol.md` §5.4.2)."""
    terms = []
    for i, cond in enumerate(conditions):
        col = table.columns[table.index(cond.column)]
        if i > 0 and cond.logic not in ("AND", "OR"):
            raise _FilterParseError(f"condition {i} is missing logic")
        _check_typed_values(col, cond)
        terms.append((cond, d.quote(col.name), col))
    clause, values = _filter_sql(terms, d)
    return (f" where {clause}" if clause else ""), values


def build_select(plan: JoinPlan, d: Dialect) -> tuple[str, list[str]]:
    """Renders `<select list> from … limit … offset …` (no leading `select`,
    so MySQL can wrap it in its timeout hint) and the filter values in
    placeholder order. Bind the values first, then limit, then offset.
    """

    def alias(pos: int, col: int) -> str:
        return f"t{pos}.{d.quote(plan.tables[pos].columns[col].name)}"

    select_list = ", ".join(f"{d.cast_text(alias(p, c))} as c{i}" for i, (p, c) in enumerate(plan.selection))

    def from_item(pos: int) -> str:
        t = plan.tables[pos]
        name = d.quote(t.name)
        return f"{d.quote(t.schema)}.{name} t{pos}" if t.schema is not None else f"{name} t{pos}"

    sql = f"{select_list} from {from_item(0)}"
    for i, is_left in enumerate(plan.left):
        position = i + 1
        # Right column first: SQLite compares with the left operand's collation,
        # which key pruning (join_order_keys) relies on.
        on = " and ".join(f"{alias(position, rc)} = {alias(lp, lc)}" for lp, lc, rc in plan.ons[i])
        sql += f" {'left join' if is_left else 'inner join'} {from_item(position)} on {on}"

    clause, values = _filter_sql(
        [(rc.cond, alias(rc.pos, rc.col), plan.tables[rc.pos].columns[rc.col]) for rc in plan.filter], d
    )
    ph = d.placeholder
    if clause:
        sql += f" where {clause}"
    sql += order_by_clause(plan.sort, join_order_keys(plan.tables, plan.ons), plan.descending, lambda k: alias(*k))
    sql += f" limit {ph} offset {ph}"
    return sql, values
