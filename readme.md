# Ashurbanipal

<img src="docs/media/icon.svg" alt="" width="66" height="66" align="right">

A self-contained, embeddable database browser(read only). no separate DB client, no extra credentials, no build step.

![Ashurbanipal demo](tools/e2e-tests/showcase.gif)

## Why

90% of engineers just want to browse their database. Having such functionality in a corporate environment currently means:

- Did you request AWS access? Wait for approval.
- Approved? Now add your username and SSH key to a repo nobody's heard of, and wait for *that* owner to approve you too.
- Follow a Confluence page to wire up AWS + SSH + your pick of DBeaver/pgcli/psql/pgAdmin/TablePlus.
    - ssh timeout out, oh too bad, yuou should use mosh
- Get your session killed by fucking Okta re-auth every few hours. Repeat.
    - blindly accept the MFA prompt, or else your session dies and you have to start over
- The bastion host is being patched, so none of the above even works.
- "You don't need to have db access, you just need to slice your stories thinly enough so you can test your code without needing db access"
- can't deploy a sidecar container to run a db client, because the security team says no

all I need is to just see a row in the db, so I can complete my story.

Ashurbanipal lib skips the whole chain by not needing a new connection, it runs inside the process that already has one. If your service can query its own database, then you can look at a table from your browser.


## What it does

- Lists tables and filter table rows with a subset of SQL `WHERE` syntax (no joins, no subqueries, no CTEs, no DML).

## What it doesn't do

- No write access, no migrations, no schema changes, no SQL execution.
- Not a replacement for a full-featured DB client like DBeaver, pgcli etc

## where it should be used

- In a corporate environment, where engineers have to jump through hoops to get access to the database.


## Usage

Not published to crates.io yet — depend on it by path or git:

```toml
[dependencies]
ashurbanipal = { git = "https://github.com/you/ashurbanipal" }
```

Merge its router into your existing Axum app, passing it a config and a
`DbSource` wrapping your service's own `sqlx::PgPool` — no new DB connection,
no new credentials:

```rust
use ashurbanipal::{Config, PgPoolSource};

let toml_str = std::fs::read_to_string("ashurbanipal.toml")?;
let config = Config::from_toml(&toml_str)?;

let app = Router::new()
    // ... your existing routes ...
    .merge(ashurbanipal::router(config, PgPoolSource::new(pool.clone())));
```

That mounts six routes under `/__ashurbanipal` (the UI plus five read-only
API endpoints). The kill switch is fail-closed: `environment` must be listed
in `enabled_for` (or `enabled_for` must contain `"any"`), and anything
production-like (`production`, `prod`, `prd`, `live`, any casing) is rejected
at config-parse time rather than silently ignored at request time. If it
isn't enabled for the current environment, `router()` returns an empty
router — a plain 404, same as if the crate weren't merged in.

`ashurbanipal.toml`:

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

[[siblings]]
name = "notifications"
dbviewer_url = "https://notifications.internal.vpn/__ashurbanipal"
health_path = "/health"
```

`siblings` are optional links to other services' Ashurbanipal instances
(health-checked live, ~15s poll) so you can jump between databases in a
multi-service setup — omit the array entirely if you don't need it.

If the `[ashurbanipal]` table needs to live nested inside your own app's
config file instead of a dedicated file, nest `Config` as a field in your own
`Deserialize` struct and call `.validate()` yourself before `router()` (only
`Config::from_toml` calls it for you):

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
reference. `mise run demo` runs a working example host app against the
seeded devcontainer database.
