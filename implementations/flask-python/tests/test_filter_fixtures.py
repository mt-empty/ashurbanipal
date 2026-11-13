"""Fixture-driven Postgres filter tests (`spec/fixtures/README.md`).

Fixtures use `$N` placeholders; psycopg uses `%s`, so `_normalize` compares bind order.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from ashurbanipal import filter as filter_module
from ashurbanipal.db import FilterParseError, NotAllowed
from ashurbanipal.db.postgres import _JOIN_DIALECT, column_class, typed_compare
from ashurbanipal.join import ColMeta, table_where_clause

FIXTURES_PATH = Path(__file__).resolve().parents[3] / "spec" / "fixtures" / "filter-builder-tests.json"
FIXTURES = json.loads(FIXTURES_PATH.read_text())


def _seed_columns(table: str) -> list[ColMeta]:
    """The fixture's tables map in place of the live catalog lookup (spec/fixtures/README.md)."""
    return [
        ColMeta(
            name=name,
            type_name=c["type"],
            column_class=column_class(c["type"], "", "", False),
            compare=typed_compare(c["type"]),
        )
        for name, c in FIXTURES["tables"][table].items()
    ]


_PLACEHOLDER_RE = re.compile(r"\$\d+")


def _normalize(where_text: str) -> str:
    return _PLACEHOLDER_RE.sub("%s", where_text)


@pytest.mark.parametrize("case", FIXTURES["cases"], ids=lambda c: c["name"])
def test_filter_builder_fixture(case: dict) -> None:
    name = case["name"]
    raw = case.get("raw")
    if raw is None:
        raw = json.dumps(case["conditions"])

    expect = case.get("expect")
    expect_error = case.get("expect_error")
    assert (expect is None) != (expect_error is None), f"case {name}: exactly one of expect/expect_error required"

    if expect is not None:
        conditions = filter_module.parse(raw)
        where_clause, values = table_where_clause(conditions, _seed_columns(case["table"]), _JOIN_DIALECT)
        expected_where = f" where {_normalize(expect['where'])}" if expect["where"] else ""
        assert where_clause == expected_where, f"case {name}: WHERE mismatch"
        assert values == expect["values"], f"case {name}: bind values mismatch"
    elif expect_error in ("unknown_column", "invalid_value"):
        conditions = filter_module.parse(raw)
        with pytest.raises(NotAllowed if expect_error == "unknown_column" else FilterParseError):
            table_where_clause(conditions, _seed_columns(case["table"]), _JOIN_DIALECT)
    else:
        with pytest.raises(filter_module.FilterError):
            filter_module.parse(raw)
