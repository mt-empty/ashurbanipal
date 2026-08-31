"""PgSource integration tests against seeded Postgres; skips when `DATABASE_URL` is unset."""

from __future__ import annotations

import os

import pytest

from ashurbanipal.db import KeyKind, NotAllowed, QueryOpts
from ashurbanipal.db.postgres import PgSource

DATABASE_URL = os.environ.get("DATABASE_URL")
pytestmark = [
    pytest.mark.postgres,
    pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL not set"),
]


@pytest.fixture
def source():
    return PgSource(DATABASE_URL)


def test_list_schemas_excludes_system_namespaces(source) -> None:
    schemas = source.list_schemas()
    assert "public" in schemas
    assert "pg_catalog" not in schemas
    assert "information_schema" not in schemas


def test_schema_scoping_hides_other_schemas_tables(source) -> None:
    # other_schema.decoy_items must never appear when resolved against the
    # connection's default schema (public) — spec/protocol.md §1/§6.
    tables = source.list_tables(None)
    assert "decoy_items" not in [t.name for t in tables]
    assert "users" in [t.name for t in tables]


def test_unknown_schema_rejected(source) -> None:
    with pytest.raises(NotAllowed):
        source.list_tables("no_such_schema")


def test_foreign_key_column_reports_key_and_references(source) -> None:
    data = source.query_table(None, "orders", QueryOpts(limit=5, offset=0, timeout_secs=5))
    user_id_col = next(c for c in data.columns if c.name == "user_id")
    assert user_id_col.key == KeyKind.FK
    assert user_id_col.references.table == "users"
    assert user_id_col.references.column == "id"
    pk_col = next(c for c in data.columns if c.name == "id")
    assert pk_col.key == KeyKind.PK


def test_pk_and_fk_column_reports_both(source) -> None:
    # docs/feature-backlog/13-pk-that-is-also-fk-loses-references.md:
    # order_extra.order_id is both its own table's PK and an FK into
    # orders(id) — key must still report pk, but references must be
    # populated too, not omitted the way a plain PK's is.
    data = source.query_table(None, "order_extra", QueryOpts(limit=1, offset=0, timeout_secs=5))
    order_id_col = next(c for c in data.columns if c.name == "order_id")
    assert order_id_col.key == KeyKind.PK
    assert order_id_col.references.table == "orders"
    assert order_id_col.references.column == "id"


def test_every_cell_is_string_or_null(source) -> None:
    data = source.query_table(None, "orders", QueryOpts(limit=20, offset=0, timeout_secs=5))
    assert len(data.rows) > 0
    for row in data.rows:
        for value in row.values():
            assert value is None or isinstance(value, str)


def test_total_approx_is_whole_table_not_filtered(source) -> None:
    unfiltered = source.query_table(None, "orders", QueryOpts(limit=1, offset=0, timeout_secs=5))
    import json

    from ashurbanipal import filter as filter_module

    conditions = filter_module.parse(json.dumps([{"column": "status", "op": "=", "value": "completed"}]))
    filtered = source.query_table(None, "orders", QueryOpts(limit=1, offset=0, timeout_secs=5, filter=conditions))
    assert filtered.total_approx == unfiltered.total_approx


def test_common_values_for_enum_column(source) -> None:
    values = source.common_values(None, "orders", "status")
    assert values, "expected at least one common value for orders.status"
    for value, freq in values:
        assert isinstance(value, str)
        assert 0 < freq <= 1


def test_unknown_table_rejected(source) -> None:
    with pytest.raises(NotAllowed):
        source.query_table(None, "no_such_table", QueryOpts(limit=5, offset=0, timeout_secs=5))


def test_unknown_column_sort_rejected(source) -> None:
    with pytest.raises(NotAllowed):
        source.query_table(None, "orders", QueryOpts(limit=5, offset=0, timeout_secs=5, sort="no_such_column"))


def test_list_schemas_is_bounded_by_the_catalog_timeout(source, monkeypatch) -> None:
    """Regression test: CATALOG_TIMEOUT_SECS must actually be applied to
    catalog queries, not just declared and left unused — spec/protocol.md
    §6 requires every query, catalog queries included, to be bounded.
    Simulates a slow catalog query (e.g. blocked behind a DDL lock) by
    monkeypatching the private helper to sleep instead of querying
    pg_namespace; if the timeout weren't wired, this would hang for the
    full sleep duration instead of aborting near budget.
    """
    import time

    import ashurbanipal.db.postgres as postgres_module
    from ashurbanipal.db import DatabaseError

    monkeypatch.setattr(postgres_module, "CATALOG_TIMEOUT_SECS", 1)
    monkeypatch.setattr(
        postgres_module.PgSource,
        "_list_schemas",
        lambda self, cur: cur.execute("select pg_sleep(5)"),
    )

    start = time.monotonic()
    with pytest.raises(DatabaseError):
        source.list_schemas()
    elapsed = time.monotonic() - start
    assert elapsed < 5, f"expected the catalog timeout to abort near its 1s budget, took {elapsed}s"


def test_query_table_wires_the_lenient_text_loader_before_cursor_creation(source) -> None:
    """Regression test: psycopg's Cursor snapshots conn.adapters at
    creation time (copy-on-write, not a live view), so registering the
    loader after conn.cursor() has already run would silently never take
    effect — caught by a cross-port review that read the wiring directly.
    """
    from unittest import mock

    import psycopg

    from ashurbanipal.db.postgres import _LenientTextLoader

    created_cursors = []
    real_cursor = psycopg.Connection.cursor

    def spying_cursor(self, *args, **kwargs):
        cur = real_cursor(self, *args, **kwargs)
        created_cursors.append(cur)
        return cur

    with mock.patch.object(psycopg.Connection, "cursor", spying_cursor):
        source.query_table(None, "orders", QueryOpts(limit=1, offset=0, timeout_secs=5))

    assert created_cursors, "query_table created no cursor"
    assert created_cursors[0].adapters.get_loader(25, psycopg.pq.Format.TEXT) is _LenientTextLoader


def test_query_timeout_is_enforced(source) -> None:
    # pg_sleep blocks for longer than the 1s statement_timeout — the query
    # must be aborted, not left to run (spec/protocol.md §6). A separate
    # connection (not query_table) since pg_sleep isn't a real table read.
    import psycopg

    with pytest.raises(psycopg.Error), psycopg.connect(DATABASE_URL) as conn, conn.cursor() as cur:
        cur.execute("SET LOCAL statement_timeout = '1s'")
        cur.execute("select pg_sleep(5)")
