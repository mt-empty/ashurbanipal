# ashurbanipal-actix-web

A read-only database browser you mount inside your own [Actix Web](https://actix.rs) app. It reuses your app's database pool, so there are no extra credentials and nothing extra to deploy. Part of [Ashurbanipal](https://github.com/mt-empty/ashurbanipal).

Requires Rust 1.94+, actix-web 4, and sqlx 0.9.

## Install

```sh
cargo add ashurbanipal-actix-web
cargo add sqlx@0.9 --features postgres,runtime-tokio
```

## Quick start

```rust
use actix_web::{App, HttpServer};
use ashurbanipal_actix_web::{app_state, service, Config, PgPoolSource};

#[actix_web::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let pool = sqlx::PgPool::connect(&std::env::var("DATABASE_URL")?).await?;

    let config = Config { enabled: true, ..Default::default() };
    // Build once, outside the worker closure.
    let state = app_state(config, vec![("primary".to_string(), PgPoolSource::new(pool.clone()))]);

    HttpServer::new(move || {
        App::new()
            // .service(...) your own routes
            .service(service(state.clone()))
    })
    .bind(("0.0.0.0", 3000))?
    .run()
    .await?;
    Ok(())
}
```

Open <http://localhost:3000/__ashurbanipal>.

## Turn it on only where you want it

`enabled` defaults to `false`. When it is off, every viewer path returns 404. Decide where to enable it, for example from an environment variable:

```rust
let config = Config {
    enabled: std::env::var("ASHURBANIPAL_ENABLED").as_deref() == Ok("true"),
    ..Default::default()
};
```

## Protect it

Ashurbanipal has no login. Anyone who can reach `/__ashurbanipal` can read every table your app's database user can read. Put your own auth in front, and check a role, not just a login. `service()` returns a `Scope`, so wrap it directly:

```rust
use actix_web::{body::MessageBody, dev::{ServiceRequest, ServiceResponse}, error::ErrorUnauthorized, middleware::{from_fn, Next}, Error};

async fn require_admin(
    req: ServiceRequest,
    next: Next<impl MessageBody>,
) -> Result<ServiceResponse<impl MessageBody>, Error> {
    if !is_admin(&req) {
        return Err(ErrorUnauthorized("unauthorized"));
    }
    next.call(req).await
}

App::new().service(service(state.clone()).wrap(from_fn(require_admin)))
```

## MySQL, MariaDB, or SQLite

Turn on the matching feature and use `MySqlSource` or `SqliteSource` in place of `PgPoolSource`. If you don't use Postgres, drop it:

```sh
cargo add ashurbanipal-actix-web --no-default-features --features sqlite   # or mysql
cargo add sqlx@0.9 --features sqlite,runtime-tokio                         # or mysql
```

```rust
let pool = sqlx::SqlitePool::connect("sqlite://app.db").await?;
let state = app_state(config, vec![("primary".to_string(), SqliteSource::new(pool))]);
```

Column comments and common-value stats are empty on MySQL and SQLite.

## More than one database

Pass more than one source. The first one is the default, and the UI lets you switch between them:

```rust
app_state(config, vec![
    ("orders".to_string(), PgPoolSource::new(orders_pool)),
    ("billing".to_string(), PgPoolSource::new(billing_pool)),
]);
```

All sources must use the same backend type.

## Configuration

Set fields on `Config`, or load them from TOML:

```rust
let config = Config::from_toml(&std::fs::read_to_string("ashurbanipal.toml")?)?;
```

```toml
enabled = true

[limits]               # optional; these are the defaults
default_page_size = 50
max_page_size = 100
query_timeout_secs = 5
```

The [configuration table](https://github.com/mt-empty/ashurbanipal#configuration) lists every option, including `instance` and `siblings`. Those let the UI show which of your other services are reachable.

## Serving under a prefix

The viewer always lives at `/__ashurbanipal`. To add a prefix, wrap it in a scope:

```rust
.service(web::scope("/svc").service(service(state.clone()))) // viewer at /svc/__ashurbanipal
```

The UI finds its API from its own URL, so no other setting is needed. If a reverse proxy strips the prefix before the request reaches your app, register `service(state.clone())` directly.

## See also

- [`ashurbanipal-axum`](https://crates.io/crates/ashurbanipal-axum), the axum adapter
- [Live demo](https://mt-empty.github.io/ashurbanipal/demo/live/)
