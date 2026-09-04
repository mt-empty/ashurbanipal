# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working style

Be terse — no restating what was just asked, no narrating obvious next steps.

### Comments and docs

- **Comments:** state only a non-obvious current constraint — a security
  invariant, driver/browser quirk, race, or test setup requirement. Keep them
  to one or two sentences. Do not narrate history, rejected alternatives, or
  another port's implementation; comments describe this code, not its lineage.
- **Documentation ownership:** `spec/protocol.md`, `spec/openapi.yaml`, and
  `spec/filter-dsl.md` are normative. `docs/adapter-decisions.md` records
  backend mechanisms and accepted gaps. `PORTING.md` owns porting/review
  workflow. `docs/design.md` is rationale, while frontend, browser, E2E, and
  publishing guides own their respective operational rules. Link to the owning
  document; do not restate it elsewhere.
- **Peer ports:** no implementation is canonical. Cross-port comparisons only
  belong in conformance or adapter-decision material when they explain an
  active compatibility constraint.

**Every commit subject MUST be a Conventional Commit** — `type(scope):
summary`, types `feat fix docs style refactor perf test build ci chore
revert security`, optional `!` for breaking. git-cliff builds each port's
`implementations/*/CHANGELOG.md` from these subjects, so a non-conforming
one is dropped from the generated notes. `.githooks/commit-msg` enforces
it locally and `pr-title-lint.yml` enforces the squash-merge title; run
`git config core.hooksPath .githooks` once per clone so the hooks fire.

## What this is

Ashurbanipal is a read-only web UI for browsing a host service's own
database tables (Postgres, SQLite, or MySQL) — no separate DB client, no
extra credentials, no build step. A host embeds it by mounting a router
under a fixed `/__ashurbanipal` prefix and gets every route under that
prefix — the API routes plus the UI itself. `spec/protocol.md` + `spec/openapi.yaml` are
the normative contract. The Rust crate at `implementations/rust/` is one
of **five peer language implementations**, all passing their own
conformance CI (table in `readme.md`): the others are Kotlin/Spring Boot
(`implementations/spring-boot-starter/`), Go/`net-http`
(`implementations/go-nethttp/`), Node/Express
(`implementations/node-express/`), and Python/Flask
(`implementations/flask-python/`). Rust itself ships two framework
adapters sharing one `core/` crate — `axum/` (the reference) and
`actix-web/` — each its own conformance target in `readme.md`'s table, but
still one language-level port, not two. None of the five is structurally
privileged over another — `PORTING.md` is the checklist a port must
clear, including the listing bar and cross-port hardening review. `spec/`,
`conformance/`, `docs/`, `frontend/`, and `tools/` are shared,
implementation-neutral and stay at the repo root.

**A note on what follows in this file**: the Commands and Architecture
invariants sections below go deep on the Rust implementation specifically
— that's this file's own bias (Rust is what most sessions in this repo
touch), not a statement that Rust is canonical; the invariants section
says which of its properties are protocol-level (required of every port)
vs. Rust/Cargo-specific. Read `implementations/<port>/README.md` for that
port's own commands and file layout when working outside Rust.

Two kinds of component — `docs/design.md` §3 has the full architecture:
- **Frontend** — `frontend/dbviewer.html`, one self-contained static file
  (markup/CSS/JS, no CDN dependency), shared byte-for-byte across every
  port. Generated from `frontend/src/` via `mise run frontend:build`;
  Rust and Go commit their vendored copy, Spring/Node/Flask regenerate
  theirs ephemerally (`PORTING.md` has the vendoring mechanics). The Rust
  crate embeds it via `include_str!` in
  `implementations/rust/axum/src/routes.rs`.
- **Backend** — one per port, each an independent implementation of
  `spec/protocol.md` in its own language. The Rust one is documented here
  in most depth, as the working example: a three-crate Cargo workspace at
  `implementations/rust/` — `core/` (framework-agnostic — config,
  `DbSource` and its Postgres/SQLite/MySQL implementations, the filter
  AST), `axum/` (the `ashurbanipal-axum` adapter), and `actix-web/` (a
  second adapter reusing `core/`) — mirrors how
  `juniper`/`async-graphql`/`utoipa` split core-plus-adapter crates; see
  `docs/feature-backlog/15-core-lib-plus-per-framework-adapter-per-port.md`
  for why. `docs/adapter-decisions.md` has where each language's DB
  backends' catalog queries diverge from Postgres.

Read `docs/design.md` first for architecture rationale. `spec/protocol.md` is
the normative endpoint contract (design.md §4 stays as rationale). `PORTING.md` is the contract
for adding or reviewing a port — what it reuses, what it implements, and
the governance/hardening checklist a reviewer signs off against.
`docs/adapter-decisions.md` is the companion registry of per-backend
protocol relaxations (Postgres vs. SQLite vs. MySQL today) where a MUST
can't be satisfied by the same mechanism on every engine. `spec/filter-dsl.md` has the
filter grammar and its full test table (implement/verify against that
table, not ad hoc cases) — it specs the *frontend's* DSL parser; the
backend's filter contract is the JSON AST in `spec/protocol.md`. `docs/ui-guidelines.md` and `docs/frontend-style-guide.md` are the
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

There's a `mise.toml` with tasks wrapping all of the below, organized in
layers — `mise tasks` lists them, `mise run <task>` runs one. Each
implementation/area has its own umbrella task that fans out to namespaced
`<layer>:*` subtasks, and top-level `check` runs everything:

```sh
mise run check                       # everything CI would run, across every implementation
mise run rust                        # rust:fmt-check + rust:lint + rust:test + rust:integration-test
mise run spring                      # spring gradle build + test
mise run go                          # go build/vet/fmt-check + test (go-nethttp)
mise run node                        # node lint + typecheck + build + test (node-express)
mise run flask                       # flask lint + fmt-check + test (flask-python, ruff + pytest via uv)
mise run frontend                    # frontend typecheck + build-check + ports-sync check + demo-sync check + Playwright e2e suite
mise run conformance                 # seed sync check + conformance:test + conformance:schema-test
mise run docs                        # docs:check-versions — readme.md version strings vs. the publishing-checklist ledger

mise run rust:build
mise run rust:test                       # unit tests live inline (#[cfg(test)] mod tests in config.rs, routes.rs)
mise run rust:test config::tests::name   # run a single test (extra args pass through)
mise run rust:integration-test           # axum's Postgres-backed tests/*.rs (schema_isolation, multi_source) — needs DATABASE_URL
mise run rust:integration-test-actix     # actix-web's Postgres-backed tests/multi_source.rs — needs DATABASE_URL
mise run rust:lint                       # cargo clippy -- -D warnings
mise run rust:fmt-check
mise run rust:demo                       # host demo app at http://localhost:4000/__ashurbanipal
mise run rust:demo-sibling               # second instance, to demo sibling health-poll
mise run rust:dev                        # demo app, auto-rebuild/restart on implementations/rust/{axum/src,core/src}/ or frontend/dbviewer.html changes (watchexec)
mise run actix:demo / actix:dev          # same pair, for the actix-web adapter
mise run go:demo / go:dev                # same pair, for go-nethttp
mise run node:demo / node:dev            # same pair, for node-express
mise run flask:demo / flask:dev          # same pair, for flask-python
mise run spring:demo / spring:dev        # same pair, for spring-boot-starter (port 4100, not 4000)

mise run conformance:seed-gen            # regenerate .devcontainer/db/init/01-seed.sql and conformance/seed/seed.sql
mise run conformance:seed-check          # verify both seed files still match tools/seed-gen's output
mise run frontend:test-e2e-install       # one-time Playwright browser install (Chromium/Firefox/WebKit)
mise run frontend:test-e2e               # Playwright E2E suite against frontend/dbviewer.html (tools/e2e-tests)
```

The `rust:*` tasks `cd` into `implementations/rust` (the workspace root —
`build`/`test`/`lint`/`fmt`/`fmt-check` run bare there and reach every
member) or `implementations/rust/axum` (`demo`/`demo-sibling`, which are
axum-specific) via mise's `dir` field — you don't need to `cd` yourself
when using `mise run`.

`frontend:test-e2e` is a separate, standalone-dev-only suite (pnpm/Playwright,
`tools/e2e-tests/`) that doesn't run in the Rust `cargo test` suite; run it
explicitly for any change that touches `dbviewer.html` beyond a trivial
edit — it is part of `mise run check` (via the `frontend` umbrella task),
but only that layer, not `rust`. Lessons already paid for once, don't
relearn them: assert on DOM state/attributes/text, not screenshots
(screenshot diffs were dropped project-wide for flakiness — see git history
around `157fc12`); wait on the actual signal that matters
(`waitForResponse`, `getAnimations()`), never `waitForTimeout` with a
guessed duration; and run the full suite under its default full
parallelism before calling a frontend change done — the worst races here
(stale-response overwrites, stuck spinners) only ever surfaced under real
concurrency, never in a single serial pass.

If mise isn't available, every port's own README documents its raw
build/test/demo commands (`implementations/<port>/README.md`). Rust's one
sharp edge worth knowing regardless of mise: from the
`implementations/rust/` workspace root, a bare `cargo run --example demo`
is ambiguous — `axum/` and `actix-web/` each ship their own
`examples/demo.rs` — so always pass `-p ashurbanipal-axum` or `-p
ashurbanipal-actix-web` explicitly (unnecessary, but harmless, when run
from inside that member's own directory, where it already resolves
unambiguously).

`mise run rust:dev` against the devcontainer's `DATABASE_URL` gives a
working, auto-restarting browser on the seed db in one command — treat
that as the acceptance bar for any change to the Rust implementation
specifically, not the plain `rust:demo` (which doesn't rebuild/restart on
further edits, so it goes stale the moment you touch a file again); every
other port has its own `<port>:dev` task for the same purpose (`go:dev`,
`node:dev`, `flask:dev`, `spring:dev`) — use that one, not `<port>:demo`,
for the same reason. Start it as a backgrounded shell
command so it stays harness-tracked — visible and stoppable via the
session's own task list — rather than a bare `&`/`nohup` that falls off
the radar for both you and the person watching the session; stop it once
verification is done instead of leaving it running unattended.

`tools/seed-gen` is a standalone dev-only crate (uses `fake`) — deliberately
not a dependency of the Rust crate, and not part of the workspace resolved
by the Rust crate's own `cargo` commands (each has its own
`Cargo.toml`/`Cargo.lock`, in different directories). Deterministic fixed
RNG seed, so regenerating without source edits produces an identical file.

## Architecture invariants — Rust implementation (don't break these)

Scoped to `implementations/rust/`. Most of these bullets are a Rust-code
expression of a protocol-level requirement every port is independently
held to (fail-closed kill switch, no unvalidated identifier reaching SQL,
schema isolation, the filter DSL contract, the single-file frontend
artifact) — checked via conformance CI and `PORTING.md`'s hardening
checklist, not repeated here per language. Three are not protocol-level at
all, just Rust-specific hygiene with no cross-language analog: rustls-only,
demo-deps-stay-dev-dependencies, and the Rust comment-style rule.

- **`DbSource` is the only seam to the database.** Route handlers never touch
  `sqlx` directly. Three implementations exist today — `postgres.rs`'s
  `PgPoolSource` (the default/reference), `sqlite.rs`'s `SqliteSource`
  (opt-in via the `sqlite` Cargo feature, off by default), and `mysql.rs`'s
  `MySqlSource` (opt-in via the `mysql` Cargo feature, off by default) —
  and the trait stayed native async-fn-in-trait (no `async_trait`) with the
  router generic over it (`router<S: DbSource>`, no `dyn`) even after the
  second and third impls landed. Keep it that way; per-backend behavioral
  differences belong in `docs/adapter-decisions.md`, not in a
  `dyn`/`async_trait` escape hatch.
- **Kill switch is fail-closed and checked once, at router construction.**
  `Config::is_enabled()` gates every route identically — if disabled,
  `router()` returns an empty `Router::new()`, so the mounted app 404s
  exactly as if the crate weren't merged in at all. Never add a route that
  bypasses this, and never move the enabled-check to per-request.
- **Ashurbanipal has no concept of "environment" and never will.** The kill
  switch is a bare `enabled: bool`, defaulting to `false`. Where and
  whether to turn it on is entirely the host's decision — this crate must
  never read, infer, or validate environment names (a prior design that
  rejected `enabled_for`/`environment` values naming production was
  removed; see `spec/protocol.md` §4). If you touch `config.rs`, preserve
  the fail-closed default (absent/malformed config MUST mean disabled),
  not any notion of which environment is "safe."
- **No unvalidated identifier ever reaches SQL text.** Table and column
  names are only ever spliced into a query after being matched exactly
  against a live catalog lookup (`information_schema` for Postgres and
  MySQL, `sqlite_master`/`pragma_table_info` for SQLite — each backend does
  its own in `db/postgres.rs` / `db/sqlite.rs` / `db/mysql.rs`); everything
  else is a bound parameter. The filter DSL's columns follow the same rule (each backend's
  own `build_where_clause`): each condition's column is matched against the
  live allow-list before being spliced in, exactly like `sort` — the parsed
  column name from `implementations/rust/core/src/filter.rs` is never trusted
  directly. On Postgres the table allow-list (and `list_tables` /
  `table_counts`) is additionally gated by `has_table_privilege(…,
  'SELECT')`, so the listing and the gate stay in lockstep and a table the
  role can't read is never offered or accepted. MySQL/MariaDB have no such
  function and the listing is left un-gated (see `docs/adapter-decisions.md`
  §5.2/§5.3); a residual `permission denied` (error 1142) at the row fetch
  is mapped to the same `NotAllowed` rejection instead.
- **Multi-schema queries pin one connection per operation.** `schema: None`
  resolves to the connection's default schema; an explicit value is
  allow-list-checked the same way. That resolution happens once, as the
  first statement of the operation's own transaction, so a later query in
  the same operation can't see a different schema after pool session reuse
  — see `docs/design.md` §5 and `implementations/rust/axum/tests/schema_isolation.rs`
  for the regression test. An endpoint that issues multiple schema-sensitive
  queries to build one response MUST stay on that one connection/transaction;
  never re-borrow from the pool mid-operation.
- **The filter DSL is implemented.** `implementations/rust/core/src/filter.rs` deserializes and
  structurally validates the JSON filter AST wire format (`spec/protocol.md` §5.4.2) — it never
  parses DSL text, that's frontend-only (`spec/filter-dsl.md`);
  each backend's `query_table` validates each condition's column against the live
  schema and maps each operator through a hardcoded SQL-fragment match
  before binding its value as a parameter — see `spec/filter-dsl.md` for the
  grammar and the full valid/rejected/adversarial test table it's verified
  against (`conformance/runner/filter_dsl.rs`). Per `spec/protocol.md`, DSL
  *text* parsing is becoming frontend-only and the wire contract is the
  JSON filter AST — the grammar doc specs the frontend parser, and the
  server-side steps (column allow-listing, operator mapping, value
  binding) are spec'd in `spec/protocol.md`.
- **The shipped frontend artifact stays one self-contained file.**
  `frontend/dbviewer.html` is generated (`mise run frontend:build`) from
  `frontend/src/`'s TypeScript modules + `styles.css` + `index.html`
  template, bundled with esbuild and inlined back into a single file —
  never hand-edited directly, and never split into separate `.css`/`.js`
  files in the *served* artifact. That single-file shape is load-bearing
  for every port's vendoring/CSP story (`PORTING.md`) and each port's
  vendoring checksum check; changing it is a `spec/protocol.md`-governance change,
  not a frontend refactor. `frontend/dbviewer.html` stays committed —
  CI (`frontend:build-check`) fails if it drifts from what `frontend/src/`
  currently builds.
- **rustls everywhere, no OpenSSL.** Both `sqlx` and `reqwest` are
  configured for rustls specifically so embedding this crate doesn't impose
  a system TLS dependency on the host. Don't add a dependency that pulls in
  `native-tls`/OpenSSL.
- **Demo-only deps stay in `[dev-dependencies]`.** `tracing-subscriber`,
  `dotenvy` etc. must never leak into the published crate's dependency list.
- **Comments in `implementations/rust/{axum/src,core/src}/**/*.rs` follow the same discipline `frontend-style-guide.md`
  §3 already enforces for `dbviewer.html`.** A comment earns its place only
  by stating a non-obvious *why* — a security invariant, a Postgres quirk, a
  bug it guards against — in one or two sentences, never a *what* the
  type/function name already says, and never a citation-heavy restatement
  of a design doc. This drifted once already (verbose doc-section citations
  accumulated across `db/*.rs`/`filter.rs` over several feature PRs and needed
  a dedicated cleanup pass); don't let it recur.
