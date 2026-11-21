"""Join planner + SQL builder fixtures, per engine (`spec/fixtures/README.md`)."""

from __future__ import annotations

import json
from typing import Any

import pytest
from _catalog_fixture import CATALOGS, ENGINES, FIXTURES_DIR, TABLES, Engine, native_placeholders

from ashurbanipal import filter as filter_module
from ashurbanipal.db import BadJoin, DbError
from ashurbanipal.join import JoinOpts, build_select, parse_join, plan_join, table_schemas
from ashurbanipal.routes import problem_for

FIXTURES = json.loads((FIXTURES_DIR / "join-builder-tests.json").read_text())


def _run(engine: Engine, case: dict[str, Any]) -> dict[str, Any]:
    catalog = CATALOGS[engine.name]
    request = case.get("schema", catalog["default_schema"])
    assert request in catalog["schemas"], f"request schema {request!r} is not in the {engine.name} catalog"
    try:
        spec = parse_join(case["join_raw"] if "join_raw" in case else json.dumps(case["join"]))
        try:
            conditions = filter_module.parse_for_join(json.dumps(case["filter"])) if "filter" in case else None
        except filter_module.FilterError:
            return {"error": "invalid_filter"}
        opts = JoinOpts(
            limit=50,
            offset=0,
            timeout_secs=5,
            sort=case.get("sort"),
            sort_join=case.get("sort_join"),
            descending=case.get("order") == "desc",
            filter=conditions or None,
        )
        refs = spec.table_refs()
        schemas = table_schemas(refs, request, catalog["schemas"])
        metas = []
        for schema, (_, name) in zip(schemas, refs, strict=True):
            meta = TABLES[engine.name].get(f"{schema}.{name}")
            if meta is None:
                raise BadJoin(f"unknown table {name!r}")
            metas.append(meta)
        plan = plan_join(spec, metas, opts)
    except DbError as err:
        return {"error": problem_for(err)[1]}
    sql, values = build_select(plan, engine.dialect)
    return {"sql": sql, "values": values, "labels": plan.labels}


def _expected(engine: Engine, case: dict[str, Any]) -> dict[str, Any] | None:
    if "expect_error" in case:
        return {"error": case["expect_error"]}
    want = case["expect"].get(engine.name)
    if want is None or "error" in want:
        return want
    return {**want, "sql": native_placeholders(engine, want["sql"])}


PARAMS = [
    pytest.param(engine, case, id=f"{engine.name}-{case['name']}")
    for engine in ENGINES
    for case in FIXTURES["cases"]
    if "expect_error" in case or engine.name in case["expect"]
]


@pytest.mark.parametrize(("engine", "case"), PARAMS)
def test_join_builder_fixture(engine: Engine, case: dict[str, Any]) -> None:
    assert _run(engine, case) == _expected(engine, case)
