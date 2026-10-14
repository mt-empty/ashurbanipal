# Per-table index and constraint metadata panel

> **Status:** OPEN · **Area:** spec, frontend

Read-only — catalog introspection only.

## 1. The ask

Per-table structural metadata beyond what `columns[]` already carries
(§5.4.1's per-column `key`/`references`) and beyond what
`/tables/referenced-by` already carries (§5.9's incoming FK list):

- **Indexes** — name, columns, unique, partial predicate, method.
- **Constraints**, reported as whole objects rather than per-column
  fields:
  - Primary key
  - Unique constraints
  - Foreign keys — including **composite** (multi-column) FKs, with
    **on-delete/on-update actions**
  - Check constraints

A whole-constraint view is required to report composite FKs at all:
§5.4.1's `references` field lives on a single column and can't express
which column in a multi-column FK pairs with which target column, so
composite FKs are omitted there entirely today. Reporting the constraint
as one object with an explicit `[{from, to}, ...]` pairing — the same
shape §5.9 already uses for the incoming direction — removes that
ambiguity. This is the first place an outgoing composite FK becomes
visible through the API.

Why a dev reaches for this during feature work: understanding a
unique-violation or check-violation they just hit, checking whether a
column they filter on is indexed before blaming the query, seeing the FK
actions a cascade depends on, seeing a composite FK's full column pairing
instead of nothing.

## 2. Why a separate route

Structure is a property of the table. Rows change with every page, sort,
and filter; structure changes with none of them. Folding it into
`/tables/data` would charge every page request several extra catalog
queries for data the client already holds, make the stable part
uncacheable (the response is keyed by table + filter + sort + page, the
structure by table alone), and couple row browsing to catalog access that
can fail or be restricted independently (notably MySQL's
`information_schema`). A separate route, fetched when the panel opens and
cached per table on the client, is the shape §5.9 already established.

`columns[].key`/`references` (§5.4.1) is unchanged. The new route is the
only place outgoing composite FKs appear; a client that wants the
per-column hint keeps using §5.4.1.

## 3. Per-backend source

- **Postgres** — `pg_index` / `pg_constraint` for the raw catalog data
  (`pg_get_indexdef` renders expression entries; `pg_get_expr(conbin, conrelid)`
  gives a check's bare expression). Postgres clones both indexes and FK
  constraints onto every partition of a partitioned table — filter to the
  parent's own copy (`conparentid = 0` for constraints; the equivalent
  `pg_index` predicate for indexes), or a naive scan reports one entry per
  partition for what is a single logical index/constraint.
  `implementations/rust/core/src/db/postgres.rs:603-613` and
  `implementations/rust/axum/tests/referenced_by_partitioning.rs` show the
  existing fix and its regression test for the constraint case — mirror
  both for indexes. Index columns come from the first `indnkeyatts` entries
  of `indkey` only: later entries are `INCLUDE` columns, not part of the
  key. An `indkey` entry of `0` is an expression, not a column — keep it
  in position (rendered from `pg_get_indexdef`) rather than dropping it
  through an inner join, or an expression-only index vanishes.
- **MySQL/MariaDB** — `information_schema.statistics` for indexes;
  `table_constraints` + `key_column_usage` + `referential_constraints` for
  constraints (`referential_constraints.update_rule`/`delete_rule` gives
  the FK actions directly). No partial indexes. Check constraints only on
  MySQL 8.0.16+ / MariaDB 10.2+.
- **SQLite** — `pragma_index_list` / `pragma_index_info` /
  `pragma_index_xinfo` for indexes; `pragma_foreign_key_list` for FKs
  (carries `on_delete`/`on_update` natively, and — per §5.4.1's existing
  SQLite mechanism — needs the same `pragma_table_info` resolution for a
  parent key omitted from the `REFERENCES` clause). Named check
  constraints are not introspectable; report an empty `check` list, not an
  error.

## 4. Touchpoints

- `spec/protocol.md` — new section `GET {mount}/api/tables/structure`,
  modelled on §5.9: same `source`/`schema`/`table` params and the same
  allow-list check, so an unknown table maps to `unknown_table` and no new
  error `code` is needed. Catalog-only, never table data.
- `spec/openapi.yaml` — the new path and its response schema.
- Backends — each port adds the route and a `DbSource`-equivalent method
  per engine. In Rust that is the `DbSource` trait plus the Postgres,
  MySQL, and SQLite implementations in `core/`, with thin handlers in the
  axum and actix-web adapters. Every catalog lookup stays in one
  transaction/connection per operation (`CLAUDE.md` invariants), and no
  identifier reaches SQL unvalidated.
- Frontend (`frontend/src/features/`) — a structure panel that fetches on
  first open and caches per `(source, schema, table)`, mirroring how
  `referenced-by` is lazily fetched. Read-only render, no new interaction
  model. Add the route to `frontend/src/features/api-reference.ts`.
  Toolbar placement is tracked as a separate story.
- Conformance schema-test — assert the shapes across all three engines
  against the shared seed. The seed needs a multi-column index, a
  composite FK, an FK with a non-default action, a check constraint, a
  partial index, and a covering (`INCLUDE`) index. Seed changes go through
  `tools/seed-gen`: edit the generator, run `mise run conformance:seed-gen`;
  `mise run conformance:seed-check` enforces the generated seed files match.
- Tests — a partitioned-table regression test for indexes, alongside
  `referenced_by_partitioning.rs`, and a Playwright spec modelled on
  `tools/e2e-tests/tests/referenced-by.spec.ts`.
- `docs/adapter-decisions.md` — per-engine gaps (SQLite checks, SQLite FK
  names, MySQL partial indexes).
- All 5 languages / 6 adapters (Rust axum + actix-web, Go, Node, Flask,
  Spring), each against `PORTING.md`'s checklist.

## 5. What "done" means

`GET {mount}/api/tables/structure?table=orders` returns:

```json
{
  "indexes": [
    { "name": "orders_user_id_idx", "columns": ["user_id"], "unique": false, "method": "btree" },
    { "name": "orders_active_idx", "columns": ["status"], "unique": false, "method": "btree",
      "predicate": "status = 'active'" }
  ],
  "constraints": {
    "primary_key": { "name": "orders_pkey", "columns": ["id"] },
    "unique": [{ "name": "orders_external_ref_key", "columns": ["external_ref"] }],
    "foreign_keys": [
      { "name": "orders_user_id_fkey", "table": "users",
        "columns": [{ "from": "user_id", "to": "id" }],
        "on_delete": "CASCADE", "on_update": "NO ACTION" },
      { "name": "order_items_order_fkey", "table": "orders", "schema": "sales",
        "columns": [{ "from": "order_id", "to": "id" }, { "from": "order_region", "to": "region" }],
        "on_delete": "RESTRICT", "on_update": "NO ACTION" }
    ],
    "check": [{ "name": "orders_total_nonneg", "expression": "total >= 0" }]
  }
}
```

- `indexes` is `[]` and `constraints` always carries `unique`,
  `foreign_keys`, and `check` as `[]` when empty; `primary_key` is omitted
  when the table has none. The route never returns an error for a table
  that simply has no structure.
- `foreign_keys` entries cover single-column and composite FKs uniformly
  — one shape, nothing omitted. `table` is the referenced table;
  `schema` is its schema, present only when it differs from the resolved
  one (the same rule as §5.4.1's `references.schema`).
- `on_delete`/`on_update` are present on every `foreign_keys` entry, using
  a fixed vocabulary (`CASCADE` / `RESTRICT` / `SET NULL` / `SET DEFAULT`
  / `NO ACTION`) mapped from each engine's native terms.
- `indexes[].columns` lists key columns in index order. An expression
  entry appears in its position as its expression text, never dropped; a
  covering (`INCLUDE`) column is not listed.
- `indexes[].predicate` is omitted (never `null`) on an engine with no
  partial-index concept (MySQL, SQLite).
- `constraints.check` is `[]` on SQLite unconditionally — a documented,
  permanent per-engine gap, not an error and not a TODO.
- A partitioned Postgres table's `indexes`/`constraints` report each
  logical index/constraint once, never once per partition.
- Entries SHOULD be returned in a stable order (by name), a SHOULD as in
  §5.2.
- `/tables/data` is unchanged: no new fields, no extra queries on the hot
  path.
- The frontend shows a loading and an error state of its own: a failed
  structure fetch never affects the grid, and the panel never presents a
  missing result as "none".

## 6. Decisions and open questions

Decided:

- **`NOT VALID` / `DEFERRABLE`** are left out of v1; adding optional flags
  later is additive.
- **Partition children** report their own indexes and constraints. A
  partitioned parent is already rejected by the table allow-list, so there
  is nothing to dedup on this route.
- **Privilege filtering:** FK entries are not filtered by `SELECT` on the
  referenced table; recorded in `docs/adapter-decisions.md`.
- **Constraint-backing indexes** (`*_pkey`, unique) appear in `indexes`;
  they are real indexes.
- **Check expression text** is an optional field, omitted where the engine
  cannot supply it.

Open:

- **Index/constraint name stability on SQLite.** Indexes and named unique
  constraints exist there, but FK constraints don't have names at all —
  same synthesized-label treatment §5.9 already uses for `constraint`
  (`fk_<id>`, stable within one read, not across schema changes), or a
  different mechanism for this endpoint?
