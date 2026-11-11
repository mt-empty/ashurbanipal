# List views and materialized views alongside base tables

> **Status:** OPEN · **Area:** spec, ports, conformance, frontend, docs

Read-only — a view read is the same code path as a table read.

## 1. The ask

`GET {mount}/api/tables` lists base tables only (`relkind = 'r'` on
Postgres, `BASE TABLE` on MySQL/MariaDB, `type = 'table'` on SQLite;
`spec/protocol.md` §5.2). Services expose plenty of their model through
views and materialized views, and a dev verifying a feature often needs to
read one. Include them in the table chips, visibly marked, and browsable
and filterable exactly like a table.

- **View:** a saved `SELECT` with a name. It stores no rows; each read runs
  its query.
- **Materialized view:** stores its result, stale until
  `REFRESH MATERIALIZED VIEW`. Postgres only; MySQL, MariaDB and SQLite
  have none. Reading one also shows whether a refresh job ran.

## 2. Wire change

- §5.2 entries gain a required `kind`: `table`, `view`, or
  `materialized_view`. Clients MUST treat an unknown value like `table`.
- The §5.2 list is the allow-list every route checks `table` against, so
  views become valid in each of them. Each route's answer for a view must
  be stated (§4 below), not left to fall out of the code.
- Additive, so a `feat(protocol)`. Record it in `spec/CHANGELOG.md`, and
  update `spec/openapi.yaml`.

```json
{ "tables": [
  { "name": "orders", "kind": "table" },
  { "name": "order_summary", "kind": "view" }
] }
```

## 3. Catalog queries

The listing, the counts, and the allow-list must keep sharing one
predicate (`docs/adapter-decisions.md`, the Postgres row on the table
allow-list — a past bug came from the two drifting apart).

- **Postgres:** `relkind IN ('r', 'v', 'm')`. `has_table_privilege` works
  for views and materialized views, so the privilege gate carries over. In
  Rust: `postgres.rs` (`readable_table_oid_in_tx`, `list_tables`, `table_counts`).
- **MySQL/MariaDB:** `table_type IN ('BASE TABLE', 'VIEW')`. In Rust:
  `mysql.rs` (`allowed_tables_in_tx`, `list_tables`, `table_counts`).
- **SQLite:** `type IN ('table', 'view')`. In Rust: `sqlite.rs`
  (`allowed_tables_on`, `list_tables`).
- The same three changes in Go, Node, Flask and Spring.

Column metadata needs no change: `information_schema.columns` and
`pragma_table_info` already cover views.

## 4. What each route returns for a view

| Route | Answer for a view |
|---|---|
| §5.3 `/table-counts` and §5.4.4 `total_approx` | `-1` for a plain view. Postgres 14+ already stores `reltuples = -1` for a view (checked on 18.4); older versions store `0`, so map `relkind = 'v'` to `-1` explicitly. MySQL's `table_rows` is `NULL` for a view, which `table_counts` already maps to `-1`. Materialized views have a real estimate after `ANALYZE`. |
| §5.4 `/tables/data` | Unchanged. No primary key, so the grid shows no FK links, no new-row tint and no record identity — the same as a PK-less table today. |
| §5.5 `/tables/common-values` | Empty for a plain view: `pg_stats` has nothing for it. Materialized views have stats. The spec already allows empty. |
| §5.9 `/tables/referenced-by` | `[]`. Nothing can hold a foreign key to a view. Today the target check uses its own `relkind = 'r'` test and would return 400; widen it to the shared predicate. |
| §5.10 `/tables/structure` | Plain view: no indexes or constraints. Materialized view: its indexes. Showing the view's SQL is story 30. |
| §5.11 `/tables/join` | Allowed by the shared allow-list. The builder can't suggest a pair (no FKs), but a typed join works. Decide whether to keep that on purpose (§7). |

## 5. Frontend

- A kind mark on the table chip and in the join picker
  (`frontend/src/features/table-chips.ts`, `features/join-catalog.ts`).
- The structure button stays enabled; an empty panel for a plain view says
  "a view has no indexes or constraints" rather than looking broken.
- The AI-agent API reference (`frontend/src/features/api-reference.ts`)
  shows `kind` in its `/tables` example.
- Check the design canvas boards before building the chip mark, and fit
  it to story 54's side panel rows if that ships first.

## 6. Touchpoints

- `spec/protocol.md` §5.2, §5.9, §5.10; `spec/openapi.yaml`;
  `spec/CHANGELOG.md`; `docs/adapter-decisions.md` (the allow-list
  predicate rows and the counts table).
- The five backends: Rust core (axum and actix-web share it), Go, Node,
  Flask, Spring.
- `conformance/seed` via `tools/seed-gen`: a view and a Postgres
  materialized view, then `mise run conformance:seed-gen`. MySQL/SQLite
  seed parity is story 35.
- The demos: the PGlite live demo uses the Node port; the synthetic demo
  (`frontend/src/demo/synthetic/serve.ts`) needs `kind` too.

## 7. Open questions

- **Default order.** With no sort chosen there is no `ORDER BY`
  (`postgres.rs`, `query_table`), so paging a view can repeat or skip
  rows. PK-less tables share this today; views hit it more. Sort by the
  first column by default, or leave it?
- **Joins on views.** Keep them allowed, or limit `/tables/join` to
  `kind = table`?
- **Partitioned tables** (`relkind = 'p'`) are also left out today
  (`docs/adapter-decisions.md`). Add them in the same change, or a
  separate story?
- **Column comments** on views: Postgres has them, MySQL and SQLite do
  not — the same degraded-metadata pattern as elsewhere.

## 8. Notes

- **Cost.** Each page fetch runs the view's full query. The existing
  statement timeout covers a slow one; no extra gate.
- **Privileges.** A Postgres view runs with its owner's rights (unless
  `security_invoker`), so it can show rows from tables the host's role
  can't read directly. That adds no access: the host's role can already
  read the view. Say so in `docs/adapter-decisions.md`.
- **Side effects.** A view over a volatile function is a theoretical
  concern, but Ashurbanipal still only issues `SELECT`; not a reason to
  gate views.

## 9. What "done" means

- Conformance on every engine: views listed with the right `kind`;
  browse, sort and filter a view; `referenced-by` on a view returns `[]`;
  counts are `-1` for a plain view.
- Each port's own tests cover the privilege gate for a view.
- The full three-browser e2e suite passes with a view chip in the seed.
