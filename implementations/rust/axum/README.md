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

Postgres by default. MySQL/MariaDB and SQLite are supported behind the
`mysql`/`sqlite` features (some fields — comments, common-values stats —
degrade to empty on those backends) — swap in `MySqlSource`/`SqliteSource`
in place of `PgPoolSource`, everything else stays the same:

```toml
[dependencies]
ashurbanipal-axum = { version = "0.2", features = ["mysql"] } # or "sqlite"
```

Drop Postgres entirely with `default-features = false`:

```toml
[dependencies]
ashurbanipal-axum = { version = "0.2", default-features = false, features = ["sqlite"] } # or "mysql"
```

Most hosts only need one backend — if that's not Postgres, dropping it
is recommended.

Full API/config reference:
[docs/design.md](https://github.com/mt-empty/ashurbanipal/blob/main/docs/design.md).
