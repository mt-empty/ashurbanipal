# Find a column across all tables

> **Status:** OPEN · **Area:** spec, ports, conformance, frontend, docs, e2e

Search the current schema's column names, for example "which tables
have a `tenant_id`?", and jump to a table from the results.

## 1. The ask

A developer new to a service often knows a column name before a table
name: the field in an API payload, a log line, or an error. Today they
have to open tables one by one, or open the structure panel of each.
DBeaver and DataGrip both search the database's metadata by name.

This is not a table search box. On 2026-10-15 the top bar was decided to
get none, and that decision stands. This story searches column names,
which the table list cannot show.

## 2. Cost

Catalog queries only, never a table scan. They are bounded by the
catalog timeout like every other catalog query (§6). Even a schema with
thousands of tables answers quickly from the catalog.

## 3. Wire shape

A server-side search, so the response stays small on a large schema.
Fetching every column of the schema and filtering in the browser was
considered: with 2,000 tables at 20 columns each, that is about 40,000
entries per load, for a feature used now and then.

`GET {mount}/api/columns`

| Param    | Required | Rules |
|----------|----------|-------|
| `source` | no       | As §5.2. |
| `schema` | no       | As §5.2. |
| `q`      | yes      | 1 to 64 characters; otherwise 400. Matched as a case-insensitive substring of the column name. |

```json
{
  "columns": [
    { "table": "orders", "column": "user_id", "type": "uuid", "key": "fk" },
    { "table": "users", "column": "id", "type": "uuid", "key": "pk" }
  ],
  "truncated": false
}
```

- `q` is a bound parameter, never SQL text. `%`, `_` and the escape
  character in `q` are escaped, so they match themselves.
- Only tables §5.2 lists for this source and schema, gated the same way
  (on Postgres, `has_table_privilege(…, 'SELECT')` and `relkind = 'r'`).
  On Postgres, a column the role has no `SELECT` on is left out too
  (`has_column_privilege`), so the search never names a column the grid
  would refuse.
- Order: exact name matches first, then names that start with `q`, then
  the rest; then by table name and column position.
- At most **200** entries; `truncated` says more exist.
- `type` and `key` use the same values as §5.4.1's `columns[]`.
- Per engine: Postgres `pg_attribute` ⨝ `pg_class`; MySQL/MariaDB
  `information_schema.columns`; SQLite `sqlite_master` ⨝
  `pragma_table_info(name)`. Engine differences go in
  `docs/adapter-decisions.md`.

## 4. Behaviour

- A small `find column` entry point, opened by a button and a keyboard
  shortcut. Where it lives is a design question (§8). It must not become
  a table filter on the chips bar.
- Typing shows matches as `table.column` with the type, grouped by
  table, with the match highlighted. Requests are debounced, and late
  responses for an older `q` are dropped.
- Choosing a result opens that table. Later, it could also scroll to the
  column and flash it.
- `truncated`: the footer says `first 200 matches — type more to narrow`
  (R8).
- Loading, empty and error states show in place (R9).

## 5. Rules this must keep

- **R1:** reading only.
- **R6:** the search text is not saved to `localStorage` or the URL.
- **R13:** a result that opens a table is a real link.
- **Allow-list:** every returned name came from the catalog, so it is
  safe to pass to §5.4 as is.

## 6. Touchpoints

- `spec/protocol.md`: a new section. `spec/openapi.yaml`.
- Every port: a `search_columns` method on its database seam and a
  route. Rust: `implementations/rust/core/src/db/` (all three engines,
  plus `Source`), with route wiring in `axum/` and `actix-web/`.
- `conformance/runner/`: a new `columns.rs`, plus `COVERAGE.md`. The
  seed already has `user_id` in several tables.
- `frontend/src/`: a feature module for the search, `core/api.ts`,
  `features/api-reference.ts`.
- The demo backends, as story 61.
- Design canvas: a new round for the entry point and the results list.

## 7. What "done" means

- Conformance on every port and engine: `q=user_id` returns every seed
  table with that column; matching ignores case; `%` and `_` in `q`
  match themselves; a table the role cannot read is left out (Postgres
  privilege test, like `table_listing_privileges`); more than 200
  matches sets `truncated`; an empty or 65-character `q` is a 400.
- An e2e spec: search, open a table from a result, and see the
  truncated footer.
- The full three-browser e2e suite passes.

## 8. Open questions

- **Where it lives.** The table list side panel (story 54), a dialog
  opened by a shortcut, or both? Needs a design-canvas round.
- **All schemas or the current one.** Joins already cross schemas
  (story 44). Searching every allowed schema is more useful on a
  multi-schema service, but needs a `schema` on each result.
- **Search comments too.** Column and table comments often name the
  business term a developer is looking for. Add a toggle later if asked.

## 9. Out of scope

- Searching cell values across tables: that is a scan of every table.
- Searching table names: the 2026-10-15 decision stands.
