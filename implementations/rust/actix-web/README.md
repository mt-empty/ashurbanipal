# ashurbanipal-actix-web

The Rust/Actix-web adapter of [Ashurbanipal](../../../readme.md), sharing
the framework-agnostic `ashurbanipal` core crate (`../core/`) with
[`ashurbanipal-axum`](../axum/README.md) — config, `DbSource` backends, and the
filter DSL are identical between the two adapters; only the HTTP routing
layer differs.

Not yet published to crates.io — depend on it by path or git in the
meantime:

```toml
[dependencies]
ashurbanipal-actix-web = { git = "https://github.com/mt-empty/ashurbanipal", path = "implementations/rust/actix-web" }
# or, from within a clone of this repo:
ashurbanipal-actix-web = { path = "implementations/rust/actix-web" }
```

## Database support

Same `DbSource` backends as `ashurbanipal-axum`, unchanged — see
[`../axum/README.md`'s database support table](../axum/README.md#database-support)
for the full per-backend matrix (Postgres default, MySQL/SQLite behind
the `mysql`/`sqlite` Cargo features).

```toml
[dependencies]
# Postgres only (default):
ashurbanipal-actix-web = { path = "implementations/rust/actix-web" }
# To also pull in MySqlSource:
ashurbanipal-actix-web = { path = "implementations/rust/actix-web", features = ["mysql"] }
# To also pull in SqliteSource:
ashurbanipal-actix-web = { path = "implementations/rust/actix-web", features = ["sqlite"] }
```

## Usage

`ashurbanipal_actix_web::app_state(config, source)` builds the shared
state once (config, DB source, HTTP client for sibling health checks) as
a `web::Data<AppState<S>>` — build it *outside* `HttpServer::new`'s
per-worker closure and `.clone()` the handle into each worker (cheap:
`web::Data` is internally `Arc`-backed). `ashurbanipal_actix_web::service(state)`
then builds the route `Scope`, which — unlike axum's `Router<S>` — does
**not** require any state-type coordination with your own app's state:
Actix stores `web::Data<T>` in a type-keyed map, not threaded through one
generic parameter, so your own `web::Data<YourState>` and Ashurbanipal's
internal `web::Data<AppState<S>>` coexist regardless of registration
order (verified — no axum-style `.with_state()`-before-`.merge()`
ordering requirement here).

```rust
use actix_web::{App, HttpServer};
use ashurbanipal_actix_web::{app_state, service, Config, PgPoolSource};

let toml_str = std::fs::read_to_string("ashurbanipal.toml")?;
let config = Config::from_toml(&toml_str)?;

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

Or, with the `mysql`/`sqlite` feature enabled, swap in `MySqlSource`/
`SqliteSource` — everything else is identical:

```rust
use ashurbanipal_actix_web::{app_state, MySqlSource};

let state = app_state(config, MySqlSource::new(pool.clone()));
```

`ashurbanipal.toml` — identical to `ashurbanipal-axum`'s, entirely
framework-agnostic:

```toml
environment = "dev"
enabled_for = ["dev", "integration", "staging"]

[limits]
default_page_size = 50
max_page_size = 100
query_timeout_secs = 5

[[siblings]]
name = "billing"
dbviewer_url = "https://billing.internal.vpn/__ashurbanipal"
health_path = "/health"
```

## Kill switch

`Config::is_enabled()` gates every route identically to the Axum
adapter — if disabled, `service()` returns a `Scope` with no routes
registered, so every path under it falls through to the host `App`'s own
404. Covered by two test suites:
- `../core/src/config.rs`'s `#[cfg(test)] mod tests` — production-alias
  rejection at config-parse time (shared with the Axum adapter, since
  both use the same `Config` unchanged).
- `src/routes.rs`'s `kill_switch_tests` module — an in-process
  `actix_web::test` check that a disabled config 404s both the HTML route
  and an API route.

See `docs/design.md` for the full API contract, filter DSL, and config
reference. `mise run actix:demo` runs a working example host app against
the seeded devcontainer database.
