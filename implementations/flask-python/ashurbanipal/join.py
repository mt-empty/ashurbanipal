"""`GET /api/tables/join` (`spec/protocol.md` §5.11): request parsing,
catalog-driven validation, and the SQL text every backend shares.

The client sends a structure, never SQL. A backend fills `TableMeta` from its
live catalog, `plan_join` resolves every name against it, and `build_select`
emits SQL from catalog names and generated aliases only.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field

from .db import BadJoin, ColumnRef, KeyKind, NotAllowed, NotAllowedKind
from .db import FilterParseError as _FilterParseError
from .filter import Condition

MAX_JOIN_BYTES = 8192
MAX_JOIN_TABLES = 4
MAX_JOIN_PAIRS = 3

_OP_SQL = {
    "=": "=",
    "!=": "!=",
    ">": ">",
    "<": "<",
    ">=": ">=",
    "<=": "<=",
    "LIKE": "LIKE",
    "ILIKE": "ILIKE",
    "IS NULL": "IS NULL",
    "IS NOT NULL": "IS NOT NULL",
}


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


@dataclass(frozen=True)
class JoinSpec:
    """Positions: 0 is `table`, 1.. the entries of `joins` in order."""

    table: str
    joins: tuple[JoinEntry, ...]
    columns: tuple[ColumnPos, ...] | None = None

    def table_names(self) -> list[str]:
        return [self.table, *(j.table for j in self.joins)]


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _check_keys(obj: dict, allowed: set[str], what: str) -> None:
    unknown = set(obj) - allowed
    if unknown:
        raise BadJoin(f"{what} has unknown field(s): {sorted(unknown)}")


def _to_pos(raw, what: str) -> ColumnPos:
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
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise BadJoin(f"join must be a JSON object of the documented shape: {e}") from e
    if not isinstance(parsed, dict):
        raise BadJoin("join must be a JSON object")
    _check_keys(parsed, {"table", "joins", "columns"}, "join")
    if not isinstance(parsed.get("table"), str):
        raise BadJoin("join needs a string table")
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
        _check_keys(entry, {"type", "table", "on"}, f"join {position}")
        kind = entry.get("type")
        if kind not in ("inner", "left"):
            raise BadJoin(f'join {position}: type must be "inner" or "left"')
        if not isinstance(entry.get("table"), str):
            raise BadJoin(f"join {position}: table must be a string")
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
        joins.append(JoinEntry(left=kind == "left", table=entry["table"], on=tuple(pairs)))

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
    return JoinSpec(table=parsed["table"], joins=tuple(joins), columns=columns)


@dataclass(frozen=True)
class TypeClass:
    """Comparison class of a column type (`spec/protocol.md` §5.11.2). `id`
    carries an enumerated type's identity; `untyped` is a SQLite column with
    no declared type and pairs only with itself.
    """

    kind: str
    id: str = ""


NUMBER = TypeClass("number")
TEXT = TypeClass("text")
UUID = TypeClass("uuid")
BOOLEAN = TypeClass("boolean")
TEMPORAL = TypeClass("temporal")
TIME = TypeClass("time")
BINARY = TypeClass("binary")
UNTYPED = TypeClass("untyped")


def enum_class(identity: str) -> TypeClass:
    return TypeClass("enum", identity)


@dataclass
class ColMeta:
    """One column as the live catalog reports it."""

    name: str
    type_name: str
    cls: TypeClass | None = None
    collation: str | None = None  # set where two text collations can clash (MySQL)
    key: KeyKind | None = None
    references: ColumnRef | None = None
    comment: str | None = None


@dataclass
class TableMeta:
    name: str
    columns: list[ColMeta]

    def index(self, column: str) -> int:
        for i, c in enumerate(self.columns):
            if c.name == column:
                return i
        raise NotAllowed(f"column {column!r}", kind=NotAllowedKind.COLUMN)


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
    key: KeyKind | None = None
    references: ColumnRef | None = None
    comment: str | None = None


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

    def column_infos(self) -> list[JoinColumnInfo]:
        out = []
        for (pos, col), label in zip(self.selection, self.labels, strict=True):
            t = self.tables[pos]
            c = t.columns[col]
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
                )
            )
        return out

    def rows_from(self, db_rows, limit: int, decode: Callable = lambda v: v) -> tuple[list[dict], bool]:
        """Keys result rows by label and trims the extra row asked for has_more."""
        has_more = len(db_rows) > limit
        out = [dict(zip(self.labels, (decode(v) for v in row), strict=True)) for row in db_rows[:limit]]
        return out, has_more


def _describe(t: TableMeta, c: ColMeta) -> str:
    return f"{t.name}.{c.name} ({c.type_name})"


def _unjoinable(position: int, t: TableMeta, c: ColMeta) -> BadJoin:
    why = (
        ": floating-point values are not compared exactly"
        if re.search(r"real|float|double", c.type_name, re.I)
        else ""
    )
    return BadJoin(f"join {position} on: {_describe(t, c)} cannot be used in a join{why}")


def _check_pair(position: int, lt: TableMeta, lc: ColMeta, rt: TableMeta, rc: ColMeta) -> None:
    if lc.cls is None:
        raise _unjoinable(position, lt, lc)
    if rc.cls is None:
        raise _unjoinable(position, rt, rc)
    if lc.cls != rc.cls:
        raise BadJoin(f"join {position} on: {_describe(lt, lc)} cannot be joined to {_describe(rt, rc)}")
    if lc.cls == TEXT and lc.collation and rc.collation and lc.collation != rc.collation:
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
            lc = lt.index(pair.left.column)
            rc = tables[position].index(pair.right)
            _check_pair(position, lt, lt.columns[lc], tables[position], tables[position].columns[rc])
            resolved.append((pair.left.join, lc, rc))
        ons.append(resolved)

    if spec.columns is not None:
        selection = []
        for c in spec.columns:
            if c.join >= len(tables):
                raise BadJoin(f"columns: position {c.join} is not in the join")
            selection.append((c.join, tables[c.join].index(c.column)))
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
        takes_value = cond.op not in ("IS NULL", "IS NOT NULL")
        if takes_value != (cond.value is not None):
            raise _FilterParseError(f"condition {i}: op {cond.op!r} has the wrong value arity")
        resolved_filter.append(_ResolvedCondition(cond=cond, pos=pos, col=tables[pos].index(cond.column)))

    sort = None
    if opts.sort is None and opts.sort_join is not None:
        raise BadJoin("sort_join needs sort")
    if opts.sort is not None:
        pos = opts.sort_join if opts.sort_join is not None else 0
        if pos < 0 or pos >= len(tables):
            raise BadJoin(f"sort_join: position {pos} is not in the join")
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
    placeholder: str  # "%s" (psycopg, pymysql) or "?" (sqlite3)
    ilike: str  # "native", "like" or "lowered-like"


def build_select(plan: JoinPlan, d: Dialect, schema: str | None) -> tuple[str, list[str]]:
    """Renders `<select list> from … limit … offset …` (no leading `select`,
    so MySQL can wrap it in its timeout hint) and the filter values in
    placeholder order. Bind the values first, then limit, then offset.
    """

    def alias(pos: int, col: int) -> str:
        return f"t{pos}.{d.quote(plan.tables[pos].columns[col].name)}"

    select_list = ", ".join(f"{d.cast_text(alias(p, c))} as c{i}" for i, (p, c) in enumerate(plan.selection))

    def from_item(pos: int) -> str:
        name = d.quote(plan.tables[pos].name)
        return f"{d.quote(schema)}.{name} t{pos}" if schema is not None else f"{name} t{pos}"

    sql = f"{select_list} from {from_item(0)}"
    for i, is_left in enumerate(plan.left):
        position = i + 1
        on = " and ".join(f"{alias(position, rc)} = {alias(lp, lc)}" for lp, lc, rc in plan.ons[i])
        sql += f" {'left join' if is_left else 'inner join'} {from_item(position)} on {on}"

    values: list[str] = []
    clause = ""
    ph = d.placeholder
    for i, rc_cond in enumerate(plan.filter):
        cond = rc_cond.cond
        cast = d.cast_text(alias(rc_cond.pos, rc_cond.col))
        if cond.op in ("IS NULL", "IS NOT NULL"):
            inner = f"{cast} {_OP_SQL[cond.op]}"
        elif cond.op == "ILIKE":
            values.append(cond.value)
            if d.ilike == "native":
                inner = f"{cast} ILIKE {ph}"
            elif d.ilike == "like":
                inner = f"{cast} LIKE {ph}"
            else:
                inner = f"LOWER({cast}) LIKE LOWER({ph})"
        else:
            values.append(cond.value)
            inner = f"{cast} {_OP_SQL[cond.op]} {ph}"
        if i > 0:
            clause += " OR " if cond.logic == "OR" else " AND "
        clause += f"(NOT ({inner}))" if cond.not_ else f"({inner})"
    if clause:
        sql += f" where {clause}"
    if plan.sort is not None:
        sql += f" order by {alias(*plan.sort)} {'desc' if plan.descending else 'asc'}"
    sql += f" limit {ph} offset {ph}"
    return sql, values
