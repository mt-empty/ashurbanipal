# JSONB / JSON path filter

Status: proposed 2026-09-01. Read-only, but it widens the filter's SQL
surface — treat the security review as the main body of work, not the SQL.
Not scheduled.

## 1. The ask

Feature work on a table with a `jsonb` / `json` column constantly needs
"rows where `data.status` is `failed`". Today the filter's left-hand side
is a bare column identifier only, so this is impossible without leaving the
tool.

```
data->>'status' = 'failed'
payload->'user'->>'id' = '42'
```

## 2. Why this is not just another operator

Every existing filter condition's column is validated by exact match
against the live catalog before it is spliced into SQL
(`implementations/rust/core/src/db/*` `build_where_clause`, and the
architecture invariant in `CLAUDE.md`). A JSON path has a validated column
*plus* one or more path keys that are not catalog objects. The keys must
be bound as parameters or escaped, never concatenated, and the operator
set on a JSON-extracted value must stay the same hardcoded whitelist.

## 3. Per-backend

- **Postgres** — `col -> 'k'` / `col ->> 'k'`; `jsonb_path_query` is out of
  scope.
- **MySQL/MariaDB** — `JSON_EXTRACT(col, '$.k')` / `col ->> '$.k'`.
- **SQLite** — `json_extract(col, '$.k')` (JSON1, built in since 3.38).

The path syntax the frontend DSL accepts should be one form that each
backend translates — not three dialects leaking into the filter box. This
is a `docs/adapter-decisions.md` entry.

## 4. Touchpoints

- `spec/filter-dsl.md` — grammar for a path LHS; test table rows for depth
  limits, missing key, non-object parent, and adversarial key strings
  (quotes, `$`, `.`, `[`).
- `spec/protocol.md` §5.4.2 — AST condition gains an optional `path` array
  alongside `column`.
- Each backend's `build_where_clause` — column allow-listed as today, path
  keys bound/escaped, value bound.
- `conformance/runner/filter_dsl.rs` — shared adversarial table.

## 5. Open questions

- Cap path depth (mirror the flat-grammar spirit — shallow only?).
- Typed comparison: `->>` yields text on every engine, so `>` / `<` on a
  numeric JSON value is a string compare unless the path result is cast.
  Ship text-only comparisons in v1, or add an explicit cast form?
- Does a JSON path count as one "column" against the 10-condition limit?
