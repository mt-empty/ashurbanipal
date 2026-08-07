"""Deserialization + structural validation of the filter AST wire format
(`spec/protocol.md` §5.4.2). Grammar parsing (DSL text -> AST) is
frontend-only (`spec/filter-dsl.md`); this module never sees DSL text,
never produces SQL, and never validates a column against the schema —
that's each `db/*.py` module's job. Mirrors
`implementations/rust/src/filter.rs`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Optional

# Derived by measurement (implementations/rust/src/filter.rs), not picked
# fresh here: over the valid cases in spec/fixtures/parser-tests.json the
# worst JSON-over-DSL inflation is 5.67x, so the DSL era's 1024 bytes needs
# ~5803 JSON bytes; 8192 is the nearest clean power of two above.
MAX_FILTER_BYTES = 8192
MAX_CONDITIONS = 10

# Exactly the §5.4.2 wire spellings — client text is never used as an
# operator except through this set.
VALID_OPS = {"=", "!=", ">", "<", ">=", "<=", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL"}
NO_VALUE_OPS = {"IS NULL", "IS NOT NULL"}
VALID_LOGIC = {"AND", "OR"}
_CONDITION_FIELDS = {"logic", "not", "column", "op", "value"}


@dataclass(frozen=True)
class Condition:
    column: str
    op: str
    logic: Optional[str] = None
    not_: bool = False
    value: Optional[str] = None


class FilterError(Exception):
    pass


def parse(raw: str) -> list[Condition]:
    """Parses and structurally validates the URL-decoded `filter` param. An
    empty array is legal and means "no filter" (§5.4.2) — callers treat an
    empty result accordingly.
    """
    if len(raw.encode("utf-8")) > MAX_FILTER_BYTES:
        raise FilterError(f"filter too long: {len(raw.encode('utf-8'))} bytes (max {MAX_FILTER_BYTES})")

    try:
        raw_conditions = json.loads(raw)
    except json.JSONDecodeError as e:
        raise FilterError(f"filter must be a JSON array of conditions: {e}") from e
    if not isinstance(raw_conditions, list):
        raise FilterError("filter must be a JSON array of conditions")
    if len(raw_conditions) > MAX_CONDITIONS:
        raise FilterError(f"too many conditions: {len(raw_conditions)} (max {MAX_CONDITIONS})")

    conditions: list[Condition] = []
    for i, raw_cond in enumerate(raw_conditions):
        if not isinstance(raw_cond, dict):
            raise FilterError(f"condition {i} must be a JSON object")
        unknown = set(raw_cond) - _CONDITION_FIELDS
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
        if op not in VALID_OPS:
            raise FilterError(f"condition {i} has invalid op {op!r}")

        value = raw_cond.get("value")
        takes_value = op not in NO_VALUE_OPS
        if takes_value and not isinstance(value, str):
            raise FilterError(f"op {op!r} requires a string value")
        if not takes_value and value is not None:
            raise FilterError(f"op {op!r} takes no value")

        conditions.append(Condition(column=column, op=op, logic=logic, not_=not_, value=value))

    return conditions
