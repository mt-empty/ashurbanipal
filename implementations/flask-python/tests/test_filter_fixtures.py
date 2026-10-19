"""Fixture-driven Postgres filter tests (`spec/fixtures/README.md`).

Fixtures use `$N` placeholders; psycopg uses `%s`, so `_normalize` compares bind order.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from ashurbanipal import filter as filter_module
from ashurbanipal.db import NotAllowed
from ashurbanipal.db.postgres import _build_where_clause

FIXTURES_PATH = Path(__file__).resolve().parents[3] / "spec" / "fixtures" / "filter-builder-tests.json"

# Static mirror of the seed schema's columns for the tables the fixture
# references (spec/fixtures/README.md: unit runners substitute this for a
# live information_schema lookup).
SEED_COLUMNS = {
    "users": [
        "id",
        "email",
        "full_name",
        "age",
        "is_active",
        "login_count",
        "metadata",
        "last_login_at",
        "created_at",
    ],
    "orders": [
        "id",
        "user_id",
        "status",
        "total_cents",
        "discount_pct",
        "tags",
        "line_items",
        "created_at",
    ],
    "products": [
        "id",
        "sku",
        "name",
        "category",
        "price",
        "weight_kg",
        "in_stock",
        "description",
        "created_on",
    ],
}

_PLACEHOLDER_RE = re.compile(r"\$\d+")


def _normalize(where_text: str) -> str:
    return _PLACEHOLDER_RE.sub("%s", where_text)


def _load_cases() -> list[dict]:
    data = json.loads(FIXTURES_PATH.read_text())
    return data["cases"]


@pytest.mark.parametrize("case", _load_cases(), ids=lambda c: c["name"])
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
        where_clause, values = _build_where_clause(conditions, SEED_COLUMNS[case["table"]])
        expected_where = f" where {_normalize(expect['where'])}" if expect["where"] else ""
        assert where_clause == expected_where, f"case {name}: WHERE mismatch"
        assert values == expect["values"], f"case {name}: bind values mismatch"
    elif expect_error == "unknown_column":
        conditions = filter_module.parse(raw)
        with pytest.raises(NotAllowed):
            _build_where_clause(conditions, SEED_COLUMNS[case["table"]])
    else:
        with pytest.raises(filter_module.FilterError):
            filter_module.parse(raw)
