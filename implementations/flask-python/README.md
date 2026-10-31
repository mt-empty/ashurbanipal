# ashurbanipal-flask

A read-only database browser you mount inside your own [Flask](https://flask.palletsprojects.com) app. It connects with your app's database settings, so there are no extra credentials and nothing extra to deploy. Part of [Ashurbanipal](https://github.com/mt-empty/ashurbanipal).

Requires Python 3.12+ and Flask 3.

## Install

Pick the extra for your database:

```sh
uv add 'ashurbanipal-flask[postgres]'   # or: pip install 'ashurbanipal-flask[postgres]'
uv add 'ashurbanipal-flask[mysql]'      # MySQL or MariaDB
uv add ashurbanipal-flask               # SQLite needs no extra
```

## Quick start

```python
import os

from flask import Flask

from ashurbanipal import Config, router
from ashurbanipal.db.postgres import PgSource

app = Flask(__name__)
# your own routes

config = Config(enabled=True)
source = PgSource(dsn=os.environ["DATABASE_URL"])
app.register_blueprint(router(config, [("primary", source)]))
```

Run `flask run` and open <http://localhost:5000/__ashurbanipal>.

## Turn it on only where you want it

`enabled` defaults to `False`. When it is off, every viewer path returns 404. Decide where to enable it, for example from an environment variable:

```python
config = Config(enabled=os.environ.get("ASHURBANIPAL_ENABLED") == "true")
```

## Protect it

Ashurbanipal has no login. Anyone who can reach `/__ashurbanipal` can read every table your app's database user can read. Put your own auth in front, and check a role, not just a login. `router()` returns a blueprint, so a hook on it covers only the viewer:

```python
from flask import abort

bp = router(config, [("primary", source)])


@bp.before_request
def require_admin():
    if not is_admin():
        abort(401)


app.register_blueprint(bp)
```

A hook on the blueprint follows it to any `mount` path you choose.

## MySQL, MariaDB, or SQLite

```python
from ashurbanipal.db.mysql import MySqlSource, connect_kwargs_from_url

source = MySqlSource(**connect_kwargs_from_url(os.environ["MYSQL_URL"]))  # mysql://user:pass@host:3306/db
```

`MySqlSource` also takes `pymysql.connect()` keyword arguments directly, for example `MySqlSource(host="localhost", user="app", password="...", database="app")`.

```python
from ashurbanipal.db.sqlite import SqliteSource

source = SqliteSource(path="app.db")
```

SQLite needs a real file. `:memory:` does not work, because each request opens a new connection and sees an empty database.

Column comments and common-value stats are empty on MySQL and SQLite.

## More than one database

Pass more than one source. The first one is the default, and the UI lets you switch between them:

```python
router(
    config,
    [
        ("orders", PgSource(dsn=os.environ["ORDERS_DATABASE_URL"])),
        ("billing", PgSource(dsn=os.environ["BILLING_DATABASE_URL"])),
    ],
)
```

## Connections

Each request opens its own database connection and closes it at the end. There is no pool. For pooling, write your own `DbSource` around your pool.

## Configuration

```python
from ashurbanipal import Config, Limits

config = Config(
    enabled=True,
    limits=Limits(default_page_size=50, max_page_size=100, query_timeout_secs=5),  # optional; the defaults
)

app.register_blueprint(router(config, sources, mount="/__ashurbanipal"))  # mount is optional; change the URL path
```

The [configuration table](https://github.com/mt-empty/ashurbanipal#configuration) lists every option, including `instance` and `siblings`. Those let the UI show which of your other services are reachable. Import `Instance` and `Sibling` from `ashurbanipal`.

## See also

- [Live demo](https://mt-empty.github.io/ashurbanipal/demo/live/)
