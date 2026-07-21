# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working style

Be terse, not verbose — short responses, no restating what was just asked
or narrating obvious next steps. Don't add comments to explain code that's
already clear from names/structure; a comment only earns its place by
stating a non-obvious *why* (see the `src/*.rs` comment-discipline rule
below, which applies project-wide, not just to Rust).

## What this is

Ashurbanipal is a Rust/Axum crate that a host service embeds to get a
read-only web UI for browsing its own Postgres tables (no separate DB
client, no extra credentials, no build step). It ships as a single crate:
the host does `app.merge(ashurbanipal::router(config, db_source))` and gets
six routes under a fixed `/__ashurbanipal` prefix, including the UI itself.

Two components:
- **Frontend** — `src/frontend/dbviewer.html`, a single static HTML file
  (markup/CSS/JS together, framework-agnostic, no build step) embedded into
  the binary via `include_str!` in `src/routes.rs`. `jsonb` tree rendering
  and per-type cell/JSON coloring are hand-rolled directly in the file
  (`renderJsonTree`, `formatCellValue`) rather than pulled from a CDN — the
  original `@alenaksu/json-viewer`/Prism.js plan was superseded. A
  Monaco-based diff viewer remains a
  further-out deferral and the one place a CDN dependency is still under
  consideration; if it lands, it must be an enhancement only, i.e. the page
  keeps working if the CDN is unreachable.
- **Backend** — `src/config.rs` (kill switch + limits + siblings config),
  `src/db.rs` (the `DbSource` trait + its one impl, `PgPoolSource`),
  `src/routes.rs` (the Axum router and the five API handlers).

Read `docs/design.md` first for anything non-obvious — it's the source of
truth for intended behavior. `docs/filter-dsl.md` has the filter grammar
and its full test table (implement/verify against that table, not ad hoc
cases). `docs/ui-guidelines.md` and `docs/frontend-style-guide.md` are the
standing behavioral/structural rules for `dbviewer.html` (the *why* and the
*shape*, respectively) — read them before touching the frontend, not just
`design.md`. `docs/browser-quirks.md` is a living record of cross-browser
inconsistencies that were deliberately left as-is — check it before
"fixing" one, so a change doesn't relitigate a settled call or misread an
intentional gap as an oversight.

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
mise run test-e2e-install          # one-time Playwright browser install (Chromium/Firefox/WebKit)
mise run test-e2e                  # Playwright E2E suite against dbviewer.html (tools/e2e-tests)
```

`test-e2e` is a separate, standalone-dev-only suite (pnpm/Playwright,
`tools/e2e-tests/`) — it is **not** part of `mise run check` and doesn't
run in the Rust `cargo test` suite; run it explicitly for any change that
touches `dbviewer.html` beyond a trivial edit. Lessons already paid for
once, don't relearn them: assert on DOM state/attributes/text, not
screenshots (screenshot diffs were dropped project-wide for flakiness —
see git history around `157fc12`); wait on the actual signal that matters
(`waitForResponse`, `getAnimations()`), never `waitForTimeout` with a
guessed duration; and run the full suite under its default full
parallelism before calling a frontend change done — the worst races here
(stale-response overwrites, stuck spinners) only ever surfaced under real
concurrency, never in a single serial pass.

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
  `Config::is_enabled()` gates all six routes identically — if disabled,
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
  `allowed_columns` in `db.rs`); everything else is a bound parameter. The
  filter DSL's columns follow the same rule (`db.rs`'s `build_where_clause`):
  each condition's column is matched against `allowed_columns` before being
  spliced in, exactly like `sort` — the parsed column name from
  `src/filter.rs` is never trusted directly.
- **The filter DSL is implemented.** `src/filter.rs` is a pure, dependency-free
  parser (grammar in `docs/filter-dsl.md`) producing a `ParsedFilter`;
  `db.rs`'s `query_table` validates each condition's column against the live
  schema and maps each operator through a hardcoded SQL-fragment match
  before binding its value as a parameter — see `docs/filter-dsl.md` for the
  grammar and the full valid/rejected/adversarial test table it's verified
  against (`tests/black_box/filter_dsl.rs`).
- **Frontend has no build step.** `dbviewer.html` is hand-edited directly,
  not generated or bundled. Keep it a single self-contained file.
- **rustls everywhere, no OpenSSL.** Both `sqlx` and `reqwest` are
  configured for rustls specifically so embedding this crate doesn't impose
  a system TLS dependency on the host. Don't add a dependency that pulls in
  `native-tls`/OpenSSL.
- **Demo-only deps stay in `[dev-dependencies]`.** `tracing-subscriber`,
  `dotenvy` etc. must never leak into the published crate's dependency list.
- **Comments in `src/*.rs` follow the same discipline `frontend-style-guide.md`
  §3 already enforces for `dbviewer.html`.** A comment earns its place only
  by stating a non-obvious *why* — a security invariant, a Postgres quirk, a
  bug it guards against — in one or two sentences, never a *what* the
  type/function name already says, and never a citation-heavy restatement
  of a design doc. This drifted once already (verbose doc-section citations
  accumulated across `db.rs`/`filter.rs` over several feature PRs and needed
  a dedicated cleanup pass); don't let it recur.
