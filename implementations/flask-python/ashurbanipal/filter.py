"""Validates filter JSON AST (`spec/protocol.md` §5.4.2); frontend parses DSL text (`spec/filter-dsl.md`)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Literal, TypeGuard, get_args

MAX_FILTER_BYTES = 8192
MAX_CONDITIONS = 10

# Wire operators must come from these allow-lists before reaching SQL (spec/protocol.md §5.4.2).
type NullOp = Literal["IS NULL", "IS NOT NULL"]
type ValueOp = Literal["=", "!=", ">", "<", ">=", "<=", "LIKE", "ILIKE"]
NULL_OPS: frozenset[str] = frozenset(get_args(NullOp.__value__))
VALUE_OPS: frozenset[str] = frozenset(get_args(ValueOp.__value__))
VALID_LOGIC = {"AND", "OR"}
_CONDITION_FIELDS = {"logic", "not", "column", "op", "value"}


def _is_null_op(op: str) -> TypeGuard[NullOp]:
    return op in NULL_OPS


def _is_value_op(op: str) -> TypeGuard[ValueOp]:
    return op in VALUE_OPS


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


# A backend narrows on the class before binding, so a value is never missing.
Condition = NullCheck | Comparison


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
        else:
            raise FilterError(f"condition {i} has invalid op {op!r}")

    return conditions
