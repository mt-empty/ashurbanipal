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

## 2. Per-backend source

- **Postgres** — `pg_index` / `pg_constraint` for the raw catalog data
  (see §4's open question on whether to also surface `pg_get_indexdef`/
  `pg_get_constraintdef` text). Postgres clones both indexes and FK
  constraints onto every partition of a partitioned table — filter to the
  parent's own copy (`conparentid = 0` for constraints; the equivalent
  `pg_index` predicate for indexes), or a naive scan reports one entry per
  partition for what is a single logical index/constraint.
  `implementations/rust/core/src/db/postgres.rs:603-613` and
  `implementations/rust/axum/tests/referenced_by_partitioning.rs` show the
  existing fix and its regression test for the constraint case — mirror
  both for indexes.
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

## 3. Touchpoints

- `spec/protocol.md` §5.4 — add `indexes[]` and `constraints` as new
  top-level fields on `GET {mount}/api/tables/data`, alongside
  `columns`/`rows`/`total_approx`. No new route, no new error `code`: the
  table name is already allow-list-checked for this endpoint, and an
  unknown table already maps to `unknown_table`.
- `spec/openapi.yaml` — extend the `/tables/data` response schema with the
  two new properties.
- Frontend (`frontend/src/features/`) — a new panel/tab in the table
  metadata surface; read-only render, no new interaction model. Update
  `frontend/src/features/api-reference.ts`'s existing `tables/data` entry
  to describe the new fields.
- Conformance schema-test — assert the shapes across all three engines
  against the shared seed. The seed needs a multi-column index, a
  composite FK, and an FK with a non-default action. Seed changes go
  through `tools/seed-gen`: edit the generator, run
  `mise run conformance:seed-gen`; `mise run conformance:seed-check`
  enforces the generated seed files match.
- All 5 languages / 6 adapters (Rust axum + actix-web, Go, Node, Flask,
  Spring), each against `PORTING.md`'s checklist.

## 4. What "done" means

`GET {mount}/api/tables/data` gains, when the table has any:

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
      { "name": "orders_user_id_fkey", "columns": [{ "from": "user_id", "to": "id" }],
        "on_delete": "CASCADE", "on_update": "NO ACTION" },
      { "name": "order_items_order_fkey",
        "columns": [{ "from": "order_id", "to": "id" }, { "from": "order_region", "to": "region" }],
        "on_delete": "RESTRICT", "on_update": "NO ACTION" }
    ],
    "check": [{ "name": "orders_total_nonneg", "expression": "total >= 0" }]
  }
}
```

- `foreign_keys` entries cover single-column and composite FKs uniformly
  — one shape, no separate composite-only path, nothing omitted.
- `on_delete`/`on_update` are present on every `foreign_keys` entry, using
  a fixed vocabulary (`CASCADE` / `RESTRICT` / `SET NULL` / `SET DEFAULT`
  / `NO ACTION`) mapped from each engine's native terms.
- `indexes[].predicate` is omitted (never `null`) on an engine with no
  partial-index concept (MySQL, SQLite).
- `constraints.check` is `[]` on SQLite unconditionally — a documented,
  permanent per-engine gap, not an error and not a TODO.
- A partitioned Postgres table's `indexes`/`constraints` report each
  logical index/constraint once, never once per partition.
- The conformance seed carries a multi-column index, a composite FK, and a
  non-default FK action; the schema-test asserts all three shapes across
  Postgres, MySQL, and SQLite.

## 5. Open questions

- **Check constraint expression text.** Postgres (`pg_get_constraintdef`)
  and MySQL (`information_schema.check_constraints.check_clause`) can
  supply the SQL text; SQLite can't introspect it at all. Report it as an
  optional field where available, or drop expression text entirely so the
  shape is uniform across engines?
- **Index/constraint name stability on SQLite.** Indexes and named unique
  constraints exist there, but FK constraints don't have names at all —
  same synthesized-label treatment §5.9 already uses for `constraint`
  (`fk_<id>`, stable within one read, not across schema changes), or a
  different mechanism for this endpoint?
