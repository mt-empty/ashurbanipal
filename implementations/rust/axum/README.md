# ashurbanipal-axum

A read-only database browser you mount inside your own [axum](https://github.com/tokio-rs/axum) app. It reuses your app's database pool, so there are no extra credentials and nothing extra to deploy. Part of [Ashurbanipal](https://github.com/mt-empty/ashurbanipal).

Requires Rust 1.94+, axum 0.8, and sqlx 0.9.

## Install

```sh
cargo add ashurbanipal-axum
cargo add sqlx@0.9 --features postgres,runtime-tokio
```

## Quick start

```rust
use ashurbanipal_axum::{Config, PgPoolSource};
use axum::Router;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let pool = sqlx::PgPool::connect(&std::env::var("DATABASE_URL")?).await?;

    let config = Config { enabled: true, ..Default::default() };
    let viewer = ashurbanipal_axum::router(
        config,
        vec![("primary".to_string(), PgPoolSource::new(pool.clone()))],
    );

    let app = Router::new()
        // .route(...) your own routes
        .merge(viewer);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await?;
    axum::serve(listener, app).await?;
    Ok(())
}
```

Open <http://localhost:3000/__ashurbanipal>.

If your router has state (`Router<AppState>`), call `.with_state(state)` before `.merge(viewer)`. Otherwise the two router types don't match.

## Turn it on only where you want it

`enabled` defaults to `false`. When it is off, `router()` returns an empty router, so every viewer path returns 404. Decide where to enable it, for example from an environment variable:

```rust
let config = Config {
    enabled: std::env::var("ASHURBANIPAL_ENABLED").as_deref() == Ok("true"),
    ..Default::default()
};
```

## Protect it

Ashurbanipal has no login. Anyone who can reach `/__ashurbanipal` can read every table your app's database user can read. Put your own auth in front, and check a role, not just a login:

```rust
use axum::{extract::Request, http::StatusCode, middleware::{self, Next}, response::{IntoResponse, Response}};

async fn require_admin(req: Request, next: Next) -> Response {
    if !is_admin(&req) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(req).await
}

let viewer = ashurbanipal_axum::router(config, sources)
    .layer(middleware::from_fn(require_admin));
let app = Router::new().merge(viewer);
```

Layer the viewer before merging, so the guard covers only its routes.

## MySQL, MariaDB, or SQLite

Turn on the matching feature and use `MySqlSource` or `SqliteSource` in place of `PgPoolSource`. If you don't use Postgres, drop it:

```sh
cargo add ashurbanipal-axum --no-default-features --features sqlite   # or mysql
cargo add sqlx@0.9 --features sqlite,runtime-tokio                     # or mysql
```

```rust
let pool = sqlx::SqlitePool::connect("sqlite://app.db").await?;
let viewer = ashurbanipal_axum::router(config, vec![("primary".to_string(), SqliteSource::new(pool))]);
```

Column comments and common-value stats are empty on MySQL and SQLite.

## More than one database

Pass more than one source. The first one is the default, and the UI lets you switch between them:

```rust
ashurbanipal_axum::router(config, vec![
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

The viewer always lives at `/__ashurbanipal`. To add a prefix, use `.nest` in place of `.merge`:

```rust
.nest("/svc", viewer) // viewer at /svc/__ashurbanipal
```

The UI finds its API from its own URL, so no other setting is needed. If a reverse proxy strips the prefix before the request reaches your app, keep `.merge`.

## See also

- [`ashurbanipal-actix-web`](https://crates.io/crates/ashurbanipal-actix-web), the Actix-web adapter
- [Live demo](https://mt-empty.github.io/ashurbanipal/demo/live/)
