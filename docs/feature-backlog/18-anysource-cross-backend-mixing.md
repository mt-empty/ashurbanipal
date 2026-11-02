# Mix database backends in one Rust router (Postgres + SQLite in one process)

> **Status:** DONE · **Area:** rust, docs · **Ref:** shipped as `Source` in `implementations/rust/core/src/db/source.rs`

**Ask:** one Rust `router()` call (axum) or `app_state()` call (actix-web)
registers N named sources, but every source had to be the same concrete
`DbSource` type. A host could run several Postgres databases side by side,
but not Postgres next to SQLite. The other four ports already allowed this:

| Port | Sources held as | Mixed engines |
|---|---|---|
| Go | `[]NamedSource`, each holding a `DbSource` interface (`routes.go`) | yes |
| Node | `NamedSource[]` over a `DbSource` interface (`routes.ts`) | yes |
| Flask | `Sequence[tuple[str, DbSource]]` (`routes.py`) | yes |
| Spring | `Map<String, DbSource>`, engine picked per configured source (`AshurbanipalAutoConfiguration.kt`) | yes |
| Rust | `Vec<(String, S)>`; mixed hosts pass `S = Source` | yes (was **no**) |

**What shipped:** `Source::new(source)` wraps any `DbSource`, including a
host's own, and `Source` is itself a `DbSource`. The router API is
unchanged, so nothing breaks; `docs/design.md` §5 has the mechanism.

**Tests:**
- `axum/src/routes.rs`: one router holding two different `DbSource` types
  (no database).
- `axum/tests/mixed_backends.rs`: one router with an in-memory SQLite source
  and a MySQL source, reading tables and rows from each (part of
  `rust:integration-test-mysql`).
- `rust:demo-mixed` / `rust:dev-mixed`: the Postgres seed db plus a SQLite
  `local` source, for manual checks.

**Out of scope:** mixed engines inside one join (a join never crosses a
source; story 44), and the other ports.
