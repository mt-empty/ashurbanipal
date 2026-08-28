"""MySQL/MariaDB analog of `test_table_listing_privileges.py`.

Neither engine has a `has_table_privilege` function, and no cheap
role-aware way to narrow `information_schema.tables` to SELECT-able tables
(see `docs/adapter-decisions.md` §5.2/§5.3), so the listing is *not*
gated — an INSERT-only table still appears. What must hold: a residual
`ER_TABLEACCESS_DENIED_ERROR` (1142, both engines) at the row fetch is
raised as `NotAllowed` (400), never a raw driver 500. Runs against both
`MYSQL_TEST_URL` and `MARIADB_TEST_URL` when set.
"""

from __future__ import annotations

import os

import pymysql
import pytest

from ashurbanipal.db import NotAllowed, QueryOpts
from ashurbanipal.db.mysql import MySqlSource, connect_kwargs_from_url

pytestmark = pytest.mark.mysql

SCHEMA = "ashb_test_table_privileges"
USER = "ashb_test_table_privileges_user"
PASSWORD = "ashb_test_pw"

_URLS = {"mysql": os.environ.get("MYSQL_TEST_URL"), "mariadb": os.environ.get("MARIADB_TEST_URL")}
_AVAILABLE = [name for name, url in _URLS.items() if url]


@pytest.fixture(params=_AVAILABLE)
def limited_source(request):
    """A MySqlSource connecting as USER — SELECT on only one of SCHEMA's
    three tables, INSERT on a second, nothing on the third."""
    if not _AVAILABLE:
        pytest.skip("neither MYSQL_TEST_URL nor MARIADB_TEST_URL is set")
    url = _URLS[request.param]
    admin_kwargs = {**connect_kwargs_from_url(url), "database": None}
    admin = pymysql.connect(**admin_kwargs)
    with admin.cursor() as cur:
        cur.execute(f"drop database if exists {SCHEMA}")
        cur.execute(f"drop user if exists '{USER}'@'%'")
        cur.execute(f"create database {SCHEMA}")
        cur.execute(f"create user '{USER}'@'%' identified by '{PASSWORD}'")
        cur.execute(f"create table {SCHEMA}.readable (id int primary key, name varchar(50))")
        cur.execute(f"insert into {SCHEMA}.readable values (1, 'a'), (2, 'b')")
        cur.execute(f"create table {SCHEMA}.write_only (id int primary key)")
        cur.execute(f"create table {SCHEMA}.no_grant (id int primary key)")
        cur.execute(f"grant select on {SCHEMA}.readable to '{USER}'@'%'")
        cur.execute(f"grant insert on {SCHEMA}.write_only to '{USER}'@'%'")
    admin.commit()

    source_kwargs = {**connect_kwargs_from_url(url), "user": USER, "password": PASSWORD, "database": SCHEMA}
    try:
        yield MySqlSource(**source_kwargs)
    finally:
        with admin.cursor() as cur:
            cur.execute(f"drop database if exists {SCHEMA}")
            cur.execute(f"drop user if exists '{USER}'@'%'")
        admin.commit()
        admin.close()


def _opts() -> QueryOpts:
    return QueryOpts(limit=10, offset=0, timeout_secs=5)


def test_listing_still_shows_insert_only_table_but_not_zero_privilege(limited_source) -> None:
    names = [t.name for t in limited_source.list_tables(SCHEMA)]
    assert "readable" in names
    # Documented gap — if write_only ever stops appearing, update
    # docs/adapter-decisions.md.
    assert "write_only" in names
    assert "no_grant" not in names


def test_selectable_table_queries(limited_source) -> None:
    assert len(limited_source.query_table(SCHEMA, "readable", _opts()).rows) == 2


def test_insert_only_table_rejected_as_not_allowed(limited_source) -> None:
    with pytest.raises(NotAllowed):
        limited_source.query_table(SCHEMA, "write_only", _opts())


def test_no_privilege_table_rejected_as_not_allowed(limited_source) -> None:
    with pytest.raises(NotAllowed):
        limited_source.query_table(SCHEMA, "no_grant", _opts())
