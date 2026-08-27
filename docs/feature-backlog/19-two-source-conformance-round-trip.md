# True two-source round-trip in CI conformance

**Status:** resolved 2026-08-25. `conformance/runner/two_source.rs`
covers the properties below across all five ports, each with its own
two-source demo mode and a second `two-source-conformance` CI job (see
each `<port>-conformance.yml`), alongside the existing single-source
pass. It took the cheaper of the two mechanisms discussed below —
schema-pinning within the existing database, not a real second one — see
"Constraints / open questions" for why. `conformance/runner/COVERAGE.md`'s
Known gaps has what's still open. Rest of this document kept as-written
for the design history.

**Original status (2026-08-20):** discussed during the multi-source
support rollout. Deliberately deferred, not designed — capturing the
shape of the gap between what `conformance/runner/sources.rs` covers
today and what a real two-source fixture would need, per
`conformance/runner/COVERAGE.md`'s Known gaps entry for
`P5.8-LISTS-REGISTERED-SOURCES` (beyond the single-entry case),
`P5.8-STABLE-ORDER-IS-DEFAULT-ORDER`, and `P1-SOURCE-RESOLVED-ONCE`.

**Ask:** `conformance/runner/sources.rs` only proves the *shape* of the
`source`/`api/sources` feature against a single-source demo — that a
lone entry is listed, that an explicit-correct value matches the implicit
default, and that a wrong value 400s on every route. It never proves two
distinct, differently-seeded sources actually route to different data —
the property the whole feature exists for. That needs a demo spawned
with a second source registered, which `conformance/runner/common.rs`'s
`TestServer::spawn()` doesn't do today (single spawn, single source,
always).

**What already exists to build on:** the axum reference implementation's
`SECOND_SOURCE=1` env var (`implementations/rust/axum/examples/demo.rs`)
already registers a real second Postgres database (`primary` +
`reporting`) when set, seeded by
`.devcontainer/db/init/02-reporting-seed.sql`. That file is
**devcontainer-only** — it's mounted via `docker-entrypoint-initdb.d` in
`.devcontainer/docker-compose.yml` and only ever runs against the
devcontainer's persistent Postgres volume. CI's conformance workflows
(`_conformance-behavior.yml`, `_conformance-schema.yml`) don't use that
directory at all: they spin up a bare `postgres:18-alpine` service
container with no init-script mount, and seed it with an explicit
`psql -f conformance/seed/seed.sql` step. So provisioning a second
database in CI needs its own seed file under `conformance/seed/`
(mirroring `.devcontainer/db/init/02-reporting-seed.sql`'s content, or
generated alongside it the same way `mise run conformance:seed-gen`
already keeps `.devcontainer/db/init/01-seed.sql` and
`conformance/seed/seed.sql` in sync from one `tools/seed-gen` source) —
not just reusing the devcontainer file directly.

**Shape of the work, not yet designed in detail:**
1. A `conformance/seed/reporting-seed.sql` (or similar) mirroring
   `.devcontainer/db/init/02-reporting-seed.sql`'s `CREATE DATABASE` +
   `\connect` + seed shape, applied via an extra `psql -f ...` step in
   `_conformance-behavior.yml`/`_conformance-schema.yml` alongside the
   existing one.
2. Either a new `start-command` variant that passes `SECOND_SOURCE=1` (or
   whatever env var each port's own demo ends up using once other ports
   grow an equivalent second-source demo mode — today only axum's
   `demo.rs` has one), or a dedicated second conformance job/workflow
   input specifically for the two-source scenario, run alongside (not
   instead of) the existing single-source pass — the single-source
   regression coverage `sources.rs` already has must keep running
   unconditionally, not get replaced by the two-source variant.
3. A new `conformance/runner/two_source.rs` (or an extension of
   `sources.rs`, gated on whether the target demo was spawned with a
   second source) covering the properties `sources.rs` can't reach today:
   `source=reporting` returns genuinely different tables/data than the
   default, `api/sources` lists both in stable registration order and
   that order matches the default-resolution order, and a multi-query
   operation (`/tables/data`, `/tables/common-values`) never drifts
   between sources mid-response the way `schema_isolation.rs` already
   proves for schema.
4. Workflow path-filter updates on `rust-axum-conformance.yml` (and any
   other port's conformance workflow that grows an equivalent two-source
   demo mode) to trigger on whatever new seed file path is added under
   `conformance/seed/`.

**Constraints / open questions:**
- This is Rust/axum-specific today (the only port with a `SECOND_SOURCE`
  demo mode) — decide whether the two-source conformance job stays
  axum-only, or whether it's worth asking each port to grow an equivalent
  before this lands, so the fixture proves cross-port parity rather than
  just axum's own correctness.
- Whether a genuinely separate second Postgres *database* is worth the
  CI complexity, versus mirroring Go's own two-source integration test
  trick (`implementations/go-nethttp/source_integration_test.go`: two
  pools pinned to different `search_path`s within the *same* database,
  reusing the existing `other_schema`/`decoy_items` seed fixture) — that
  approach needs zero new CI infrastructure at all, at the cost of not
  proving genuinely separate storage/connections the way a real second
  database does. Worth deciding which property this fixture is actually
  meant to prove before picking the mechanism.
- Keep the single-source regression suite (`sources.rs`, already landed)
  running unconditionally regardless of how this is resolved — it's the
  cheap, always-on guard that the feature stays additive; the two-source
  fixture is strictly additional coverage, not a replacement.
