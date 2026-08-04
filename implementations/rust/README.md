# ashurbanipal (rust)

The Rust/Axum reference implementation of [Ashurbanipal](../../readme.md).

Not published to crates.io yet — depend on it by path or git:

```toml
[dependencies]
ashurbanipal = { git = "https://github.com/you/ashurbanipal" }
# or, from within a clone of this repo:
ashurbanipal = { path = "implementations/rust" }
```

## Database support

| Backend | Type | Status |
|---|---|---|
| Postgres (`PgPoolSource`) | default, no feature flag | Conformant — the reference implementation `spec/protocol.md` is written against; covered by the full conformance suite. |
| SQLite (`SqliteSource`) | opt-in via the `sqlite` Cargo feature (off by default) | Reviewed and supported, with known degraded features — comments and pre-computed common-values statistics have no SQLite equivalent and degrade to empty/`None`; table counts are exact `COUNT(*)` rather than Postgres's fast planner estimate. Not run through `conformance/runner` (that suite targets Postgres); has its own unit test suite instead. See `docs/adapter-decisions.md` for the per-clause backend decisions this relies on. |

```toml
[dependencies]
# Postgres only (default):
ashurbanipal = { path = "implementations/rust" }
# To also pull in SqliteSource:
ashurbanipal = { path = "implementations/rust", features = ["sqlite"] }
```

## Usage

```rust
use ashurbanipal::{Config, PgPoolSource};

let toml_str = std::fs::read_to_string("ashurbanipal.toml")?;
let config = Config::from_toml(&toml_str)?;

let app = Router::new()
    // ... your existing routes ...
    .merge(ashurbanipal::router(config, PgPoolSource::new(pool.clone())));
```

Or, with the `sqlite` feature enabled, swap in `SqliteSource` — everything
else (config, kill switch, filter DSL, frontend) is identical:

```rust
use ashurbanipal::{Config, SqliteSource};

let app = Router::new()
    .merge(ashurbanipal::router(config, SqliteSource::new(pool.clone())));
```

`ashurbanipal.toml`:

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

If your config needs to live nested inside your own app's config file
instead of a dedicated file:

```rust
#[derive(serde::Deserialize)]
struct HostConfig {
    ashurbanipal: ashurbanipal::Config,
    // ...your other app settings
}

let host_config: HostConfig = toml::from_str(&raw)?;
host_config.ashurbanipal.validate()?;
```

See `docs/design.md` for the full API contract, filter DSL, and config
reference. `mise run rust:demo` runs a working example host app against the
seeded devcontainer database.
