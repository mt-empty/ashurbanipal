# ashurbanipal-actix-web

The Rust/Actix-web adapter of [Ashurbanipal](https://github.com/mt-empty/ashurbanipal),
sharing the framework-agnostic [`ashurbanipal`](../core/README.md) core
with [`ashurbanipal-axum`](../axum/README.md) — config, `DbSource`
backends, and the filter DSL are identical between the two adapters; only
the HTTP routing layer differs.

```sh
cargo add ashurbanipal-actix-web
```

## Usage

`ashurbanipal_actix_web::app_state(config, source)` builds the shared
state once (config, DB source, HTTP client for sibling health checks) as
a `web::Data<AppState<S>>` — build it *outside* `HttpServer::new`'s
per-worker closure and `.clone()` the handle into each worker (cheap:
`web::Data` is internally `Arc`-backed). Unlike axum's `Router<S>`,
`ashurbanipal_actix_web::service(state)`'s `Scope` needs no state-type
coordination with your own app's state — Actix stores `web::Data<T>` in a
type-keyed map rather than one generic parameter, so your own state and
Ashurbanipal's coexist regardless of registration order.

```rust
use actix_web::{App, HttpServer};
use ashurbanipal_actix_web::{app_state, service, Config, PgPoolSource};

let config = Config::from_toml(&std::fs::read_to_string("ashurbanipal.toml")?)?;
let state = app_state(config, PgPoolSource::new(pool.clone())); // built once

HttpServer::new(move || {
    App::new()
        // ... your existing routes/app_data ...
        .service(service(state.clone()))
})
.bind(("0.0.0.0", 4000))?
.run()
.await?;
```

`ashurbanipal.toml` — identical to `ashurbanipal-axum`'s, entirely
framework-agnostic:

```toml
environment = "dev"
enabled_for = ["dev", "integration", "staging"]

# optional — these are the defaults, shown explicitly
[limits]
default_page_size = 50
max_page_size = 100
query_timeout_secs = 5

[[siblings]]
name = "billing"
dbviewer_url = "https://billing.internal.vpn/__ashurbanipal"
health_path = "/health"

[[siblings]]
name = "notifications"
dbviewer_url = "https://notifications.internal.vpn/__ashurbanipal"
health_path = "/health"
```

## Database support

Same `DbSource` backends as `ashurbanipal-axum`, unchanged — see
[its README](../axum/README.md#database-support) for the full matrix.

```toml
[dependencies]
ashurbanipal-actix-web = { version = "0.2", features = ["mysql"] } # or "sqlite"
```

Drop Postgres entirely with `default-features = false`:

```toml
[dependencies]
ashurbanipal-actix-web = { version = "0.2", default-features = false, features = ["sqlite"] } # or "mysql"
```

Full API/config reference:
[docs/design.md](https://github.com/mt-empty/ashurbanipal/blob/main/docs/design.md).
