# ashurbanipal (flask-python)

A Flask port of [Ashurbanipal](../../readme.md) — implements the same
`spec/protocol.md` + `spec/openapi.yaml` contract as the Rust reference and
the Kotlin/Spring Boot, Go/`net-http`, and Node/Express ports. Ships three
backends from day one: Postgres (`psycopg`), SQLite (stdlib `sqlite3`),
and MySQL/MariaDB (`PyMySQL`) — see `ashurbanipal/db/`.

```sh
uv add ashurbanipal-flask       # or: pip install ashurbanipal-flask
```

```python
from flask import Flask
from ashurbanipal import Config, router
from ashurbanipal.db.postgres import PgSource

# raises ProductionEnabledError for a production-like value
config = Config(environment="dev", enabled_for=["dev"])
source = PgSource(dsn=os.environ["DATABASE_URL"])

app = Flask(__name__)
app.register_blueprint(router(config, source))
```

`Config()` (the zero-argument default) is disabled by construction:
`enabled_for` is empty, so `is_enabled()` is `False` regardless of
`environment` — a host that forgets to configure anything gets a 404'd
viewer, never one silently enabled with defaults.

## Layout

- `ashurbanipal/config.py` — `Config`/`Limits`/`Sibling`, the fail-closed
  kill switch.
- `ashurbanipal/db/__init__.py` — the `DbSource` `abc.ABC` interface +
  shared dataclasses (`ColumnInfo`, `TableInfo`, `TableData`, ...) + the
  Postgres/SQLite `quote_ident` helper.
- `ashurbanipal/db/postgres.py` / `sqlite.py` / `mysql.py` — one
  implementation per backend, each ported line-for-line against
  `implementations/rust/src/db/postgres.rs` / `sqlite.rs` / `mysql.rs`'s
  catalog SQL. Every backend opens **one fresh physical connection per
  operation** (no connection pool) — see `db/__init__.py`'s docstring for
  why this trivially satisfies `spec/protocol.md` §1's "resolve the schema
  once per operation, immune to pool session drift" invariant, without
  needing the explicit transaction-pinning Rust's pooled `sqlx::Pool`
  requires. A host wanting connection pooling can wrap the driver call
  inside its own `DbSource` implementation; this port's three backends
  deliberately favor correctness-by-construction and simplicity over pool
  throughput for a reference implementation.
- `ashurbanipal/filter.py` — the filter AST's structural validation,
  ported against `implementations/rust/src/filter.rs`. WHERE-clause
  building is per-backend (each `db/*.py`'s own `_build_where_clause`),
  since cast syntax/placeholder style/operator mapping all differ by
  engine (`docs/adapter-decisions.md`).
- `ashurbanipal/routes.py` — `router(config, source, mount)` and the six
  Flask view functions.
- `ashurbanipal/embed.py` — the vendored `frontend/dbviewer.html`,
  sha256-reverified on every import (see "Vendoring" below).
- `demo/app.py` — the runnable example host, `uv run python demo/app.py`.

## Backends

Set `ASHURBANIPAL_BACKEND` (default `postgres`) before running `demo/app.py`:

```sh
uv run python demo/app.py                                                    # postgres, needs DATABASE_URL
ASHURBANIPAL_BACKEND=sqlite ASHURBANIPAL_SQLITE_PATH=./demo.db uv run python demo/app.py
ASHURBANIPAL_BACKEND=mysql MYSQL_TEST_URL=mysql://root:pw@host:3306/db uv run python demo/app.py  # or MARIADB_TEST_URL
```

`SqliteSource` needs a real file path, not `:memory:` — SQLite's in-memory
database is private per-connection, and this backend opens a fresh
connection per operation (see above), so a `:memory:` "database" would be
empty again on the very next call.

The MySQL backend detects MySQL vs. MariaDB once per `MySqlSource`
(`SELECT VERSION()`, cached) and branches its per-query timeout mechanism
accordingly — `MAX_EXECUTION_TIME(ms)` inline hint on MySQL, `SET STATEMENT
max_statement_time=N FOR SELECT ...` on MariaDB (MariaDB silently ignores
the MySQL hint rather than erroring on it, which would fail the timeout
open if reused unchanged). Verified empirically against both engines in
`tests/test_mysql_integration.py::test_slow_query_is_aborted_by_the_timeout_mechanism`.

## Tests

```sh
uv sync --extra dev
uv run pytest -q
```

- `tests/test_filter_fixtures.py` — the shared
  `spec/fixtures/filter-builder-tests.json` table, run against the
  Postgres backend's `_build_where_clause` (the one backend the Rust
  reference also runs the shared fixture file against directly;
  `sqlite.rs`/`mysql.rs` get their own hand-written tests instead, and
  this port follows the same split).
- `tests/test_config.py` / `test_killswitch.py` — no external service.
  `test_config.py::test_default_config_is_disabled` and
  `test_missing_environment_key_raises` are this port's kill-switch
  tests (`PORTING.md` hardening item 2 — conformance can't observe
  either over HTTP).
- `tests/test_sqlite.py` — no external service (temp file), including an
  empirical proof (a real slow `WITH RECURSIVE` query, not just reading
  the docs) that `sqlite3.Connection.set_progress_handler` actually
  interrupts a running query.
- `tests/test_postgres_integration.py` — needs `DATABASE_URL` with
  `conformance/seed/seed.sql` applied; skips cleanly otherwise.
- `tests/test_mysql_integration.py` — needs `MYSQL_TEST_URL` and/or
  `MARIADB_TEST_URL`; skips cleanly otherwise. Each test creates its own
  throwaway, nanosecond-suffixed database (mirroring `seeded_db()` in
  `mysql.rs`), since neither engine has a `sqlite::memory:`-style
  disposable instance.

## Conformance

```sh
uv run python demo/app.py &
ASHURBANIPAL_CONFORMANCE_URL=http://localhost:4000/__ashurbanipal bash ../../conformance/runner/report.sh
ASHURBANIPAL_CONFORMANCE_URL=http://localhost:4000/__ashurbanipal bash ../../conformance/runner/schema-check.sh
```

Both pass against the Postgres backend (45/45 behavior-conformance
requirements, 0 failures; schemathesis 558/558 generated cases). SQLite
and MySQL/MariaDB aren't run through `conformance/runner` — that suite
targets Postgres specifically (same scope decision the Rust reference's
own `sqlite`/`mysql` Cargo features make, see `docs/adapter-decisions.md`'s
"Status note") — each has its own unit/integration test suite instead
(above).

## Vendoring

`frontend/dbviewer.html` is vendored per `PORTING.md`'s "Vendoring the
frontend" section: this repository's own copy (no separate tagged release
exists to vendor from yet, same caveat the Go and Node ports document),
sha256-pinned in `ashurbanipal/embed.py` and re-verified on every process
start (`import ashurbanipal.embed` raises on a mismatch) — not just
recorded once at vendoring time. No separate `NOTICE` file: this port is
vendored inside a clone of the repository itself, so `LICENSE` already
travels with it (same as the Go and Node ports).

## CSP note

Per `PORTING.md`, this port takes the same option the Rust reference and
every other port take: it sets no `Content-Security-Policy` header and
injects no nonce. A host running under a strict CSP forbidding inline
scripts must extend it for the mount path before the UI's inline
`<script type="module">` will execute client-side.
