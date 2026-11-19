"""Join planner + SQL builder fixtures, per engine (`spec/fixtures/README.md`).

Fixture SQL uses `$N` (Postgres) or `?` placeholders; each is swapped for the dialect's own before comparing.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from ashurbanipal import filter as filter_module
from ashurbanipal.db import BadJoin, DbError
from ashurbanipal.db import mysql as mysql_db
from ashurbanipal.db import postgres as pg_db
from ashurbanipal.db import sqlite as sqlite_db
from ashurbanipal.join import (
    ColMeta,
    Dialect,
    JoinOpts,
    TableMeta,
    UniqueKey,
    build_select,
    parse_join,
    plan_join,
    table_schemas,
    tie_break_keys,
)
from ashurbanipal.routes import problem_for

FIXTURES_PATH = Path(__file__).resolve().parents[3] / "spec" / "fixtures" / "join-builder-tests.json"
FIXTURES = json.loads(FIXTURES_PATH.read_text())


@dataclass
class Engine:
    """One engine's half of the fixture: how a catalog column row becomes a ColMeta, as that backend builds it."""

    name: str
    dialect: Dialect
    splices_schema: bool  # SQLite has no schema above the database.
    column: Callable[[dict[str, Any]], ColMeta]


def _pg_column(c: dict[str, Any]) -> ColMeta:
    return ColMeta(
        name=c["name"],
        type_name=c["type"],
        column_class=pg_db.column_class(c["data_type"], c["udt_schema"], c["udt_name"], c["is_enum"]),
        compare=pg_db.typed_compare(c["data_type"]),
        collation=c.get("collation"),
    )


def _mysql_column(c: dict[str, Any]) -> ColMeta:
    return ColMeta(
        name=c["name"],
        type_name=c["column_type"],
        column_class=mysql_db.column_class(c["data_type"], c["column_type"]),
        compare=mysql_db.typed_compare(c["data_type"]),
        collation=c.get("collation"),
    )


def _sqlite_column(c: dict[str, Any]) -> ColMeta:
    cls = sqlite_db.column_class(c["declared"])
    return ColMeta(
        name=c["name"],
        type_name=c["declared"] or "unknown",
        column_class=cls,
        compare=sqlite_db.typed_compare(cls),
    )


ENGINES = [
    Engine("postgres", pg_db._JOIN_DIALECT, True, _pg_column),
    Engine("mysql", mysql_db._JOIN_DIALECT, True, _mysql_column),
    Engine("sqlite", sqlite_db._JOIN_DIALECT, False, _sqlite_column),
]

_PLACEHOLDER_RE = re.compile(r"\$\d+|\?")


def _tables(engine: Engine) -> dict[str, TableMeta]:
    out = {}
    for key, t in FIXTURES["catalogs"][engine.name]["tables"].items():
        schema, name = key.split(".", 1)
        columns = [engine.column(c) for c in t["columns"]]
        keys = [UniqueKey(name=k["name"], primary=k["primary"], columns=k["columns"]) for k in t["unique_keys"]]
        out[key] = TableMeta(
            name=name,
            columns=columns,
            schema=schema if engine.splices_schema else None,
            order_keys=tie_break_keys(columns, keys),
        )
    return out


TABLES = {e.name: _tables(e) for e in ENGINES}


def _run(engine: Engine, case: dict[str, Any]) -> dict[str, Any]:
    catalog = FIXTURES["catalogs"][engine.name]
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
            filter=conditions,
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
    return {**want, "sql": _PLACEHOLDER_RE.sub(lambda _m: engine.dialect.placeholder, want["sql"])}


PARAMS = [
    pytest.param(engine, case, id=f"{engine.name}-{case['name']}")
    for engine in ENGINES
    for case in FIXTURES["cases"]
    if "expect_error" in case or engine.name in case["expect"]
]


@pytest.mark.parametrize(("engine", "case"), PARAMS)
def test_join_builder_fixture(engine: Engine, case: dict[str, Any]) -> None:
    assert _run(engine, case) == _expected(engine, case)
