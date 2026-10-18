"""Validates filter JSON AST (`spec/protocol.md` §5.4.2); frontend parses DSL text (`spec/filter-dsl.md`)."""

from __future__ import annotations

import json
from dataclasses import dataclass

MAX_FILTER_BYTES = 8192
MAX_CONDITIONS = 10

# Wire operators must come from this allow-list before reaching SQL (spec/protocol.md §5.4.2).
VALID_OPS = {"=", "!=", ">", "<", ">=", "<=", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL"}
NO_VALUE_OPS = {"IS NULL", "IS NOT NULL"}
VALID_LOGIC = {"AND", "OR"}
_CONDITION_FIELDS = {"logic", "not", "column", "op", "value"}


@dataclass(frozen=True)
class Condition:
    column: str
    op: str
    logic: str | None = None
    not_: bool = False
    value: str | None = None
    # Table position, accepted only by `parse_for_join` (spec/protocol.md §5.11.3).
    join: int | None = None


class FilterError(Exception):
    pass


def parse(raw: str) -> list[Condition]:
    return _parse(raw, allow_join=False)


def parse_for_join(raw: str) -> list[Condition]:
    """`parse` for GET /api/tables/join: a condition may carry a `join` table position."""
    return _parse(raw, allow_join=True)


def _parse(raw: str, *, allow_join: bool) -> list[Condition]:
    if len(raw.encode("utf-8")) > MAX_FILTER_BYTES:
        raise FilterError(f"filter too long: {len(raw.encode('utf-8'))} bytes (max {MAX_FILTER_BYTES})")

    try:
        raw_conditions = json.loads(raw)
    # A deeply nested value that fits the byte bound overflows the decoder's recursion, not its grammar.
    except (json.JSONDecodeError, RecursionError) as e:
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

        op = raw_cond.get("op")
        if not isinstance(op, str) or op not in VALID_OPS:
            raise FilterError(f"condition {i} has invalid op {op!r}")

        value = raw_cond.get("value")
        takes_value = op not in NO_VALUE_OPS
        if takes_value and not isinstance(value, str):
            raise FilterError(f"op {op!r} requires a string value")
        if not takes_value and value is not None:
            raise FilterError(f"op {op!r} takes no value")

        join = raw_cond.get("join")
        if join is not None and (not isinstance(join, int) or isinstance(join, bool) or join < 0):
            raise FilterError(f'condition {i} has an invalid "join" position')

        conditions.append(Condition(column=column, op=op, logic=logic, not_=not_, value=value, join=join))

    return conditions
