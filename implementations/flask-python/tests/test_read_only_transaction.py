"""Every operation runs in a read-only transaction (`spec/protocol.md` §6).

A row-level security policy that calls a writing function is the one way a
plain SELECT on a listed table can write. RLS does not apply to a superuser,
so the source's sessions start as an ordinary role.
"""

from __future__ import annotations

import psycopg
import pytest
from _env import require_env
from psycopg.conninfo import make_conninfo

from ashurbanipal.db import DatabaseError, QueryOpts
from ashurbanipal.db.postgres import PgSource

DATABASE_URL = require_env("DATABASE_URL")
pytestmark = [
    pytest.mark.postgres,
    pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL not set"),
]

SCHEMA = "ashb_test_flask_read_only_tx"
ROLE = "ashb_test_flask_read_only_tx_role"


@pytest.fixture
def admin_and_role_source():
    with psycopg.connect(DATABASE_URL, autocommit=True) as admin, admin.cursor() as cur:
        cur.execute(f"drop schema if exists {SCHEMA} cascade")
        cur.execute(f"drop role if exists {ROLE}")
        cur.execute(f"create role {ROLE} nosuperuser")
        cur.execute(f"grant {ROLE} to current_user")
        cur.execute(f"create schema {SCHEMA}")
        cur.execute(f"grant usage on schema {SCHEMA} to {ROLE}")
        # The role may insert, so only the read-only transaction stops the write.
        cur.execute(f"create table {SCHEMA}.audit (id serial primary key)")
        cur.execute(f"grant insert on {SCHEMA}.audit to {ROLE}")
        cur.execute(f"grant usage on sequence {SCHEMA}.audit_id_seq to {ROLE}")
        cur.execute(
            f"create function {SCHEMA}.log_read() returns boolean language sql volatile "
            f"as $$ insert into {SCHEMA}.audit default values; select true $$"
        )
        cur.execute(f"create table {SCHEMA}.watched (id int primary key)")
        cur.execute(f"insert into {SCHEMA}.watched values (1)")
        cur.execute(f"alter table {SCHEMA}.watched enable row level security")
        cur.execute(
            f"create policy log_every_read on {SCHEMA}.watched for select to {ROLE} using ({SCHEMA}.log_read())"
        )
        cur.execute(f"grant select on {SCHEMA}.watched to {ROLE}")
        try:
            yield cur, PgSource(make_conninfo(DATABASE_URL, options=f"-c role={ROLE}"))
        finally:
            cur.execute(f"drop schema if exists {SCHEMA} cascade")
            cur.execute(f"drop role if exists {ROLE}")


def test_a_select_that_would_write_fails_and_writes_nothing(admin_and_role_source) -> None:
    admin, source = admin_and_role_source
    with pytest.raises(DatabaseError) as exc_info:
        source.query_table(SCHEMA, "watched", QueryOpts(limit=10, offset=0, timeout_secs=5))
    cause = exc_info.value.__cause__
    assert isinstance(cause, psycopg.Error)
    assert cause.sqlstate == "25006"
    admin.execute(f"select count(*) from {SCHEMA}.audit")
    assert admin.fetchone() == (0,)
