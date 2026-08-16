# ashurbanipal (flask-python)

A Flask port of [Ashurbanipal](../../readme.md) — implements the same
`spec/protocol.md` + `spec/openapi.yaml` contract as the Rust reference and
the Kotlin/Spring Boot, Go/`net-http`, and Node/Express ports. Ships three
backends from day one: Postgres (`psycopg`), SQLite (stdlib `sqlite3`),
and MySQL/MariaDB (`PyMySQL`) — see `ashurbanipal/db/`.

```sh
uv add ashurbanipal-flask       # or: pip install ashurbanipal-flask
```

## Usage

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

Every backend opens one fresh physical connection per operation (no pool)
— this trivially satisfies `spec/protocol.md` §1's "resolve the schema
once per operation" invariant without the explicit transaction-pinning a
pooled driver (Rust's `sqlx::Pool`) needs. A host wanting connection
pooling wraps the driver call inside its own `DbSource` implementation.

## Database support

Same per-backend degraded features and mechanisms as the Rust reference
(comments/common-values unavailable on SQLite and MySQL, MySQL-vs-MariaDB
runtime detection for the query-timeout mechanism) — see
`docs/adapter-decisions.md` for the full registry. `SqliteSource` needs a
real file path, not `:memory:`: SQLite's in-memory database is private
per-connection, and this backend reconnects on every operation, so
`:memory:` would be empty again on the next call.

```sh
ASHURBANIPAL_BACKEND=sqlite ASHURBANIPAL_SQLITE_PATH=./demo.db uv run python demo/app.py
ASHURBANIPAL_BACKEND=mysql MYSQL_TEST_URL=mysql://root:pw@host:3306/db uv run python demo/app.py
```

Full API/config reference:
[docs/design.md](https://github.com/mt-empty/ashurbanipal/blob/main/docs/design.md).
