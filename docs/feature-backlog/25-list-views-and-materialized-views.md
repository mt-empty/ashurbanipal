# List views and materialized views alongside base tables

Status: proposed 2026-09-01. Read-only — a view read is the same code path
as a table read. Not scheduled.

## 1. The ask

`GET {mount}/api/tables` lists base tables only (`BASE TABLE` on Postgres
/ MySQL, `relkind = 'r'`; `spec/protocol.md` §5.2). Services expose plenty
of their model through views and materialized views, and a dev verifying a
feature often needs to read one. Include them in the sidebar, visually
distinguished, browsable and filterable exactly like a table.

## 2. Touchpoints

- `spec/protocol.md` §5.2 — response entries gain a `kind`
  (`table` | `view` | `materialized_view`). The allow-list every other
  route checks against grows to include view names, scoped to the resolved
  schema as today.
- Per-backend catalog query:
  - **Postgres** — add `relkind IN ('v', 'm')`; `has_table_privilege`
    works for views and matviews, so the privilege gate carries over
    unchanged.
  - **MySQL/MariaDB** — `information_schema.tables` `TABLE_TYPE = 'VIEW'`
    (no materialized views in either engine).
  - **SQLite** — `sqlite_master.type = 'view'`.
- Frontend — a kind badge / icon in the sidebar list; everything else
  (browse, sort, filter, record view) already works because the row-fetch
  path is unchanged.
- `conformance/seed` — add a view and (Postgres) a materialized view to the
  shared seed so every port's conformance run exercises this.

## 3. Notes / open questions

- Sorting and filtering a view work through the same allow-listed
  column check against the view's reported columns — no special-casing.
- A view wrapping a volatile or side-effecting function is a theoretical
  concern, but Ashurbanipal still only issues `SELECT`; not a reason to
  gate views.
- `table_counts` on a large unindexed view can be slow — reuse whatever
  timeout / estimate strategy the base-table count already uses, or omit
  counts for views in v1.
- Column comments on views: Postgres supports them, MySQL/SQLite do not —
  same degraded-feature pattern already documented for other metadata.
