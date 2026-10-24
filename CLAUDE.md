# CLAUDE.md

## Working style

Be terse — no restating what was just asked, no narrating obvious next steps.

### Comments and docs

- **Comments:** state only a non-obvious current constraint — a security
  invariant, driver/browser quirk, race, or test setup requirement. Keep them
  to one or two sentences. Do not narrate history, rejected alternatives, or
  another port's implementation; comments describe this code, not its lineage.
- **Documentation ownership:** `spec/protocol.md`, `spec/openapi.yaml`,
  `spec/filter-dsl.md`, and `spec/join-dsl.md` are normative. `docs/adapter-decisions.md` records
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
extra credentials, no build step. A host mounts a router under a fixed
`/__ashurbanipal` prefix and gets the API routes plus the UI.
`spec/protocol.md` + `spec/openapi.yaml` are the contract.

Every language implementation is a peer, each passing its own conformance
CI (table in `readme.md`): Rust (`implementations/rust/`), Kotlin/Spring
Boot (`implementations/spring-boot-starter/`), Go/`net-http`
(`implementations/go-nethttp/`), Node/Express
(`implementations/node-express/`), and Python/Flask
(`implementations/flask-python/`). Rust ships two framework adapters over
one `core/` crate — `axum/` and `actix-web/` — each its own conformance
target but one language-level port. `PORTING.md` is the checklist every
port clears. `spec/`, `conformance/`, `docs/`, `frontend/`, and `tools/`
are shared and implementation-neutral.

The Commands and invariants sections below go deepest on Rust because most
sessions touch it, not because it is canonical; for another port, read
`implementations/<port>/README.md`.

Two kinds of component — `docs/design.md` §3 has the full architecture:
- **Frontend** — `frontend/dbviewer.html`, one self-contained static file
  (markup/CSS/JS, no CDN dependency), shared byte-for-byte across every
  port and generated from `frontend/src/` by `mise run frontend:build`.
  `mise run frontend:sync-ports` copies it into each port: Rust and Go
  commit their vendored copy, Spring/Node/Flask regenerate theirs
  ephemerally (`PORTING.md` has the mechanics). axum embeds its copy,
  `implementations/rust/axum/frontend/dbviewer.html`, via `include_str!`
  in `src/routes.rs`.
- **Backend** — one per port, each an independent implementation of
  `spec/protocol.md`. Rust's is a three-crate Cargo workspace at
  `implementations/rust/`: `core/` (framework-agnostic — config,
  `DbSource` and its Postgres/SQLite/MySQL implementations, the filter
  AST, the `/api/siblings` health checks), `axum/` (`ashurbanipal-axum`),
  and `actix-web/`. `docs/feature-backlog/15-core-lib-plus-per-framework-adapter-per-port.md`
  has why.

Before working, read `docs/design.md` for rationale. Before touching the
frontend, also read `docs/ui-guidelines.md` (behavior, the *why*) and
`docs/frontend-style-guide.md` (structure, the *shape*). Before "fixing" a
cross-browser inconsistency, check `docs/browser-quirks.md`: it records the
ones deliberately left as-is. Verify the frontend's filter parser against
the test table in `spec/filter-dsl.md`, not ad hoc cases.

## Commands

This is a devcontainer project; a Postgres instance (`db`, seeded via
`.devcontainer/db/init/01-seed.sql`) is expected to be reachable at
`DATABASE_URL` (set automatically by the devcontainer).

There's a `mise.toml` (tools, settings, and the top-level umbrella tasks)
plus per-layer `mise-tasks/*.toml` (the namespaced `<layer>:*` subtasks) —
`mise tasks` lists them, `mise run <task>` runs one. `mise.lock` is
committed and pins each tool to an exact version; refresh it with `mise
lock` after editing `[tools]`. Each area's umbrella task fans out to its
subtasks, and top-level `check` runs them all:

```sh
mise run check                       # everything CI would run: every umbrella task below
mise run rust                        # rust:fmt-check + rust:lint + rust:test + rust:integration-test
mise run spring                      # spring gradle build + test
mise run go                          # go build/vet/fmt-check + test (go-nethttp)
mise run node                        # node lint + typecheck + build + test (node-express)
mise run flask                       # flask lint + fmt-check + test (flask-python, ruff + pytest via uv)
mise run frontend                    # frontend lint, cycle + api-reference checks, typecheck, unit tests, build/ports/demo sync checks, full e2e suite
mise run conformance                 # seed sync check + conformance:test + conformance:schema-test
mise run docs                        # readme.md versions vs. the publishing ledger; feature-backlog index vs. entry headers
mise run changelog                   # each port's CHANGELOG.md top section matches its manifest version

mise run rust:build
mise run rust:test                       # unit tests, inline #[cfg(test)] modules across core/ and both adapters
mise run rust:test config::tests::name   # run a single test (extra args pass through)
mise run rust:integration-test           # axum's Postgres-backed tests/*.rs — needs DATABASE_URL
mise run rust:integration-test-actix     # actix-web's Postgres-backed tests/multi_source.rs — needs DATABASE_URL
mise run rust:lint                       # cargo clippy -- -D warnings
mise run rust:fmt-check
mise run rust:demo                       # host demo app at http://localhost:4000/__ashurbanipal
mise run rust:demo-sibling               # second instance on 4001, to demo sibling health-poll
mise run rust:dev                        # demo app, auto-rebuild/restart on Rust sources or axum's vendored dbviewer.html (watchexec)
mise run actix:demo / actix:dev          # same pair, for the actix-web adapter
mise run go:demo / go:dev                # same pair, for go-nethttp
mise run node:demo / node:dev            # same pair, for node-express
mise run flask:demo / flask:dev          # same pair, for flask-python
mise run spring:demo / spring:dev        # same pair, for spring-boot-starter (port 4100, not 4000)

mise run frontend:build                  # frontend/src/ → frontend/dbviewer.html
mise run frontend:sync-ports             # copy dbviewer.html into every port and re-pin its checksums
mise run frontend:watch                  # build + sync-ports on every frontend/src/ change
mise run frontend:dev                    # frontend:watch + the Node demo at http://localhost:4002/__ashurbanipal

mise run conformance:seed-gen            # regenerate .devcontainer/db/init/01-seed.sql and conformance/seed/seed.sql
mise run conformance:seed-check          # verify both seed files still match tools/seed-gen's output
mise run frontend:test-e2e-install       # one-time Playwright browser install (Chromium/Firefox/WebKit)
mise run frontend:test-e2e-spec tests/<name>.spec.ts   # rebuild + sync, then one spec on Chromium + Firefox (iterating)
mise run frontend:test-e2e-quick         # rebuild + sync, then the whole suite on Chromium + Firefox
mise run frontend:test-e2e               # full three-browser suite against axum's vendored dbviewer.html
```

The `rust:*` tasks `cd` into `implementations/rust` (the workspace root —
`build`/`test`/`lint`/`fmt`/`fmt-check` run bare there and reach every
member) or `implementations/rust/axum` (`demo`/`demo-sibling`, which are
axum-specific) via mise's `dir` field — you don't need to `cd` yourself
when using `mise run`.

`rust:dev` and the e2e suite serve axum's vendored copy, not
`frontend/dbviewer.html`, so a frontend change shows up in `rust:dev` only
once `frontend:sync-ports` has run after `frontend:build`
(`frontend:watch` does both).

The Playwright suite (`tools/e2e-tests/`, not part of `cargo test`) is
required for any change that touches `dbviewer.html` beyond a trivial
edit. `docs/e2e-testing-guidelines.md` owns how to run it (§5: which tier
when; the full three-browser run, once, at the end, is what makes a change
done) and how to write reliable specs (§1–§4).

If mise isn't available, every port's own README documents its raw
build/test/demo commands (`implementations/<port>/README.md`). Rust's one
sharp edge worth knowing regardless of mise: from the
`implementations/rust/` workspace root, a bare `cargo run --example demo`
is ambiguous — `axum/` and `actix-web/` each ship their own
`examples/demo.rs` — so always pass `-p ashurbanipal-axum` or `-p
ashurbanipal-actix-web` explicitly (unnecessary, but harmless, when run
from inside that member's own directory).

`mise run rust:dev` against the devcontainer's `DATABASE_URL` gives a
working, auto-restarting browser on the seed db in one command — treat
that as the acceptance bar for any change to the Rust implementation
specifically, not the plain `rust:demo` (which doesn't rebuild/restart on
further edits, so it goes stale the moment you touch a file again); every
other port has its own `<port>:dev` task for the same purpose — use that
one, not `<port>:demo`, for the same reason. Start it as a backgrounded
shell command so it stays harness-tracked — visible and stoppable via the
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
schema isolation, the filter contract, the single-file frontend
artifact) — checked via conformance CI and `PORTING.md`'s hardening
checklist, not repeated here per language. Two are Rust-specific hygiene
with no cross-language analog: rustls-only and
demo-deps-stay-dev-dependencies.

- **`DbSource` is the only seam to the database.** Route handlers never touch
  `sqlx` directly. Each implementation sits behind its own Cargo feature:
  `postgres.rs`'s `PgPoolSource` (`postgres`, on by default but removable
  with `default-features = false`), `sqlite.rs`'s `SqliteSource` and
  `mysql.rs`'s `MySqlSource` (`sqlite`, `mysql`, both off by default), so
  code that names one needs the matching `#[cfg(feature = …)]`. Keep
  the trait native async-fn-in-trait (no `async_trait`) and the router
  generic over it (`router<S: DbSource>`, no `dyn`); per-backend behavioral
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
  never read, infer, or validate environment names (`spec/protocol.md` §4).
  If you touch `config.rs`, preserve the fail-closed default
  (absent/malformed config MUST mean disabled).
- **No unvalidated identifier ever reaches SQL text.** Table and column
  names — including `sort` and every filter condition's column — are only
  spliced into a query after an exact match against a live catalog lookup,
  done by each backend in `db/postgres.rs` / `db/sqlite.rs` /
  `db/mysql.rs`; everything else is a bound parameter. On Postgres the
  table allow-list and the table listing are both gated by
  `has_table_privilege(…, 'SELECT')`, so they stay in lockstep;
  `docs/adapter-decisions.md` §5.2/§5.3 has how MySQL/MariaDB differ.
- **Multi-schema queries pin one connection per operation.** `schema: None`
  resolves to the connection's default schema; an explicit value is
  allow-list-checked the same way. That resolution happens once, as the
  first statement of the operation's own transaction, so a later query in
  the same operation can't see a different schema after pool session reuse
  — see `docs/design.md` §5 and `implementations/rust/axum/tests/schema_isolation.rs`
  for the regression test. An endpoint that issues multiple schema-sensitive
  queries to build one response MUST stay on that one connection/transaction;
  never re-borrow from the pool mid-operation.
- **The backend takes a JSON filter AST, never DSL text.**
  `implementations/rust/core/src/filter.rs` deserializes and structurally
  validates it (`spec/protocol.md` §5.4.2); each backend's `query_table`
  allow-lists the columns as above and maps each operator through a
  hardcoded SQL-fragment match before binding its value.
  `conformance/runner/filter_dsl.rs` verifies it against
  `spec/filter-dsl.md`'s test table.
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
- **Comments follow the repo-wide rule under Working style**, the same
  discipline `frontend-style-guide.md` §3 sets for `dbviewer.html` — and
  are never a citation-heavy restatement of a design doc.
