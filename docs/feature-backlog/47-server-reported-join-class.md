# Server-reported join class per column

> **Status:** OPEN · **Area:** spec, ports, conformance, frontend · **Ref:** found in the PR #213 review (MariaDB JSON columns)

Have the server say which §5.11.2 class each column is in, so the join
builder stops guessing it from the type name.

## 1. The ask

Every port works out a column's join class (`number`, `text`, `enum` and
so on) to check `on` pairs (`spec/protocol.md` §5.11.2). The class never
reaches the wire. So the join builder keeps its own copy of the mapping in
`frontend/src/lib/join-types.ts` (`CLASS_OF`, `NOT_JOINABLE`), matched
across every engine at once because the page does not know the engine.

That copy is a sixth version of a rule five ports already own, and it
cannot be right everywhere:

- **Postgres enums.** Every enum and `citext` report `USER-DEFINED`. The
  page cannot tell an enum from `citext`, or two different enums apart, so
  it can offer a pair the server rejects.
- **Engine quirks.** MariaDB stores a JSON column as `longtext`. Until PR
  #213, `/tables/data` reported `longtext`, so the builder offered a JSON
  pair that the join route refused.
- **Drift.** A change to any port's mapping has to be copied into the
  frontend by hand, and nothing checks that it was.

## 2. Wire change

- A §5.4.1 column entry gains an optional `class`: one of the §5.11.2
  class names. It is absent when the column is not joinable.
- Join response columns (§5.11.4) carry it too: they already must report
  the same §5.4.1 fields as `/tables/data`.
- **Open question: enums.** An enum joins only to the same enumerated
  type, so `class: "enum"` alone is not enough. Either add the type's name
  (for example `enum_type`), or make the class value carry it.

## 3. Frontend

- `join-form.ts` greys a pair when the two `class` values differ, or
  either is absent.
- Delete `CLASS_OF` and `NOT_JOINABLE` from `lib/join-types.ts`. The
  `type` string stays, for display only.

## 4. Touchpoints

- `spec/protocol.md` §5.4.1, §5.11.2 and §5.11.4; `spec/openapi.yaml`
  (`ColumnInfo`)
- The five backends: Rust core (axum and actix-web), Go, Node, Flask,
  Spring. Each already computes the class for joins; `/tables/data` takes
  it from the same lookup.
- `conformance/runner/table_data.rs`, `join.rs`
- `frontend/src/lib/join-types.ts`, `features/join-form.ts`; e2e
  `join-builder.spec.ts`

## 5. What "done" means

- Conformance, on every engine: seed columns report the expected class,
  `users.metadata` (JSON) has none, and a join column's `class` equals
  `/tables/data`'s.
- The builder greys exactly the pairs the server rejects, including two
  different Postgres enums.
- The full three-browser e2e suite passes.

## 6. Out of scope

- Changing which types may join (the §5.11.2 table).
