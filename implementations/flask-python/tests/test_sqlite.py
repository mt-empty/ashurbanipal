"""SqliteSource tests, mirroring
`implementations/rust/src/db/sqlite.rs`'s `#[cfg(test)] mod tests`. No
external service needed — every test uses a temp file (not `:memory:`:
`SqliteSource` opens a fresh connection per operation, and SQLite's
`:memory:` database is private per-connection unless using a shared-cache
URI, so a real file is what makes state persist across operations here).
"""

from __future__ import annotations

import os
import sqlite3
import tempfile
import time

import pytest

from ashurbanipal.db import KeyKind, NotAllowed, QueryOpts
from ashurbanipal.db.sqlite import SqliteSource


@pytest.fixture
def seeded_path():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        create table users (id integer primary key, email text not null, age integer);
        create table orders (id integer primary key, user_id integer references users(id), status text not null);
        """
    )
    for email, age in [("a@x.com", 30), ("b@x.com", 30), ("c@x.com", 40)]:
        conn.execute("insert into users (email, age) values (?, ?)", (email, age))
    conn.execute("insert into orders (user_id, status) values (1, 'open')")
    conn.commit()
    conn.close()
    yield path
    os.unlink(path)


def test_list_tables_and_query_table_round_trip(seeded_path) -> None:
    source = SqliteSource(seeded_path)

    tables = source.list_tables(None)
    assert [t.name for t in tables] == ["orders", "users"]
    assert all(t.comment is None for t in tables)

    assert source.list_schemas() == ["main"]
    with pytest.raises(NotAllowed):
        source.list_tables("other")

    data = source.query_table(None, "users", QueryOpts(limit=10, offset=0, timeout_secs=5, sort="age"))
    # No reltuples-equivalent estimate on SQLite; always the -1 sentinel
    # (spec/protocol.md §5.4.4), not a live COUNT(*).
    assert data.total_approx == -1
    assert len(data.rows) == 3
    id_col = next(c for c in data.columns if c.name == "id")
    assert id_col.key == KeyKind.PK
    # Every cell is a string or None (matches Postgres's row rendering
    # contract dbviewer.html relies on).
    for row in data.rows:
        for value in row.values():
            assert value is None or isinstance(value, str)


def test_foreign_key_column_reports_key_and_references(seeded_path) -> None:
    source = SqliteSource(seeded_path)
    data = source.query_table(None, "orders", QueryOpts(limit=10, offset=0, timeout_secs=5))
    user_id_col = next(c for c in data.columns if c.name == "user_id")
    assert user_id_col.key == KeyKind.FK
    assert user_id_col.references.table == "users"
    assert user_id_col.references.column == "id"


def test_table_counts_reports_no_estimate_sentinel(seeded_path) -> None:
    source = SqliteSource(seeded_path)
    assert source.table_counts(None) == [("orders", -1), ("users", -1)]


def test_common_values_is_always_empty(seeded_path) -> None:
    source = SqliteSource(seeded_path)
    assert source.common_values(None, "users", "age") == []


def test_common_values_rejects_unknown_column(seeded_path) -> None:
    source = SqliteSource(seeded_path)
    with pytest.raises(NotAllowed):
        source.common_values(None, "users", "nope")


def test_invalid_utf8_bytes_become_the_undecodable_sentinel(seeded_path) -> None:
    """stdlib sqlite3's default text_factory raises on invalid UTF-8,
    which would otherwise surface as an unhandled 500 instead of the
    protocol-required sentinel (spec/protocol.md §5.4.3).
    """
    conn = sqlite3.connect(seeded_path)
    conn.execute("insert into users (id, email, age) values (99, ?, 50)", (b"\xff\xfe bad bytes",))
    conn.commit()
    conn.close()

    source = SqliteSource(seeded_path)
    data = source.query_table(None, "users", QueryOpts(limit=10, offset=0, timeout_secs=5, sort="id"))
    row = next(r for r in data.rows if r["id"] == "99")
    assert row["email"] == "<undecodable>"


def test_slow_query_is_aborted_by_the_progress_handler_not_left_to_run(seeded_path) -> None:
    """Empirical proof (not just documentation) that
    `Connection.set_progress_handler` actually interrupts a running query,
    same as `sqlite.rs`'s analogous test.
    """
    source = SqliteSource(seeded_path)
    conn = source._connect()
    source._bounded(conn, timeout_secs=1)
    start = time.monotonic()
    with pytest.raises(sqlite3.OperationalError):
        conn.execute(
            "with recursive slow(x) as ("
            "  select 1 union all select x + 1 from slow where x < 100000000"
            ") select count(*) from slow"
        ).fetchone()
    elapsed = time.monotonic() - start
    assert elapsed < 5, f"expected the progress handler to abort near the 1s deadline, took {elapsed}s"
    source._clear_bound(conn)

    # The connection must still be usable afterward — proves the handler
    # was cleared, not left armed with a stale deadline.
    assert conn.execute("select 1").fetchone() == (1,)
    conn.close()
