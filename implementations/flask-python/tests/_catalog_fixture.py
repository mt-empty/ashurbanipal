"""Engine-native catalogs from `spec/fixtures/catalogs.json`, shared by the join and filter fixture runners."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ashurbanipal.db import mysql as mysql_db
from ashurbanipal.db import postgres as pg_db
from ashurbanipal.db import sqlite as sqlite_db
from ashurbanipal.join import ColMeta, Dialect, TableMeta, UniqueKey, tie_break_keys

FIXTURES_DIR = Path(__file__).resolve().parents[3] / "spec" / "fixtures"
CATALOGS = json.loads((FIXTURES_DIR / "catalogs.json").read_text())["catalogs"]


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


def tables(engine: Engine) -> dict[str, TableMeta]:
    out = {}
    for key, t in CATALOGS[engine.name]["tables"].items():
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


TABLES = {e.name: tables(e) for e in ENGINES}

_PLACEHOLDER_RE = re.compile(r"\$\d+|\?")


def native_placeholders(engine: Engine, sql: str) -> str:
    """Fixture SQL uses `$N` (Postgres) or `?` placeholders; swap each for the dialect's own."""
    return _PLACEHOLDER_RE.sub(lambda _m: engine.dialect.placeholder, sql)
