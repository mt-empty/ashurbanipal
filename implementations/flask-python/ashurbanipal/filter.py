"""Validates filter JSON AST (`spec/protocol.md` §5.4.2); frontend parses DSL text (`spec/filter-dsl.md`)."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date
from typing import Any, Literal, TypeGuard, get_args

MAX_FILTER_BYTES = 8192
MAX_CONDITIONS = 10
MAX_IN_ITEMS = 1000

# Wire operators must come from these allow-lists before reaching SQL (spec/protocol.md §5.4.2).
type NullOp = Literal["IS NULL", "IS NOT NULL"]
type ValueOp = Literal["=", "!=", ">", "<", ">=", "<=", "LIKE", "ILIKE"]
type ListOp = Literal["IN", "BETWEEN"]
NULL_OPS: frozenset[str] = frozenset(get_args(NullOp.__value__))
VALUE_OPS: frozenset[str] = frozenset(get_args(ValueOp.__value__))
LIST_OPS: frozenset[str] = frozenset(get_args(ListOp.__value__))
# LIKE/ILIKE always compare the text cast, whatever the column's class.
PATTERN_OPS: frozenset[str] = frozenset({"LIKE", "ILIKE"})
VALID_LOGIC = {"AND", "OR"}
_CONDITION_FIELDS = {"logic", "not", "column", "op", "value"}


def _is_null_op(op: str) -> TypeGuard[NullOp]:
    return op in NULL_OPS


def _is_value_op(op: str) -> TypeGuard[ValueOp]:
    return op in VALUE_OPS


def _is_list_op(op: str) -> TypeGuard[ListOp]:
    return op in LIST_OPS


def list_shape_error(op: str, value: object) -> str | None:
    """Why `value` is not a valid list for `op` (spec/protocol.md §5.4.2), or None."""
    items = value if isinstance(value, (list, tuple)) else None
    if items is None or not all(isinstance(v, str) for v in items):
        return f"op {op!r} needs an array of strings"
    if op == "IN" and not 1 <= len(items) <= MAX_IN_ITEMS:
        return f"op 'IN' needs an array of 1 to {MAX_IN_ITEMS} strings"
    if op == "BETWEEN" and len(items) != 2:
        return "op 'BETWEEN' needs an array of two strings, [low, high]"
    return None


@dataclass(frozen=True, kw_only=True)
class _ConditionBase:
    column: str
    logic: str | None = None
    not_: bool = False
    # Table position, accepted only by `parse_for_join` (spec/protocol.md §5.11.3).
    join: int | None = None


# Each class checks its op when built as well, since a host's DbSource code may not be type-checked.
@dataclass(frozen=True, kw_only=True)
class NullCheck(_ConditionBase):
    """`IS NULL` or `IS NOT NULL`: nothing to bind."""

    op: NullOp
    value: None = None

    def __post_init__(self) -> None:
        if not _is_null_op(self.op) or self.value is not None:
            raise ValueError(f"NullCheck takes IS NULL or IS NOT NULL and no value, not {self.op!r}")


@dataclass(frozen=True, kw_only=True)
class Comparison(_ConditionBase):
    op: ValueOp
    value: str

    def __post_init__(self) -> None:
        if not _is_value_op(self.op) or not isinstance(self.value, str):
            raise ValueError(f"Comparison takes a value operator and a string value, not {self.op!r}")


@dataclass(frozen=True, kw_only=True)
class ListComparison(_ConditionBase):
    """`IN` (1 to MAX_IN_ITEMS values) or `BETWEEN` (`(low, high)`)."""

    op: ListOp
    value: tuple[str, ...]

    def __post_init__(self) -> None:
        if not _is_list_op(self.op) or list_shape_error(self.op, self.value) is not None:
            raise ValueError(f"ListComparison takes IN or BETWEEN and a valid list, not {self.op!r}")


# A backend narrows on the class before binding, so a value is never missing.
Condition = NullCheck | Comparison | ListComparison


def condition_values(cond: Condition) -> tuple[str, ...]:
    """The values a condition binds, in order."""
    if isinstance(cond, NullCheck):
        return ()
    if isinstance(cond, Comparison):
        return (cond.value,)
    return cond.value


class FilterError(Exception):
    pass


def load_json(raw: str) -> Any:
    """`json.loads`, but a lone UTF-16 surrogate raises ValueError: psycopg
    cannot encode one, so it would otherwise surface as a 500."""
    value = json.loads(raw)
    try:
        json.dumps(value, ensure_ascii=False).encode("utf-8")
    except UnicodeEncodeError as e:
        raise ValueError("a string holds a lone UTF-16 surrogate") from e
    return value


def parse(raw: str) -> list[Condition]:
    return _parse(raw, allow_join=False)


def parse_for_join(raw: str) -> list[Condition]:
    """`parse` for GET /api/tables/join: a condition may carry a `join` table position."""
    return _parse(raw, allow_join=True)


def _parse(raw: str, *, allow_join: bool) -> list[Condition]:
    if len(raw.encode("utf-8")) > MAX_FILTER_BYTES:
        raise FilterError(f"filter too long: {len(raw.encode('utf-8'))} bytes (max {MAX_FILTER_BYTES})")

    try:
        raw_conditions = load_json(raw)
    except ValueError as e:
        raise FilterError(f"filter must be a JSON array of conditions: {e}") from e
    if not isinstance(raw_conditions, list):
        raise FilterError("filter must be a JSON array of conditions")
    if len(raw_conditions) > MAX_CONDITIONS:
        raise FilterError(f"too many conditions: {len(raw_conditions)} (max {MAX_CONDITIONS})")

    conditions: list[Condition] = []
    for i, raw_cond in enumerate(raw_conditions):
        if not isinstance(raw_cond, dict):
            raise FilterError(f"condition {i} must be a JSON object")
        unknown = set(raw_cond) - (_CONDITION_FIELDS | ({"join"} if allow_join else set()))
        if unknown:
            raise FilterError(f"condition {i} has unknown field(s): {sorted(unknown)}")

        logic = raw_cond.get("logic")
        if i == 0 and logic is not None:
            raise FilterError("logic must be absent on the first condition")
        if i > 0 and logic is None:
            raise FilterError(f'condition {i} is missing logic ("AND" or "OR")')
        if logic is not None and logic not in VALID_LOGIC:
            raise FilterError(f'condition {i} has invalid logic {logic!r} (expected "AND" or "OR")')

        not_ = raw_cond.get("not", False)
        if not isinstance(not_, bool):
            raise FilterError(f'condition {i}\'s "not" must be a boolean')

        column = raw_cond.get("column")
        if not isinstance(column, str):
            raise FilterError(f'condition {i} is missing a string "column"')

        join = raw_cond.get("join")
        if join is not None and (not isinstance(join, int) or isinstance(join, bool) or join < 0):
            raise FilterError(f'condition {i} has an invalid "join" position')

        op = raw_cond.get("op")
        value = raw_cond.get("value")
        if not isinstance(op, str):
            raise FilterError(f"condition {i} has invalid op {op!r}")
        if _is_null_op(op):
            if value is not None:
                raise FilterError(f"op {op!r} takes no value")
            conditions.append(NullCheck(column=column, op=op, logic=logic, not_=not_, join=join))
        elif _is_value_op(op):
            if not isinstance(value, str):
                raise FilterError(f"op {op!r} requires a string value")
            conditions.append(Comparison(column=column, op=op, logic=logic, not_=not_, join=join, value=value))
        elif _is_list_op(op):
            why = list_shape_error(op, value)
            if why is not None or not isinstance(value, list):
                raise FilterError(f"condition {i}: {why or f'op {op!r} needs an array of strings'}")
            conditions.append(
                ListComparison(column=column, op=op, logic=logic, not_=not_, join=join, value=tuple(value))
            )
        else:
            raise FilterError(f"condition {i} has invalid op {op!r}")

    return conditions


# The form a value compared in its column's own type must have (spec/protocol.md §5.4.2).
type ValueForm = Literal["number", "float", "date", "timestamp", "timestamptz", "time", "timetz"]

_NUMBER_RE = re.compile(r"[+-]?[0-9]{1,35}(\.[0-9]{1,30})?")
_FLOAT_RE = re.compile(r"[+-]?[0-9]{1,35}(\.[0-9]{1,30})?([eE][+-]?[0-9]{1,3})?")
_TIME_RE = re.compile(r"([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]{1,6})?)?")
_TIME_TZ_RE = re.compile(
    r"([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}([0-9]{2}|:[0-9]{2}(:[0-9]{2})?)?)?"
)
_DATE_RE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})")
_TIMESTAMP_RE = re.compile(r"([0-9]{4}-[0-9]{2}-[0-9]{2})(?:[ T](.*))?", re.DOTALL)


def _real_date(s: str) -> bool:
    """A YYYY-MM-DD string naming a real day in years 0001-9999."""
    m = _DATE_RE.fullmatch(s)
    if m is None:
        return False
    try:
        date(int(m[1]), int(m[2]), int(m[3]))
    except ValueError:
        return False
    return True


def form_accepts(form: ValueForm, v: str) -> bool:
    if form == "number":
        return _NUMBER_RE.fullmatch(v) is not None
    if form == "float":
        return _FLOAT_RE.fullmatch(v) is not None
    if form == "date":
        return _real_date(v)
    if form in ("timestamp", "timestamptz"):
        time_re = _TIME_TZ_RE if form == "timestamptz" else _TIME_RE
        m = _TIMESTAMP_RE.fullmatch(v)
        return m is not None and _real_date(m[1]) and (m[2] is None or time_re.fullmatch(m[2]) is not None)
    return (_TIME_TZ_RE if form == "timetz" else _TIME_RE).fullmatch(v) is not None


def describe_form(form: ValueForm) -> str:
    """Names the expected form in an error title."""
    return {
        "number": "a decimal number such as -12 or 0.5",
        "float": "a number such as 0.5 or 1.5e-3",
        "date": "a date such as 2016-01-31",
        "timestamp": "a date such as 2016-01-31, optionally with a time such as 10:30:00",
        "timestamptz": (
            "a date such as 2016-01-31, optionally with a time such as 10:30:00 and an offset such as +02:00"
        ),
        "time": "a time such as 10:30 or 10:30:00.5",
        "timetz": "a time such as 10:30, optionally with an offset such as +02:00",
    }[form]
