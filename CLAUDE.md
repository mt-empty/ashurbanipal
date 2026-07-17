# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Ashurbanipal is a Rust/Axum crate that a host service embeds to get a
read-only web UI for browsing its own Postgres tables (no separate DB
client, no extra credentials, no build step). It ships as a single crate:
the host does `app.merge(ashurbanipal::router(config, db_source))` and gets
five routes under a fixed `/__ashurbanipal` prefix, including the UI itself.

Two components:
- **Frontend** — `src/frontend/dbviewer.html`, a single static HTML file
  (markup/CSS/JS together, framework-agnostic, no build step) embedded into
  the binary via `include_str!` in `src/routes.rs`. `@alenaksu/json-viewer`
  (JSON tree view) and Prism.js are planned CDN-loaded enhancements (see
  `docs/cdn-research.md`) — not yet wired in, but when they land they must
  be enhancements only, i.e. the page keeps working if the CDN is
  unreachable.
- **Backend** — `src/config.rs` (kill switch + limits + siblings config),
  `src/db.rs` (the `DbSource` trait + its one impl, `PgPoolSource`),
  `src/routes.rs` (the Axum router and the four API handlers).

Read `docs/design.md` first for anything non-obvious — it's the source of
truth for intended behavior. `docs/filter-dsl.md` has the filter grammar
and its full test table (implement/verify against that table, not ad hoc
cases). `docs/ui-guidelines.md` and `docs/frontend-style-guide.md` are the
standing behavioral/structural rules for `dbviewer.html` (the *why* and the
*shape*, respectively) — read them before touching the frontend, not just
`design.md`.

## Commands

This is a devcontainer project; a Postgres instance (`db`, seeded via
`.devcontainer/db/init/01-seed.sql`) is expected to be reachable at
`DATABASE_URL` (set automatically by the devcontainer).

There's a `mise.toml` with tasks wrapping all of the below — `mise tasks`
lists them, `mise run <task>` runs one:

```sh
mise run build
mise run test                      # unit tests live inline (#[cfg(test)] mod tests in config.rs, routes.rs)
mise run test config::tests::name  # run a single test (extra args pass through)
mise run lint                      # cargo clippy -- -D warnings
mise run fmt-check
mise run check                     # fmt-check + lint + test, i.e. what CI runs
mise run demo                      # host demo app at http://localhost:4000/__ashurbanipal
mise run demo-sibling              # second instance, to demo sibling health-poll
mise run dev                       # demo app, auto-rebuild/restart on src/ or dbviewer.html changes (watchexec)
mise run seed-gen                  # regenerate .devcontainer/db/init/01-seed.sql
```

Equivalent raw `cargo` invocations, if mise isn't available:

```sh
cargo build
cargo test
cargo test config::tests::name
cargo clippy -- -D warnings
cargo fmt --check
cargo run --example demo
PORT=4001 SIBLING_PORT=4000 cargo run --example demo
(cd tools/seed-gen && cargo run > ../../.devcontainer/db/init/01-seed.sql)
```

`mise run demo` (or `cargo run --example demo`) against the devcontainer's
`DATABASE_URL` is the only command needed for a working browser on the seed
db — this is an acceptance criterion, not just a convenience.

`tools/seed-gen` is a standalone dev-only crate (uses `fake`) — deliberately
not a dependency of the main crate, and not part of the workspace resolved
by root `cargo` commands (it has its own `Cargo.toml`/`Cargo.lock`).
Deterministic fixed RNG seed, so regenerating without source edits produces
an identical file.

## Architecture invariants (don't break these)

- **`DbSource` is the only seam to the database.** Route handlers never touch
  `sqlx` directly. v1 has exactly one implementation, `PgPoolSource`; the
  trait exists so other adapters can be added later without touching
  handlers. It's native async-fn-in-trait (no `async_trait`), and the router
  is generic (`router<S: DbSource>`) — no `dyn`. Don't add `async_trait` or
  `dyn DbSource` unless a second implementation actually shows up.
- **Kill switch is fail-closed and checked once, at router construction.**
  `Config::is_enabled()` gates all five routes identically — if disabled,
  `router()` returns an empty `Router::new()`, so the mounted app 404s
  exactly as if the crate weren't merged in at all. Never add a route that
  bypasses this, and never move the enabled-check to per-request.
- **Production is unrepresentable, not just discouraged.** `enabled_for`
  (or `environment`) naming anything in `PRODUCTION_ALIASES` fails at
  config *parse* time (`Config::from_toml`/`validate`), not at request time.
  If you touch `config.rs`, preserve this — it's the load-bearing safety
  property, not incidental validation.
- **No unvalidated identifier ever reaches SQL text.** Table and column
  names are only ever spliced into a query after being matched exactly
  against a live `information_schema` lookup (see `allowed_tables` /
  `allowed_columns` in `db.rs`); everything else is a bound parameter. When
  the filter DSL parser lands (see below), the same rule applies to its
  columns — validate against schema before building SQL, never trust the
  parsed column name directly.
- **The filter DSL is deliberately unimplemented in `routes.rs` right now.**
  Any non-empty `filter` param returns 400 ("not implemented yet") rather
  than being silently ignored. It's scheduled *last* in the build order
  (`docs/design.md` §4.1, `docs/filter-dsl.md`) — grammar and a full
  valid/rejected/adversarial test table already exist and are the spec to
  implement against, not to redesign.
- **Frontend has no build step.** `dbviewer.html` is hand-edited directly,
  not generated or bundled. Keep it a single self-contained file.
- **rustls everywhere, no OpenSSL.** Both `sqlx` and `reqwest` are
  configured for rustls specifically so embedding this crate doesn't impose
  a system TLS dependency on the host. Don't add a dependency that pulls in
  `native-tls`/OpenSSL.
- **Demo-only deps stay in `[dev-dependencies]`.** `tracing-subscriber`,
  `dotenvy` etc. must never leak into the published crate's dependency list.
