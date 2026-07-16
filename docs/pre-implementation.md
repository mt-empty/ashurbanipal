# Pre-implementation checklist

Things to work through before scaffolding the Rust crate. Not part of the
design itself (see `design.md`) — this is the punch list for getting ready
to write code deliberately rather than rushing in.

- [x] **Local dev environment for Postgres.** Done — `.devcontainer` is now
      docker-compose based: `app` (the existing Rust toolchain/features) and
      `db` (`postgres:18-alpine`, persistent named volume) as sibling
      containers on the compose network. `DATABASE_URL` is set via
      `containerEnv` (`postgres://ashurbanipal:ashurbanipal@db:5432/ashurbanipal`).
      Seed data (`users`/`orders`, covering uuid/jsonb/timestamptz/boolean)
      loads automatically from `.devcontainer/db/init/01-seed.sql` on first
      volume creation. Verified after rebuild: `db` resolves and accepts
      connections, `psql` confirms `users`/`orders` seeded correctly, and
      `pg_class.reltuples` reports real counts (5/15) thanks to the `ANALYZE`
      in the seed script. Note: postgres 18's image expects the volume
      mounted at `/var/lib/postgresql` (not `.../data`) — mounting at the old
      path throws a `pg_ctlcluster`-layout error on start; the compose file
      already uses the corrected path. `postCreateCommand` installs
      `postgresql-client` so `psql` is available for manual inspection.

- [x] **Repo/crate layout.** Decided: **single crate + `examples/demo.rs`**
      (not a workspace). Options considered:
      - *Single crate, lib only* — simplest, but no runnable way to click
        through `dbviewer.html`, exercise the kill switch, or demo the
        sibling health-poll UI without external plumbing.
      - *Single crate + `examples/demo.rs`* (chosen) — idiomatic Rust
        convention (`cargo run --example demo`). Demo-only deps
        (`tracing-subscriber`, `dotenvy`, `tower-http` static serving) live
        in `[dev-dependencies]`, invisible to anything embedding the
        published lib. One `Cargo.toml`/`Cargo.lock`, no path-dependency
        indirection. The example doubles as an integration-test harness
        (`tests/` can spawn it) and a living usage example. Sibling
        health-polling can still be demoed by running the example twice on
        different ports/configs — no second crate needed for that.
      - *Cargo workspace* (lib crate + separate demo crate) — fully isolates
        the demo's dependency graph and leaves room for future crates (e.g.
        a non-Postgres `DbSource` adapter), but that's premature structure
        for a project that's still pre-code with only one crate's worth of
        real logic in v1. Revisit if/when a second adapter crate actually
        gets built.

- [x] **Filter DSL: grammar and test plan, written before code.** Done —
      see `filter-dsl.md`: EBNF grammar (flat `AND`/`OR` chain, AND binds
      tighter, no parentheses/`NOT`; quoted values with `''` escaping),
      semantics (parse → triples → allow-listed operators + bound params),
      and a 38-case test table (valid / rejected / adversarial). Prior art
      (RSQL/FIQL, `postgrest-parser`) reviewed and consciously not taken as
      a dependency — hand-written parser, RSQL-inspired shape. `design.md`
      §4.1 updated to match (OR is now in scope). **Implementation is
      deliberately last in the server build order**; until then the filter
      param is rejected wholesale by a stub.

- [x] **Acceptance criteria for "v1 done."** Done — see
      `acceptance-criteria.md`: seven sections (routes, kill switch, query
      safety, filter DSL, siblings, frontend, packaging), every item
      checkable by running something. Notable interpretations made there:
      disabled routes return 404 (indistinguishable from "not mounted");
      `enabled_for = ["any"]` expands to non-production only; CDN
      unavailability degrades the UI (raw JSON instead of tree view) but
      never breaks browsing.

- [x] **Pin dependency versions deliberately.** Done — see
      `dependencies.md`. Headlines: axum `0.8`, sqlx `0.9` with
      rustls + `uuid`/`chrono`/`json` type features, `toml` `1` (now a 1.x
      crate), reqwest `0.13` (rustls, health checks only). **No
      `async-trait`** — native async-fn-in-trait with a generic router
      (`router<S: DbSource>`), since v1 has one impl and no `dyn`;
      `design.md` §5 updated. rustls everywhere (no OpenSSL host build
      dep). Caret reqs in `Cargo.toml`, `Cargo.lock` committed,
      MSRV 1.80 declared via `rust-version`.

- [x] **CDN library research (frontend).** Done — see `cdn-research.md`.
      Picks: **`@alenaksu/json-viewer`** (Web Component) for the JSON tree
      viewer, **Prism.js** (core + `json`/`sql` grammars only) for syntax
      highlighting, **Monaco**'s diff editor for the deferred diff viewer.
      `@pierre/diffs` is ruled out: it has hard `react`/`react-dom` peer
      dependencies, incompatible with the framework-agnostic single-file
      frontend.
