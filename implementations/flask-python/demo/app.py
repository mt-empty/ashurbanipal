"""The living usage example and conformance harness for the Flask port —
the host service embedding Ashurbanipal, mirroring
`implementations/rust/examples/demo.rs` and the Go/Node ports' `cmd/demo`/
`demo/main.ts`.

Backend selection via `ASHURBANIPAL_BACKEND` (default `postgres`):

    python demo/app.py                              # postgres, needs DATABASE_URL
    ASHURBANIPAL_BACKEND=sqlite ASHURBANIPAL_SQLITE_PATH=./demo.db python demo/app.py
    ASHURBANIPAL_BACKEND=mysql MYSQL_TEST_URL=mysql://... python demo/app.py

Then open http://localhost:4000/__ashurbanipal. To demo sibling
health-polling, run a second instance:

    PORT=4001 SIBLING_PORT=4000 python demo/app.py

`CONFORMANCE_SECOND_SOURCE=1` (postgres backend only) registers a second
source, `other_schema`, for `conformance/runner/two_source.rs`: no second
database, just the same connection pinned to the `other_schema` schema
already seeded alongside `public`. Every port's own demo understands this
env var the same way; see that file's module doc.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from flask import Flask, Response, redirect

from ashurbanipal import Config, Sibling, router


def _env_int(name: str, fallback: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return fallback
    return int(raw)


def _postgres_dsn() -> str:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL must be set (the devcontainer sets it automatically)")
    return dsn


def _build_source(backend: str):
    if backend == "postgres":
        from ashurbanipal.db.postgres import PgSource

        return PgSource(_postgres_dsn())
    if backend == "sqlite":
        from ashurbanipal.db.sqlite import SqliteSource

        path = os.environ.get("ASHURBANIPAL_SQLITE_PATH", "./ashurbanipal-demo.db")
        return SqliteSource(path)
    if backend == "mysql":
        from ashurbanipal.db.mysql import MySqlSource, connect_kwargs_from_url

        url = os.environ.get("MYSQL_TEST_URL") or os.environ.get("MARIADB_TEST_URL")
        if not url:
            raise RuntimeError("MYSQL_TEST_URL or MARIADB_TEST_URL must be set for ASHURBANIPAL_BACKEND=mysql")
        return MySqlSource(**connect_kwargs_from_url(url))
    raise RuntimeError(f"unknown ASHURBANIPAL_BACKEND {backend!r} (expected postgres|sqlite|mysql)")


def _conformance_second_source(backend: str):
    """conformance/runner/two_source.rs (shared across every port) proves a
    second registered source actually routes; `other_schema` already ships
    in the Postgres seed with exactly one table, `decoy_items`, so pinning a
    second connection there needs no second database. Postgres-only — the
    sqlite/mysql seeds have no `other_schema` — and a no-op unless the CI
    job opts in via CONFORMANCE_SECOND_SOURCE.
    """
    if backend != "postgres" or not os.environ.get("CONFORMANCE_SECOND_SOURCE"):
        return None
    from ashurbanipal.db.postgres import PgSource

    dsn = _postgres_dsn()
    # libpq's "options" DSN param sends `-c search_path=...` at connection
    # start, so every fresh per-operation connection (PgSource opens no
    # pool) resolves against other_schema without touching PgSource itself.
    sep = "&" if "?" in dsn else "?"
    pinned_dsn = f"{dsn}{sep}options=-c%20search_path%3Dother_schema"
    return ("other_schema", PgSource(pinned_dsn))


def main() -> None:
    port = _env_int("PORT", 4000)
    backend = os.environ.get("ASHURBANIPAL_BACKEND", "postgres")
    source = _build_source(backend)

    config = Config(enabled=True)
    sibling_port = os.environ.get("SIBLING_PORT")
    if sibling_port:
        config.siblings = [
            Sibling(
                name=f"demo-{sibling_port}",
                dbviewer_url=f"http://localhost:{sibling_port}/__ashurbanipal",
                health_path="/health",
            )
        ]

    app = Flask(__name__)

    @app.get("/health")
    def health() -> Response:
        return Response("ok", mimetype="text/plain")

    @app.get("/")
    def index():
        return redirect("/__ashurbanipal", code=307)

    sources = [("primary", source)]
    second = _conformance_second_source(backend)
    if second is not None:
        sources.append(second)
    app.register_blueprint(router(config, sources))

    print(f"demo host on http://localhost:{port} — browser at http://localhost:{port}/__ashurbanipal")
    app.run(host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
