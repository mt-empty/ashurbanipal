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

- [ ] **Repo/crate layout.** Decide: single crate vs. a workspace with the
      library crate plus a small example/demo service that embeds it. A
      demo binary doubles as an integration test harness and a living usage
      example.

- [ ] **Filter DSL: grammar and test plan, written before code.** This is
      the one piece where a bug is a security bug. Write the formal grammar
      (EBNF-ish is fine) and a table of test cases — valid inputs, and
      malicious inputs (`'; DROP TABLE`, stacked operators, unicode
      tricks) — before implementing the parser.

- [ ] **Acceptance criteria for "v1 done."** A short checklist derived from
      `design.md` (all 4+1 routes working, kill switch enforced incl.
      production rejection, filter DSL passes its test table, siblings
      health-poll works, embedded HTML serves) so there's an unambiguous
      stopping point.

- [ ] **Pin dependency versions deliberately.** `axum`, `sqlx` (which
      Postgres features/TLS), `serde`/`toml`, and whether `DbSource` uses
      native async-fn-in-traits (MSRV-dependent) or `async-trait`.

- [x] **CDN library research (frontend).** Done — see `cdn-research.md`.
      Picks: **`@alenaksu/json-viewer`** (Web Component) for the JSON tree
      viewer, **Prism.js** (core + `json`/`sql` grammars only) for syntax
      highlighting, **Monaco**'s diff editor for the deferred diff viewer.
      `@pierre/diffs` is ruled out: it has hard `react`/`react-dom` peer
      dependencies, incompatible with the framework-agnostic single-file
      frontend.
