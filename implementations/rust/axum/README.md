# ashurbanipal-axum

The Rust/Axum adapter of [Ashurbanipal](https://github.com/mt-empty/ashurbanipal),
a read-only, embeddable database browser your host app mounts as a
router. See the sibling [`ashurbanipal-actix-web`](../actix-web/README.md)
for the Actix-web adapter, or [`ashurbanipal`](../core/README.md) for the
shared core both build on.

```sh
cargo add ashurbanipal-axum
```

## Usage

`ashurbanipal_axum::router` returns a state-erased `Router<()>` (its state
is captured inside the handlers, not held generically) — if your own app
router carries state (`Router<AppState>`), call `.with_state(...)` on it
*before* `.merge()`-ing this one, since axum 0.8 requires the merge sides'
state types to match:

```rust
use ashurbanipal_axum::{Config, PgPoolSource};

let config = Config::from_toml(&std::fs::read_to_string("ashurbanipal.toml")?)?;

let app = Router::new()
    // ... your existing routes ...
    .with_state(app_state) // resolves Router<AppState> to Router<()> before merging
    .merge(ashurbanipal_axum::router(
        config,
        vec![("primary".to_string(), PgPoolSource::new(pool.clone()))],
    ));
```

`router` takes an ordered, non-empty list of named sources rather than a
single one — a host can register more than one `DbSource` (e.g. two
Postgres databases) and a request's `source` query param selects which one
it targets (`spec/protocol.md` §1, §5.8); the first entry is the default
used when `source` is absent. A single-source deployment just registers
one entry, as above.

`ashurbanipal.toml`:

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
prefix, call `.nest(prefix, ...)` in place of `.merge(...)` above:

```rust
.nest("/svc", ashurbanipal_axum::router(config, sources)) // viewer now at /svc/__ashurbanipal
```

The frontend reads its API base from its own URL, so it adapts with no
extra config. If a reverse proxy strips the prefix before the request
reaches your process, keep `.merge(...)` as-is: the app sees plain
`/__ashurbanipal` and it just works.

## Compression

The UI page is sent gzipped when the browser accepts gzip (`spec/protocol.md` §5.1); it is compressed once, when `router()` runs. API responses are sent uncompressed. A host-wide tower-http `CompressionLayer` leaves the page alone, because it already carries `Content-Encoding`.

## Behind your own auth

Ashurbanipal ships no authentication ([`docs/design.md`](https://github.com/mt-empty/ashurbanipal/blob/main/docs/design.md) §6); guard the mount prefix with your host's own. Cover the whole prefix, UI included, and check a role rather than just a login — otherwise every signed-in user can read every table the database role can.

Layer the viewer router before merging, so the guard covers only its routes:

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

## Database support

Postgres by default. MySQL/MariaDB and SQLite are supported behind the
`mysql`/`sqlite` features (some fields — comments, common-values stats —
degrade to empty on those backends) — swap in `MySqlSource`/`SqliteSource`
in place of `PgPoolSource`, everything else stays the same:

```sh
cargo add ashurbanipal-axum --features mysql   # or --features sqlite
```

Drop Postgres entirely with `--no-default-features`:

```sh
cargo add ashurbanipal-axum --no-default-features --features sqlite   # or --features mysql
```

Most hosts only need one backend — if that's not Postgres, dropping it
is recommended.

Full API/config reference:
[docs/design.md](https://github.com/mt-empty/ashurbanipal/blob/main/docs/design.md).
