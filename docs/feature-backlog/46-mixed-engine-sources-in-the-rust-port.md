# Mixed-engine sources in the Rust port

> **Status:** OPEN · **Area:** ports, docs · **Ref:** found in the 2026-10-25 architecture review of source/schema/table use

Let one Rust host register sources on different engines, for example a
Postgres source and a SQLite source, as the other ports already can.

## 1. The ask

`spec/protocol.md` §5.8 hides each source's engine ("responses MUST NOT
include which backend engine a source uses"), which implies a host may mix
engines. The other ports allow it:

| Port | Sources held as | Mixed engines |
|---|---|---|
| Go | `[]NamedSource`, each holding a `DbSource` interface (`routes.go`) | yes |
| Node | `NamedSource[]` over a `DbSource` interface (`routes.ts`) | yes |
| Flask | `Sequence[tuple[str, DbSource]]` (`routes.py`) | yes |
| Spring | `Map<String, DbSource>`, engine picked per configured source (`AshurbanipalAutoConfiguration.kt`) | yes |
| Rust | `Vec<(String, S)>` for one `S: DbSource` (`axum/src/routes.rs`) | **no** |

Rust's router is generic over one concrete source type, and CLAUDE.md rules
out `dyn` and `async_trait` for `DbSource`. So a Rust host cannot register a
`PgPoolSource` and a `SqliteSource` together.

## 2. Plan

Do option 2 now. Build option 1 when a host asks for mixed engines; none
has yet.

1. **An `AnySource` enum in `core`**, when a host needs it.
   - `enum AnySource { Postgres(PgPoolSource), Sqlite(SqliteSource), MySql(MySqlSource) }`
   - Each variant sits behind its existing Cargo feature.
   - `impl DbSource for AnySource` hands each method to the variant: about
     nine methods.
   - Dispatch stays static, the trait stays native async-fn-in-trait, and
     `router<S: DbSource>` is unchanged: a host passes
     `Vec<(String, AnySource)>`.
   - Both adapters (axum, actix-web) get it for free.
2. **Record it as an accepted gap** in `docs/adapter-decisions.md`, and say
   that a Rust host is single-engine. Do this now.

## 3. Check before building option 1

- Whether any per-engine behaviour leaks above `DbSource`: config, pool
  setup, the demo's `SECOND_SOURCE` wiring. `AnySource` must not need
  engine checks outside `core`.
- That the enum adds no dependency when only one engine feature is on.

## 4. What "done" means

- Now (option 2): the `docs/adapter-decisions.md` entry, linked from the
  Rust README.
- Later (option 1):
  - a unit test registers a Postgres and a SQLite source in one router and
    reads tables from both;
  - `rust:lint` passes with every feature combination CI builds;
  - `implementations/rust/README.md` shows the mixed setup, and the
    accepted-gap entry is removed.

## 5. Out of scope

- Mixed engines inside one join (a join never crosses a source; story 44).
- Changing the other ports.
