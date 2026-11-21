# List views and materialized views alongside base tables

> **Status:** OPEN · **Area:** spec, ports, conformance, frontend, docs

Read-only: a view read is the same code path as a table read.

## 1. The ask

`GET {mount}/api/tables` lists base tables only (`spec/protocol.md` §5.2;
each engine's predicate is in `docs/adapter-decisions.md` §5.2/§5.3).
Services expose plenty of their model through
views and materialized views, and a dev checking a feature often needs to
read one. List them in the table panel, visibly marked, and let users
browse and filter them exactly like a table.

- **View:** a saved `SELECT` with a name. It stores no rows; each read runs
  its query.
- **Materialized view:** stores its result, stale until
  `REFRESH MATERIALIZED VIEW`. Postgres only. Reading one also shows
  whether a refresh job ran.

## 2. Wire change

- §5.2 entries gain a required `kind`: `table`, `view`, or
  `materialized_view`. Clients MUST treat an unknown value like `table`.
- The §5.2 list is the allow-list every route checks `table` against, so
  views become valid in each of them. State each route's answer for a view
  (§4 below); do not leave it to fall out of the code.
- Additive, so a `feat(protocol)`. Record it in `spec/CHANGELOG.md`, and
  update `spec/openapi.yaml`.

```json
{ "tables": [
  { "name": "orders", "kind": "table" },
  { "name": "order_summary", "kind": "view" }
] }
```

## 3. Catalog queries

The listing, the counts and the allow-list must keep one shared predicate
(`docs/adapter-decisions.md` §5.2 / §5.3).

- **Postgres:** `relkind IN ('r', 'v', 'm')`. `has_table_privilege` works
  for views and materialized views, so the privilege gate carries over. In
  Rust: `postgres.rs` (`readable_table_oid_in_tx`, `list_tables`,
  `table_counts`).
- **MySQL/MariaDB:** `table_type IN ('BASE TABLE', 'VIEW')`. In Rust:
  `mysql.rs` (`allowed_tables_in_tx`, `list_tables`, `table_counts`). Both
  engines store the text `VIEW` in a view's `table_comment`; do not report
  it as a §5.2 `comment`.
- **SQLite:** `type IN ('table', 'view')`. In Rust: `sqlite.rs`
  (`allowed_tables_on`).
- The same changes in Go, Node, Flask and Spring.

Column metadata needs no change: `information_schema.columns` and
`pragma_table_info` already cover views.

## 4. What each route returns for a view

| Route | Answer for a view |
|---|---|
| §5.3 `/table-counts` and §5.4.4 `total_approx` | `-1` for a plain view. Postgres 14 and later store `reltuples = -1` for a view (checked on 18.4), and 15 is the oldest supported version. MySQL's `table_rows` is `NULL` for a view, which `table_counts` already maps to `-1`. A materialized view has a real estimate after `ANALYZE`. |
| §5.4 `/tables/data` | Unchanged. No primary key, so the grid shows no FK links, no new-row tint and no record identity, as for a PK-less table today. No tie-break key either, so rows come in the engine's order and pages MAY repeat or skip rows (§5.4). A materialized view with a NOT NULL unique index gets that index as its key. |
| §5.5 `/tables/common-values` | Empty for a plain view: `pg_stats` has nothing for it. Materialized views have stats. The spec already allows empty. |
| §5.9 `/tables/referenced-by` | `[]`: nothing can hold a foreign key to a view. The target check already uses the shared gate (`readable_table_oid_in_tx` in Rust), so it widens with the predicate. The referrer filter `rc.relkind = 'r'` stays. |
| §5.10 `/tables/structure` | Plain view: no indexes or constraints. Materialized view: its indexes. Showing the view's SQL is [[30-show-ddl-source-viewer]]. |
| §5.11 `/tables/join` | Allowed by the shared allow-list. The join form cannot suggest a pair (no FKs), but a typed join works. Decide whether to keep that on purpose (§7). |

## 5. Frontend

- A kind mark on the table chip and in the join picker
  (`frontend/src/features/table-chips.ts`, `tables-panel.ts`,
  `join-catalog.ts`).
- The structure button stays enabled. An empty panel for a plain view says
  "a view has no indexes or constraints", so it does not look broken.
- The AI-agent API reference (`frontend/src/features/api-reference.ts`)
  shows `kind` in its `/tables` example.
- Check the design canvas boards before building the chip mark.

## 6. Touchpoints not covered above

- Conformance: every seed already has an `active_users` view, and the
  Postgres seed has an `order_totals_by_status` materialized view. Add them
  to the expected list with their `kind`. Replace
  `table_data::a_view_is_not_an_allowed_table` with reads that succeed, and
  rewrite `P5.2-BASE-TABLES-ONLY` in `conformance/runner/COVERAGE.md`.
- The demos: both get `kind` from the Node port (the synthetic snapshot
  copies `listTables`, `frontend/src/demo/build/snapshot.ts`). Rebuild the
  committed `docs/demo/` snapshot.

## 7. Open questions

- **Joins on views.** Keep them allowed, or limit `/tables/join` to
  `kind = table`?
- **Partitioned tables** (`relkind = 'p'`) are also left out today
  (`docs/adapter-decisions.md` §5.2 / §5.3). Add them in the same change,
  or in a separate story?
- **Column comments** on views: Postgres has them, MySQL and SQLite do
  not. This is the same degraded-metadata pattern as elsewhere.

## 8. Notes

- **Cost.** Each page fetch runs the view's full query. The existing
  statement timeout covers a slow one; no extra gate.
- **Privileges.** A Postgres view runs with its owner's rights (unless
  `security_invoker`), so it can show rows from tables the host's role
  cannot read directly. That adds no access: the host's role can already
  read the view. Say so in `docs/adapter-decisions.md`.
- **Side effects.** A view over a volatile function is a theoretical
  concern, but Ashurbanipal still only issues `SELECT`. It is not a reason
  to gate views.

## 9. What "done" means

- Conformance on every engine: views listed with the right `kind`;
  browse, sort and filter a view; `referenced-by` on a view returns `[]`;
  counts are `-1` for a plain view.
- Each port's own tests cover the privilege gate for a view.
- The full three-browser e2e suite passes with a view chip in the seed.
