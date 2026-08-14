# Split each port into a framework-agnostic core + thin framework adapter

**Status:** discussed 2026-08-10, alongside the Rust crate rename
`ashurbanipal` → `ashurbanipal-axum` (`docs/publishing-checklist.md`'s
"Decided: no bare `ashurbanipal` package name" section). Not designed,
not scheduled — capturing the shape of the idea and the per-language
feasibility check before it's picked up.

**Ask:** if a port ever needs to support a second web framework in the
same language (Actix alongside Axum, FastAPI alongside Flask, Fastify
alongside Express, Ktor alongside Spring Boot), split that port into a
framework-agnostic core library (config, kill switch, `DbSource`-equivalent
backends, filter-DSL validation, frontend embedding) plus a thin
per-framework adapter crate/package that only wires HTTP
routing/extraction into the core. Same shape as `juniper`/`juniper_axum`,
`async-graphql`/`async-graphql-axum`, `utoipa`/`utoipa-axum` — one core,
one published artifact per framework, all developed in this same repo as
a language-native workspace, not a separate repo per artifact.

**Not the same idea as [[11-wasm-core-for-multi-language-ports]]:** that
item is one WASM core shared *across every language*, with the deployment-
model cost of embedding a WASM runtime in every host. This is native,
per-language, and only pays for itself once a language actually grows a
second framework — no new runtime dependency, just a workspace split using
each language's own normal tooling.

**Per-language feasibility (checked, not assumed):**

- **Rust — clean split, already verified.** `implementations/rust/src/config.rs`,
  `filter.rs`, and every file under `db/` have zero `axum` references;
  only `routes.rs` (7 hits) and `lib.rs`'s doctest touch it. Extracting
  `routes.rs` into `ashurbanipal-axum` (already the crate's name) and
  everything else into a new `ashurbanipal` core crate would be a clean
  workspace split, reclaiming the bare name for the framework-agnostic
  piece — consistent with the `juniper`/`async-graphql` naming precedent.
- **Node — clean split, same shape, not yet verified as thoroughly.**
  `implementations/node-express/src/{config,embed,errors,filter,siblings}.ts`
  have zero `express` references; only `routes.ts` (3 hits) and the demo
  entrypoint `index.ts` (1 hit, not part of the published package) touch
  it.
- **Flask — clean split, same shape, not yet verified as thoroughly.**
  `implementations/flask-python/ashurbanipal/{config,embed,filter}.py`
  have zero `flask`/`Flask` references; only `routes.py` (3 hits) and the
  package's `__init__.py` (1 hit, a re-export) touch it.
- **Spring/Kotlin — likely NOT a clean split, needs real investigation
  before assuming the same pattern applies.** Unlike the other three,
  Spring's coupling isn't confined to the controller layer:
  `PostgresSource.kt` and `MySqlSource.kt` import
  `org.springframework.jdbc.core.JdbcTemplate`/`RowMapper` and
  `org.springframework.transaction.support.TransactionTemplate` — Spring's
  JDBC convenience layer is baked into the DB-backend implementations
  themselves, not just `DbViewerController.kt`/`AshurbanipalAutoConfiguration.kt`.
  A hypothetical Ktor adapter either drops to raw JDBC in a genuinely
  framework-agnostic core (real rewrite of the DB layer, not just moving
  files) or a "core" module still carries a Spring dependency, defeating
  the point. Confirm which before scoping any Kotlin split — don't assume
  it mirrors Rust/Node/Flask.
- **Go — exempt, nothing to do.** `Router(cfg, source) (http.Handler, error)`
  (`implementations/go-nethttp/routes.go:44`) already returns the stdlib
  interface every Go framework speaks; there's no framework-specific
  return type to split away from in the first place.

**Constraints / open questions:**
- Don't do this preemptively — it's premature abstraction until a second
  framework in some language is an actual, real piece of work about to
  start, not a hypothetical. The Rust rename to `ashurbanipal-axum` was
  worth doing now because it was a free, non-regrettable name reservation;
  an actual workspace split is not free (two-plus manifests to version,
  publish, and keep in sync per language) and should wait for a real
  second consumer.
- When it does happen for a given language, it stays in this repo as a
  workspace nested under that language's `implementations/<port>/`
  directory (Cargo workspace, npm/pnpm workspace, etc.) — mirroring how
  `juniper`/`async-graphql`/`utoipa` each keep core + every framework
  adapter in one repo, and consistent with this project already being one
  repo across all five ports.
- Naming: bare `<language-native-name>` (e.g. plain `ashurbanipal` for
  Rust) is reserved for the eventual framework-agnostic core, per
  `docs/publishing-checklist.md`; each framework adapter is suffixed
  (`ashurbanipal-axum`, `ashurbanipal-actix`, ...). Node/Flask/Spring
  already publish under framework-suffixed names
  (`ashurbanipal-node-express`, `ashurbanipal-flask`,
  `ashurbanipal-spring-boot-starter`) so the same reservation question
  applies to each of them once/if a second framework is real for that
  language.
- A host adding the framework-specific package should still only need to
  add one dependency and get the core transitively (`ashurbanipal-axum`
  depends on `ashurbanipal`) — same UX as today's "single crate to embed"
  pitch, not a regression into "add two packages."
