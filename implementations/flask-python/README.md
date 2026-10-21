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

config = Config(enabled=True)
source = PgSource(dsn=os.environ["DATABASE_URL"])

app = Flask(__name__)
app.register_blueprint(router(config, [("primary", source)]))
```

`router` takes an ordered, non-empty sequence of named sources rather
than a single one — a host can register more than one `DbSource` (e.g.
two Postgres databases) and a request's `source` query param selects
which one it targets (`spec/protocol.md` §1, §5.8); the first entry is
the default used when `source` is absent. A single-source deployment
just registers one entry, as above.

`Config()` (the zero-argument default) is disabled by construction:
`enabled` defaults to `False` — a host that forgets to configure anything
gets a 404'd viewer, never one silently enabled with defaults. Ashurbanipal
has zero opinion on what environment it's running in; that's the host's
call entirely.

The optional fields, shown here at their defaults/example values:

```python
from ashurbanipal import Config, Instance, Limits, Sibling

config = Config(
    enabled=True,
    limits=Limits(default_page_size=50, max_page_size=100, query_timeout_secs=5),
    instance=Instance(name="orders", label="dev"),  # spec/protocol.md §5.6
    siblings=[
        Sibling(
            name="orders",
            label="int",
            base_url="https://orders-int.internal.vpn/__ashurbanipal",
            health_path="/health",
        ),
        Sibling(
            name="billing",
            base_url="https://billing.internal.vpn/__ashurbanipal",
            health_path="/health",
        ),
    ],
)
```

Every backend opens one fresh physical connection per operation (no pool)
— this trivially satisfies `spec/protocol.md` §1's "resolve the schema
once per operation" invariant without the explicit transaction-pinning a
pooled driver (Rust's `sqlx::Pool`) needs. A host wanting connection
pooling wraps the driver call inside its own `DbSource` implementation.

## Behind your own auth

Ashurbanipal ships no authentication ([`docs/design.md`](https://github.com/mt-empty/ashurbanipal/blob/main/docs/design.md) §6); guard the mount prefix with your host's own. Cover the whole prefix, UI included, and check a role rather than just a login — otherwise every signed-in user can read every table the database role can.

`router(...)` returns a blueprint, so a blueprint-scoped hook covers only the viewer. Set it before registering:

```python
bp = router(config, [("primary", source)])


@bp.before_request
def require_admin():
    if not is_admin():
        abort(401)


app.register_blueprint(bp)
```

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
