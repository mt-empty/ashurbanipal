# Ashurbanipal

<img src="docs/media/icon.svg" alt="Ashurbanipal logo" width="66" height="66" align="right">

No-bullshit database browser for schemaful databases; self-contained, embeddable, read-only. No separate DB client, no extra credentials, no build step.

![Ashurbanipal demo](tools/e2e-tests/showcase.gif)

**[Try it live](https://mt-empty.github.io/ashurbanipal/demo/)**: synthetic data, no backend.

## Why

Most engineers just want to browse their database. Having such functionality in a corporate environment currently means:

- Did you request AWS access? Wait for approval.
- Approved? Now add your username and SSH key to a repo nobody's heard of, and wait for *that* owner to approve you too.
- Follow a Confluence page to wire up AWS + SSH + your pick of DBeaver/pgcli/psql/pgAdmin/TablePlus.
    - ssh timed out, oh too bad, you should use `mosh` instead
- Get your session killed by fucking Okta re-auth every 4 hours. Repeat.
    - blindly accept the MFA prompt, or else your session dies and you have to start over
- The bastion host is being patched, so none of the above even works.
- "You don't need to have db access, you just need to slice your stories thinly enough so you can test your code without needing db access" a wise engineer in an unwise org.
- Can't deploy a sidecar container to run a db client, because...you get the point.

all I need is to just see a row in the db, so I can complete my feature story.

Ashurbanipal skips the whole chain by not needing a new connection: it runs inside the process that already has one. If your service can query its own database, then you can look at a table from your browser.

## What it does

- Browse tables: paginated rows, click-to-sort columns, primary/foreign-key and column-comment hints.
- Filter rows with a subset of SQL `WHERE` syntax (no joins, no subqueries, no CTEs, no DML).
- Works with Postgres, MySQL/MariaDB, and SQLite.
- Register more than one database and switch between them (currently only one db type at a time); browse across schemas where the engine has them.
- Link sibling instances and see which are reachable.
- Ships as one static file compiled into your binary; nothing extra to host or deploy.

## What it doesn't do

- No write access, no migrations, no schema changes.
- Not a replacement for a full-featured DB client like DBeaver, pgcli, etc.

## Security

Ashurbanipal ships no authentication or authorization. Access is a perimeter concern: run the host service behind your corporate VPN, reachable by you and your team but not the outside world. If you want a login or per-user rules, add that in front of the mounted router.

Two things back that up:

- **Fail-safe default**: the `enabled` flag defaults to off. Ashurbanipal has no concept of "environment"; where to turn it on is the host's call.
- **Read-only by construction**: `SELECT` only, no DDL or DML.

## Quick usage

### Postgres

<details><summary>Rust / Axum</summary>

```rust
// cargo add ashurbanipal-axum
use ashurbanipal_axum::{Config, PgPoolSource};
app.merge(ashurbanipal_axum::router(config, vec![("primary".to_string(), PgPoolSource::new(pool))]));
```
</details>

<details><summary>Rust / Actix-web</summary>

```rust
// cargo add ashurbanipal-actix-web
use ashurbanipal_actix_web::{app_state, service, Config, PgPoolSource};
App::new().service(service(app_state(config, vec![("primary".to_string(), PgPoolSource::new(pool))])));
```
</details>

<details><summary>Spring Boot</summary>

```yaml
# implementation("io.github.mt-empty:ashurbanipal-spring-boot-starter:0.3.0")
ashurbanipal:
  enabled: true
  # backend: postgres is the default
```
</details>

<details><summary>Go / net-http</summary>

```go
// go get github.com/mt-empty/ashurbanipal/implementations/go-nethttp@latest
source := ashurbanipal.NewPostgresSource(db, timeoutSecs)
viewer := ashurbanipal.Router(cfg, []ashurbanipal.NamedSource{{Name: "primary", Source: source}})
```
</details>

<details><summary>Node / Express</summary>

```ts
// pnpm install ashurbanipal-node-express
import { createRouter, PostgresSource } from "ashurbanipal-node-express";
const viewer = createRouter(config, [{ name: "primary", source: new PostgresSource(pool) }]);
```
</details>

<details><summary>Python / Flask</summary>

```python
# uv add ashurbanipal-flask
from ashurbanipal.db.postgres import PgSource
app.register_blueprint(router(config, [("primary", PgSource(dsn=os.environ["DATABASE_URL"]))]))
```
</details>

### MySQL / MariaDB

<details><summary>Rust / Axum</summary>

```rust
// cargo add ashurbanipal-axum --features mysql
use ashurbanipal_axum::{Config, MySqlSource};
app.merge(ashurbanipal_axum::router(config, vec![("primary".to_string(), MySqlSource::new(pool))]));
```
</details>

<details><summary>Rust / Actix-web</summary>

```rust
// cargo add ashurbanipal-actix-web --features mysql
use ashurbanipal_actix_web::{app_state, service, Config, MySqlSource};
App::new().service(service(app_state(config, vec![("primary".to_string(), MySqlSource::new(pool))])));
```
</details>

<details><summary>Spring Boot</summary>

```yaml
# implementation("io.github.mt-empty:ashurbanipal-spring-boot-starter:0.3.0")
ashurbanipal:
  enabled: true
  backend: mysql   # covers MariaDB too
```
</details>

<details><summary>Go / net-http</summary>

```go
// go get github.com/mt-empty/ashurbanipal/implementations/go-nethttp@latest
// go build -tags mysql
source := ashurbanipal.NewMySQLSource(db, timeoutSecs)
viewer := ashurbanipal.Router(cfg, []ashurbanipal.NamedSource{{Name: "primary", Source: source}})
```
</details>

<details><summary>Node / Express</summary>

```ts
// pnpm install ashurbanipal-node-express mysql2
import { createRouter } from "ashurbanipal-node-express";
import { MySqlSource } from "ashurbanipal-node-express/dist/src/db/mysql.js";
const viewer = createRouter(config, [{ name: "primary", source: new MySqlSource(pool) }]);
```
</details>

<details><summary>Python / Flask</summary>

```python
# uv add ashurbanipal-flask PyMySQL
from ashurbanipal.db.mysql import MySqlSource, connect_kwargs_from_url
app.register_blueprint(router(config, [("primary", MySqlSource(**connect_kwargs_from_url(os.environ["MYSQL_URL"])))]))
```
</details>

### SQLite

<details><summary>Rust / Axum</summary>

```rust
// cargo add ashurbanipal-axum --features sqlite
use ashurbanipal_axum::{Config, SqliteSource};
app.merge(ashurbanipal_axum::router(config, vec![("primary".to_string(), SqliteSource::new(pool))]));
```
</details>

<details><summary>Rust / Actix-web</summary>

```rust
// cargo add ashurbanipal-actix-web --features sqlite
use ashurbanipal_actix_web::{app_state, service, Config, SqliteSource};
App::new().service(service(app_state(config, vec![("primary".to_string(), SqliteSource::new(pool))])));
```
</details>

<details><summary>Spring Boot</summary>

```yaml
# implementation("io.github.mt-empty:ashurbanipal-spring-boot-starter:0.3.0")
ashurbanipal:
  enabled: true
  backend: sqlite
```
</details>

<details><summary>Go / net-http</summary>

```go
// go get github.com/mt-empty/ashurbanipal/implementations/go-nethttp@latest
// go build -tags sqlite
source := ashurbanipal.NewSQLiteSource(db, timeoutSecs)
viewer := ashurbanipal.Router(cfg, []ashurbanipal.NamedSource{{Name: "primary", Source: source}})
```
</details>

<details><summary>Node / Express</summary>

```ts
// pnpm install ashurbanipal-node-express sqlite3
import { createRouter } from "ashurbanipal-node-express";
import { SqliteSource } from "ashurbanipal-node-express/dist/src/db/sqlite.js";
const viewer = createRouter(config, [{ name: "primary", source: new SqliteSource(new Database("app.db")) }]);
```
</details>

<details><summary>Python / Flask</summary>

```python
# uv add ashurbanipal-flask
from ashurbanipal.db.sqlite import SqliteSource
app.register_blueprint(router(config, [("primary", SqliteSource(path="./demo.db"))]))
```
</details>

Once mounted, the viewer is served under `/__ashurbanipal` (the default mount path; it's implementation-defined, see [`spec/protocol.md`](spec/protocol.md) §3).

## Configuration

| Option | Default | Purpose |
|--------|---------|---------|
| `enabled` | `false` | Master on/off. Absent or malformed config means off. |
| `limits.default_page_size` | `50` | Rows per page when the request doesn't specify. |
| `limits.max_page_size` | `100` | Hard, server-enforced page-size cap. |
| `limits.query_timeout_secs` | `5` | Per-query timeout. |
| `siblings` | none | Other instances to show reachability for; each has `name`, `base_url`, `health_path`. |

## Implementations

| Implementation | Package | Protocol version | Conformance CI |
|----------------|---------|-------------------|-----------------|
| [`rust/axum`](implementations/rust/axum/README.md) | `ashurbanipal-axum` · crates.io | 1 | [![rust-axum-conformance](https://github.com/mt-empty/ashurbanipal/actions/workflows/rust-axum-conformance.yml/badge.svg)](https://github.com/mt-empty/ashurbanipal/actions/workflows/rust-axum-conformance.yml) |
| [`rust/actix-web`](implementations/rust/actix-web/README.md) | `ashurbanipal-actix-web` · crates.io | 1 | [![rust-actix-web-conformance](https://github.com/mt-empty/ashurbanipal/actions/workflows/rust-actix-web-conformance.yml/badge.svg)](https://github.com/mt-empty/ashurbanipal/actions/workflows/rust-actix-web-conformance.yml) |
| [`spring-boot-starter`](implementations/spring-boot-starter/README.md) | `io.github.mt-empty:ashurbanipal-spring-boot-starter` · Maven Central | 1 | [![spring-boot-conformance](https://github.com/mt-empty/ashurbanipal/actions/workflows/spring-boot-conformance.yml/badge.svg)](https://github.com/mt-empty/ashurbanipal/actions/workflows/spring-boot-conformance.yml) |
| [`go-nethttp`](implementations/go-nethttp/README.md) | `github.com/mt-empty/ashurbanipal/implementations/go-nethttp` · Go modules | 1 | [![go-conformance](https://github.com/mt-empty/ashurbanipal/actions/workflows/go-conformance.yml/badge.svg)](https://github.com/mt-empty/ashurbanipal/actions/workflows/go-conformance.yml) |
| [`node-express`](implementations/node-express/README.md) | `ashurbanipal-node-express` · npm | 1 | [![node-conformance](https://github.com/mt-empty/ashurbanipal/actions/workflows/node-conformance.yml/badge.svg)](https://github.com/mt-empty/ashurbanipal/actions/workflows/node-conformance.yml) |
| [`flask-python`](implementations/flask-python/README.md) | `ashurbanipal-flask` · PyPI | 1 | [![flask-conformance](https://github.com/mt-empty/ashurbanipal/actions/workflows/flask-conformance.yml/badge.svg)](https://github.com/mt-empty/ashurbanipal/actions/workflows/flask-conformance.yml) |

## Docs

- [`spec/protocol.md`](spec/protocol.md): the normative endpoint contract every port implements.
- [`spec/filter-dsl.md`](spec/filter-dsl.md): the filter grammar and its test table.
- [`PORTING.md`](PORTING.md): how to add or review a language port.

<!-- ## The name

Ashurbanipal, the last great king of the Neo-Assyrian Empire, assembled the Library of Nineveh, one of the first systematically catalogued collections of tablets. This is a catalogue browser for your tables. -->

