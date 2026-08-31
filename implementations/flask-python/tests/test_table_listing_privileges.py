"""Table listing / allow-list privilege gate against seeded Postgres.

Non-selectable tables are excluded and residual SELECT denial maps to NotAllowed
(`spec/protocol.md` §5.2).
"""

from __future__ import annotations

import os

import psycopg
import pytest
from psycopg.conninfo import make_conninfo

from ashurbanipal.db import NotAllowed, QueryOpts
from ashurbanipal.db.postgres import PgSource

DATABASE_URL = os.environ.get("DATABASE_URL")
pytestmark = [
    pytest.mark.postgres,
    pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL not set"),
]

SCHEMA = "ashb_test_table_privileges"
ROLE = "ashb_test_table_privileges_role"


@pytest.fixture
def limited_source():
    """A PgSource whose sessions run as ROLE — USAGE on SCHEMA, SELECT on
    only one of its three tables."""
    with psycopg.connect(DATABASE_URL, autocommit=True) as admin, admin.cursor() as cur:
        cur.execute(f"drop schema if exists {SCHEMA} cascade")
        cur.execute(f"drop role if exists {ROLE}")
        cur.execute(f"create role {ROLE} nosuperuser")
        # Lets this session (and PgSource's) `set role` to it via `options`.
        cur.execute(f"grant {ROLE} to current_user")
        cur.execute(f"create schema {SCHEMA}")
        cur.execute(f"grant usage on schema {SCHEMA} to {ROLE}")
        cur.execute(f"create table {SCHEMA}.readable (id int primary key, name text)")
        cur.execute(f"insert into {SCHEMA}.readable values (1, 'a'), (2, 'b')")
        cur.execute(f"create table {SCHEMA}.write_only (id int primary key)")
        cur.execute(f"create table {SCHEMA}.no_grant (id int primary key)")
        cur.execute(f"grant select on {SCHEMA}.readable to {ROLE}")
        cur.execute(f"grant insert on {SCHEMA}.write_only to {ROLE}")
        try:
            yield PgSource(make_conninfo(DATABASE_URL, options=f"-c role={ROLE}"))
        finally:
            cur.execute(f"drop schema if exists {SCHEMA} cascade")
            cur.execute(f"drop role if exists {ROLE}")


def _opts() -> QueryOpts:
    return QueryOpts(limit=10, offset=0, timeout_secs=5)


def test_list_tables_and_counts_omit_non_selectable(limited_source) -> None:
    assert [t.name for t in limited_source.list_tables(SCHEMA)] == ["readable"]
    assert [row[0] for row in limited_source.table_counts(SCHEMA)] == ["readable"]


def test_selectable_table_queries(limited_source) -> None:
    data = limited_source.query_table(SCHEMA, "readable", _opts())
    assert len(data.rows) == 2


def test_insert_only_table_rejected_as_not_allowed(limited_source) -> None:
    with pytest.raises(NotAllowed):
        limited_source.query_table(SCHEMA, "write_only", _opts())


def test_no_privilege_table_rejected_as_not_allowed(limited_source) -> None:
    with pytest.raises(NotAllowed):
        limited_source.query_table(SCHEMA, "no_grant", _opts())
