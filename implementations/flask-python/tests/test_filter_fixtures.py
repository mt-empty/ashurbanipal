"""Table-route filter fixtures, per engine (`spec/fixtures/README.md`)."""

from __future__ import annotations

import json
from typing import Any

import pytest
from _catalog_fixture import CATALOGS, ENGINES, FIXTURES_DIR, TABLES, Engine, native_placeholders

from ashurbanipal import filter as filter_module
from ashurbanipal.db import FilterParseError, NotAllowed
from ashurbanipal.join import table_where_clause

FIXTURES = json.loads((FIXTURES_DIR / "filter-builder-tests.json").read_text())

# Structural kinds all fail the parse before any schema access, so they compare as one.
_STRUCTURAL = "structural"


def _kind(kind: str) -> str:
    return kind if kind in ("unknown_column", "invalid_value") else _STRUCTURAL


def _expected(engine: Engine, case: dict[str, Any]) -> dict[str, Any] | None:
    if "expect_error" in case:
        return {"error": _kind(case["expect_error"])}
    want = case["expect"].get(engine.name)
    if want is None:
        return None
    if "error" in want:
        return {"error": _kind(want["error"])}
    return {**want, "where": native_placeholders(engine, want["where"])}


def _run(engine: Engine, case: dict[str, Any]) -> dict[str, Any]:
    raw = case["raw"] if "raw" in case else json.dumps(case["conditions"])
    try:
        conditions = filter_module.parse(raw)
    except filter_module.FilterError:
        return {"error": _STRUCTURAL}
    table = TABLES[engine.name][f"{CATALOGS[engine.name]['default_schema']}.{case['table']}"]
    try:
        where, values = table_where_clause(conditions, table, engine.dialect)
    except NotAllowed:
        return {"error": "unknown_column"}
    except FilterParseError:
        return {"error": "invalid_value"}
    return {"where": where.removeprefix(" where "), "values": values}


PARAMS = [
    pytest.param(engine, case, id=f"{engine.name}-{case['name']}")
    for engine in ENGINES
    for case in FIXTURES["cases"]
    if _expected(engine, case) is not None
]


@pytest.mark.parametrize(("engine", "case"), PARAMS)
def test_filter_builder_fixture(engine: Engine, case: dict[str, Any]) -> None:
    assert _run(engine, case) == _expected(engine, case)
