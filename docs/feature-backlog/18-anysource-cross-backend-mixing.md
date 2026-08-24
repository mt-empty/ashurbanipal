# `AnySource` enum for cross-backend source mixing (Postgres + SQLite in one process)

**Status:** discussed 2026-08-20, during the multi-source support rollout
(`spec/protocol.md` §1 "Resolved source", new `GET api/sources` route,
`source` param on §5.2–§5.5/§5.7). Deliberately deferred, not designed —
capturing the shape of the gap and why it was left out of the initial
rollout, per `docs/design.md`'s `GET /sources` section and
`conformance/runner/COVERAGE.md`'s Known gaps.

**Ask:** today, one Rust `router()` call (axum or actix-web) registers N
named sources, but every source in that call MUST be the same concrete
`DbSource` implementation — a host can run several Postgres databases
side by side, but not a Postgres database alongside a SQLite one, in the
same process. Lift that restriction so a single host can mix backends
across its registered sources, matching what the other four ports already
get for free.

**Why Rust alone needs new code for this, and the other ports don't:**
`implementations/rust/core/src/db/mod.rs`'s `DbSource` trait is native
async-fn-in-trait — no `dyn DbSource`, no `async_trait` (a load-bearing
architecture invariant, `CLAUDE.md`'s "Rust implementation" section) — and
both `axum::routes::router<S: DbSource>` and actix-web's
`app_state<S: DbSource>` are generic over exactly one concrete type `S`.
`Vec<(String, S)>` can hold several sources, but they're all the same `S`.
Go's `DbSource` interface, TypeScript's `DbSource` interface, Python's
`DbSource(abc.ABC)`, and Kotlin's `DbSource` interface are all
structurally-typed/dynamically-dispatched already — a
`map[string]DbSource` / `Record<string, DbSource>` / `dict[str,
DbSource]` / `Map<String, DbSource>` holding a mix of concrete backend
types costs nothing extra in any of those four languages, since each
already dispatches through the interface per-request. Rust is the outlier
because the whole point of the async-fn-in-trait design was avoiding that
dispatch cost.

**Shape of the fix, not yet designed in detail:** an `AnySource` enum in
`implementations/rust/core/` with one variant per compiled-in backend
(`Postgres(PgPoolSource)`, `Sqlite(SqliteSource)`, `Mysql(MySqlSource)`,
each behind its existing Cargo feature gate), itself implementing
`DbSource` by matching on the variant and delegating — still static
dispatch, no `dyn`, so it doesn't violate the architecture invariant it's
working around. `router()`/`app_state()` would need either a second entry
point accepting `Vec<(String, AnySource)>` alongside the existing
single-type-generic one, or a way for the existing generic path to keep
working unchanged for the (overwhelmingly common) homogeneous case while
`AnySource` handles the mixed case — avoid forcing every single-backend
host to pay an extra match-dispatch indirection just because the
heterogeneous case exists somewhere in the codebase.

**Constraints / open questions:**
- Where does `AnySource` live — `core/` (shared by axum and actix-web, so
  both adapters get it for free) or duplicated per-adapter? `core/` is
  almost certainly right, mirroring how `PgPoolSource`/`SqliteSource`/
  `MySqlSource` already live there.
- Does `GET api/sources`' response gain a `backend` field once mixing is
  real? The wire contract was deliberately left open to this
  (`spec/protocol.md` §5.8: "no other field is defined" today, not "no
  other field ever will be") — a host mixing Postgres and SQLite sources
  in one process is exactly the case where knowing which is which
  actually matters to someone browsing the UI, unlike the homogeneous
  case where it's redundant. If added, needs the same field on the other
  four ports' `api/sources` responses too, for one consistent wire shape
  across all five.
- Whether this is worth building at all before a real host asks for it —
  the original ask that motivated multi-source support (a Spring Boot
  host with multiple Spring `DataSource` beans) never needed cross-backend
  mixing; treat this as speculative until a concrete use case shows up,
  consistent with how [[15-core-lib-plus-per-framework-adapter-per-port]]
  was scoped ("don't do this preemptively").
