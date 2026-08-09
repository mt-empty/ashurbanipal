"""MySqlSource integration tests, mirroring
`implementations/rust/src/db/mysql.rs`'s `#[cfg(test)] mod tests`. Runs
against both `MYSQL_TEST_URL` and `MARIADB_TEST_URL` when set (the
devcontainer's `mysql`/`mariadb` services) — each test gets its own
throwaway, nanosecond-suffixed database (mirroring `seeded_db()` in
`mysql.rs`), since neither engine has a `sqlite::memory:`-style disposable
instance. Skips cleanly per URL that isn't set.
"""

from __future__ import annotations

import os
import time

import pymysql
import pytest

from ashurbanipal.db import KeyKind, NotAllowed, QueryOpts
from ashurbanipal.db.mysql import _MARIADB, MySqlSource, connect_kwargs_from_url

pytestmark = pytest.mark.mysql

_URLS = {
    "mysql": os.environ.get("MYSQL_TEST_URL"),
    "mariadb": os.environ.get("MARIADB_TEST_URL"),
}
_AVAILABLE = [name for name, url in _URLS.items() if url]


def _admin_connect(url: str) -> pymysql.connections.Connection:
    kwargs = connect_kwargs_from_url(url)
    kwargs["database"] = None
    return pymysql.connect(**kwargs)


class _SeededDb:
    def __init__(self, url: str):
        name = f"ashurbanipal_test_{time.time_ns()}"
        admin = _admin_connect(url)
        with admin.cursor() as cur:
            cur.execute(f"create database `{name}`")
        admin.commit()
        admin.close()

        self.name = name
        self.kwargs = {**connect_kwargs_from_url(url), "database": name}
        conn = pymysql.connect(**self.kwargs)
        with conn.cursor() as cur:
            cur.execute(
                "create table users (id integer primary key auto_increment, "
                "email varchar(255) not null, age integer)"
            )
            cur.execute(
                "create table orders (id integer primary key auto_increment, user_id integer, "
                "status varchar(50) not null, "
                "constraint fk_orders_user foreign key (user_id) references users(id))"
            )
            for email, age in [("a@x.com", 30), ("b@x.com", 30), ("c@x.com", 40)]:
                cur.execute("insert into users (email, age) values (%s, %s)", (email, age))
            cur.execute("insert into orders (user_id, status) values (1, 'open')")
        conn.commit()
        conn.close()

    def drop(self, url: str) -> None:
        admin = _admin_connect(url)
        with admin.cursor() as cur:
            cur.execute(f"drop database `{self.name}`")
        admin.commit()
        admin.close()


@pytest.fixture(params=_AVAILABLE)
def variant_url(request):
    if not _AVAILABLE:
        pytest.skip("neither MYSQL_TEST_URL nor MARIADB_TEST_URL is set")
    return _URLS[request.param]


class _Seeded:
    def __init__(self, source: MySqlSource, kwargs: dict):
        self.source = source
        self.kwargs = kwargs

    # Delegate DbSource calls so most tests can use `seeded.list_tables(...)`
    # directly, same ergonomics as the SqliteSource/PgSource fixtures.
    def __getattr__(self, name):
        return getattr(self.source, name)


@pytest.fixture
def seeded(variant_url):
    db = _SeededDb(variant_url)
    yield _Seeded(MySqlSource(**db.kwargs), db.kwargs)
    db.drop(variant_url)


def test_list_tables_and_query_table_round_trip(seeded) -> None:
    tables = seeded.list_tables(None)
    assert [t.name for t in tables] == ["orders", "users"]
    assert all(t.comment is None for t in tables)

    with pytest.raises(NotAllowed):
        seeded.list_tables("no_such_schema")

    data = seeded.query_table(None, "users", QueryOpts(limit=10, offset=0, timeout_secs=5, sort="age"))
    assert len(data.rows) == 3
    id_col = next(c for c in data.columns if c.name == "id")
    assert id_col.key == KeyKind.PK
    for row in data.rows:
        for value in row.values():
            assert value is None or isinstance(value, str)


def test_foreign_key_column_reports_key_and_references(seeded) -> None:
    data = seeded.query_table(None, "orders", QueryOpts(limit=10, offset=0, timeout_secs=5))
    user_id_col = next(c for c in data.columns if c.name == "user_id")
    assert user_id_col.key == KeyKind.FK
    assert user_id_col.references.table == "users"
    assert user_id_col.references.column == "id"


def test_table_counts_reports_a_real_estimate(seeded) -> None:
    conn = pymysql.connect(**seeded.kwargs)
    with conn.cursor() as cur:
        cur.execute("analyze table users")
    conn.commit()
    conn.close()

    counts = dict(seeded.table_counts(None))
    # Unlike SQLite's unconditional -1, MySQL/MariaDB have a real
    # TABLE_ROWS estimate.
    assert counts["users"] >= 0


def test_common_values_is_always_empty(seeded) -> None:
    assert seeded.common_values(None, "users", "age") == []


def test_common_values_rejects_unknown_column(seeded) -> None:
    with pytest.raises(NotAllowed):
        seeded.common_values(None, "users", "nope")


def test_invalid_utf8_bytes_do_not_crash_the_query(seeded) -> None:
    """`CAST(col AS CHAR)` on a VARBINARY column holding non-UTF-8 bytes is
    sanitized server-side before it ever reaches the client — MySQL nulls
    the cast result, MariaDB substitutes `?` for the invalid bytes — so
    PyMySQL's decode never actually sees raw invalid bytes here. This just
    guards the `conn.use_unicode = False` / per-cell decode path (added
    for parity with mysql.rs's `Err(_) => "<undecodable>"`) against ever
    raising should that server-side sanitizing assumption stop holding.
    """
    conn = pymysql.connect(**seeded.kwargs)
    with conn.cursor() as cur:
        cur.execute("create table blobs (id integer primary key, val varbinary(32))")
        cur.execute("insert into blobs (id, val) values (1, %s)", (b"\xff\xfe bad bytes",))
    conn.commit()
    conn.close()

    data = seeded.query_table(None, "blobs", QueryOpts(limit=10, offset=0, timeout_secs=5))
    assert len(data.rows) == 1
    for value in data.rows[0].values():
        assert value is None or isinstance(value, str)


def test_slow_query_is_aborted_by_the_timeout_mechanism(seeded) -> None:
    """Empirical proof (not just documentation) that both forks' per-query
    timeout mechanisms actually abort a running query — mirrors
    `mysql.rs`'s analogous test, including the MariaDB
    `max_recursive_iterations` bump (MariaDB caps `WITH RECURSIVE` at 1000
    rows by default regardless of `max_statement_time`, which would let
    the CTE finish before the 1s timeout ever gets a chance to fire).
    """
    conn = pymysql.connect(**seeded.kwargs)
    variant = seeded.source._variant_of(conn)
    with conn.cursor() as cur:
        if variant == _MARIADB:
            cur.execute("set session max_recursive_iterations = 100000000")

        from ashurbanipal.db.mysql import _timed_select

        sql = _timed_select(
            variant,
            1,
            "count(*) from ("
            "  with recursive slow(x) as ("
            "    select 1 union all select x + 1 from slow where x < 100000000"
            "  ) select x from slow"
            ") t",
        )
        with pytest.raises(pymysql.err.OperationalError):
            cur.execute(sql)
            cur.fetchone()

        # The same connection must still be usable afterward — proves both
        # forks' mechanisms are self-resetting.
        cur.execute("select 1")
        assert cur.fetchone() == (1,)
    conn.close()
