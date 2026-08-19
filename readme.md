# Ashurbanipal

<img src="docs/media/icon.svg" alt="" width="66" height="66" align="right">

No-bullshit Database browser for schemaful databases; self-contained, embeddable, read-only. No separate DB client, no extra credentials, no build step.

![Ashurbanipal demo](tools/e2e-tests/showcase.gif)

**[Try it live](https://mt-empty.github.io/ashurbanipal/demo/)** — synthetic data, no backend.

## Why

90% of engineers just want to browse their database. Having such functionality in a corporate environment currently means:

- Did you request AWS access? Wait for approval.
- Approved? Now add your username and SSH key to a repo nobody's heard of, and wait for *that* owner to approve you too.
- Follow a Confluence page to wire up AWS + SSH + your pick of DBeaver/pgcli/psql/pgAdmin/TablePlus.
    - ssh timeout out, oh too bad, you should use `mosh` instead
- Get your session killed by fucking Okta re-auth every 4 hours. Repeat.
    - blindly accept the MFA prompt, or else your session dies and you have to start over
- The bastion host is being patched, so none of the above even works.
- "You don't need to have db access, you just need to slice your stories thinly enough so you can test your code without needing db access" a wise engineer in an unwise org.
- can't deploy a sidecar container to run a db client, because the security team says no

all I need is to just see a row in the db, so I can complete my jira story.

Ashurbanipal lib skips the whole chain by not needing a new connection, it runs inside the process that already has one. If your service can query its own database, then you can look at a table from your browser.


## What it does

- Lists tables and filter table rows with a subset of SQL `WHERE` syntax (no joins, no subqueries, no CTEs, no DML).

## What it doesn't do

- No write access, no migrations, no schema changes.
- Not a replacement for a full-featured DB client like DBeaver, pgcli etc

## where it should be used

- In a corporate vpn environment, where engineers have to jump through hoops to get access to the database.

If you have the freedom to run a sidecar container, you can use `pgweb` instead, which is a full-featured DB client.

## Quick usage

### Postgres

<details><summary>Rust / Axum</summary>

```rust
// cargo add ashurbanipal-axum
use ashurbanipal_axum::{Config, PgPoolSource};
app.merge(ashurbanipal_axum::router(config, PgPoolSource::new(pool)));
```
</details>

<details><summary>Rust / Actix-web</summary>

```rust
// cargo add ashurbanipal-actix-web
use ashurbanipal_actix_web::{app_state, service, Config, PgPoolSource};
App::new().service(service(app_state(config, PgPoolSource::new(pool))));
```
</details>

<details><summary>Spring Boot</summary>

```yaml
# implementation("io.github.mtempty:ashurbanipal-spring-boot-starter:X.Y.Z")
ashurbanipal:
  enabled: true
  # backend: postgres is the default
```
</details>

<details><summary>Go / net-http</summary>

```go
// go get github.com/mt-empty/ashurbanipal/implementations/go-nethttp@vX.Y.Z
source := ashurbanipal.NewPostgresSource(db, timeoutSecs)
viewer, err := ashurbanipal.Router(cfg, source)
```
</details>

<details><summary>Node / Express</summary>

```ts
// pnpm install ashurbanipal-node-express
import { createRouter, PostgresSource } from "ashurbanipal-node-express";
const viewer = createRouter(config, new PostgresSource(pool));
```
</details>

<details><summary>Python / Flask</summary>

```python
# uv add ashurbanipal-flask
from ashurbanipal.db.postgres import PgSource
app.register_blueprint(router(config, PgSource(dsn=os.environ["DATABASE_URL"])))
```
</details>

### MySQL / MariaDB

<details><summary>Rust / Axum</summary>

```rust
// cargo add ashurbanipal-axum --features mysql
use ashurbanipal_axum::{Config, MySqlSource};
app.merge(ashurbanipal_axum::router(config, MySqlSource::new(pool)));
```
</details>

<details><summary>Rust / Actix-web</summary>

```rust
// cargo add ashurbanipal-actix-web --features mysql
use ashurbanipal_actix_web::{app_state, service, Config, MySqlSource};
App::new().service(service(app_state(config, MySqlSource::new(pool))));
```
</details>

<details><summary>Spring Boot</summary>

```yaml
# implementation("io.github.mtempty:ashurbanipal-spring-boot-starter:X.Y.Z")
ashurbanipal:
  backend: mysql   # covers MariaDB too
```
</details>

<details><summary>Go / net-http</summary>

```go
// go get github.com/mt-empty/ashurbanipal/implementations/go-nethttp@vX.Y.Z
// go build -tags mysql
source := ashurbanipal.NewMySQLSource(db, timeoutSecs)
viewer, err := ashurbanipal.Router(cfg, source)
```
</details>

<details><summary>Node / Express</summary>

```ts
// pnpm install ashurbanipal-node-express mysql2
import { createRouter } from "ashurbanipal-node-express";
import { MySqlSource } from "ashurbanipal-node-express/dist/src/db/mysql.js";
const viewer = createRouter(config, new MySqlSource(pool));
```
</details>

<details><summary>Python / Flask</summary>

```python
# uv add ashurbanipal-flask PyMySQL
from ashurbanipal.db.mysql import MySqlSource
app.register_blueprint(router(config, MySqlSource(...)))
```
</details>

### SQLite

<details><summary>Rust / Axum</summary>

```rust
// cargo add ashurbanipal-axum --features sqlite
use ashurbanipal_axum::{Config, SqliteSource};
app.merge(ashurbanipal_axum::router(config, SqliteSource::new(pool)));
```
</details>

<details><summary>Rust / Actix-web</summary>

```rust
// cargo add ashurbanipal-actix-web --features sqlite
use ashurbanipal_actix_web::{app_state, service, Config, SqliteSource};
App::new().service(service(app_state(config, SqliteSource::new(pool))));
```
</details>

<details><summary>Spring Boot</summary>

```yaml
# implementation("io.github.mtempty:ashurbanipal-spring-boot-starter:X.Y.Z")
ashurbanipal:
  backend: sqlite
```
</details>

<details><summary>Go / net-http</summary>

```go
// go get github.com/mt-empty/ashurbanipal/implementations/go-nethttp@vX.Y.Z
// go build -tags sqlite
source := ashurbanipal.NewSQLiteSource(db, timeoutSecs)
viewer, err := ashurbanipal.Router(cfg, source)
```
</details>

<details><summary>Node / Express</summary>

```ts
// pnpm install ashurbanipal-node-express sqlite3
import { createRouter } from "ashurbanipal-node-express";
import { SqliteSource } from "ashurbanipal-node-express/dist/src/db/sqlite.js";
const viewer = createRouter(config, new SqliteSource(new Database("app.db")));
```
</details>

<details><summary>Python / Flask</summary>

```python
# uv add ashurbanipal-flask
from ashurbanipal.db.sqlite import SqliteSource
app.register_blueprint(router(config, SqliteSource(path="./demo.db")))
```
</details>


## Implementations


| Implementation | Protocol version | Conformance CI |
|----------------|-------------------|-----------------|
| [`rust/axum`](implementations/rust/axum/README.md) | 1 | [![rust-axum-conformance](https://github.com/mt-empty/ashurbanipal/actions/workflows/rust-axum-conformance.yml/badge.svg)](https://github.com/mt-empty/ashurbanipal/actions/workflows/rust-axum-conformance.yml) |
| [`rust/actix-web`](implementations/rust/actix-web/README.md) | 1 | [![rust-actix-web-conformance](https://github.com/mt-empty/ashurbanipal/actions/workflows/rust-actix-web-conformance.yml/badge.svg)](https://github.com/mt-empty/ashurbanipal/actions/workflows/rust-actix-web-conformance.yml) |
| [`spring-boot-starter`](implementations/spring-boot-starter) | 1 | [![spring-boot-conformance](https://github.com/mt-empty/ashurbanipal/actions/workflows/spring-boot-conformance.yml/badge.svg)](https://github.com/mt-empty/ashurbanipal/actions/workflows/spring-boot-conformance.yml) |
| [`go-nethttp`](implementations/go-nethttp/README.md) | 1 | [![go-conformance](https://github.com/mt-empty/ashurbanipal/actions/workflows/go-conformance.yml/badge.svg)](https://github.com/mt-empty/ashurbanipal/actions/workflows/go-conformance.yml) |
| [`node-express`](implementations/node-express/README.md) | 1 | [![node-conformance](https://github.com/mt-empty/ashurbanipal/actions/workflows/node-conformance.yml/badge.svg)](https://github.com/mt-empty/ashurbanipal/actions/workflows/node-conformance.yml) |
| [`flask-python`](implementations/flask-python/README.md) | 1 | [![flask-conformance](https://github.com/mt-empty/ashurbanipal/actions/workflows/flask-conformance.yml/badge.svg)](https://github.com/mt-empty/ashurbanipal/actions/workflows/flask-conformance.yml) |
