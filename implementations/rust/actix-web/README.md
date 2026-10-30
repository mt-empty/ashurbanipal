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

`ashurbanipal_actix_web::app_state(config, sources)` builds the shared
state once (config, DB sources, HTTP client for sibling health checks) as
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
let state = app_state(config, vec![("primary".to_string(), PgPoolSource::new(pool.clone()))]); // built once

HttpServer::new(move || {
    App::new()
        // ... your existing routes/app_data ...
        .service(service(state.clone()))
})
.bind(("0.0.0.0", 4000))?
.run()
.await?;
```

`app_state` takes an ordered, non-empty list of named sources rather than
a single one — a host can register more than one `DbSource` (e.g. two
Postgres databases) and a request's `source` query param selects which one
it targets (`spec/protocol.md` §1, §5.8); the first entry is the default
used when `source` is absent. A single-source deployment just registers
one entry, as above.

`ashurbanipal.toml` — identical to `ashurbanipal-axum`'s, entirely
framework-agnostic:

```toml
enabled = true

# optional — these are the defaults, shown explicitly
[limits]
default_page_size = 50
max_page_size = 100
query_timeout_secs = 5

# optional: this instance's own name and label (spec/protocol.md §5.6)
[instance]
name = "orders"
label = "dev"

# One shared list, in the same order, on every instance (own entry included)
# keeps the grid's rows and columns the same everywhere.
[[siblings]]
name = "orders"
label = "int"   # optional; typically an environment (dev, int) or a region (eu, us)
base_url = "https://orders-int.internal.vpn/__ashurbanipal"
health_path = "/health"

[[siblings]]
name = "billing"
base_url = "https://billing.internal.vpn/__ashurbanipal"
health_path = "/health"
```

## Mount path

Routes are fixed under `/__ashurbanipal`. To serve them under an extra
prefix, wrap the scope:

```rust
.service(web::scope("/svc").service(service(state.clone()))) // viewer at /svc/__ashurbanipal
```

The frontend reads its API base from its own URL, so it adapts with no
extra config. If a reverse proxy strips the prefix before the request
reaches your process, register `service(state.clone())` directly and it
just works.

## Compression

The UI page is sent gzipped when the browser accepts gzip (`spec/protocol.md` §5.1); it is compressed once, when `service()` first runs. API responses are sent uncompressed. A host-wide `Compress` leaves the page alone, because it already carries `Content-Encoding`.

## Behind your own auth

Ashurbanipal ships no authentication ([`docs/design.md`](https://github.com/mt-empty/ashurbanipal/blob/main/docs/design.md) §6); guard the mount prefix with your host's own. Cover the whole prefix, UI included, and check a role rather than just a login — otherwise every signed-in user can read every table the database role can.

`service(state)` returns a `Scope`, so wrap it directly:

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

## Database support

Same `DbSource` backends as `ashurbanipal-axum`, unchanged — see
[its README](../axum/README.md#database-support) for the full matrix.

```sh
cargo add ashurbanipal-actix-web --features mysql   # or --features sqlite
```

Drop Postgres entirely with `--no-default-features`:

```sh
cargo add ashurbanipal-actix-web --no-default-features --features sqlite   # or --features mysql
```

Full API/config reference:
[docs/design.md](https://github.com/mt-empty/ashurbanipal/blob/main/docs/design.md).
