# JSONB / JSON path filter

> **Status:** OPEN · **Area:** spec, ports, conformance, frontend

Read-only, but it widens the filter's SQL surface. Treat the security
review as the main body of work, not the SQL.

## 1. The ask

Feature work on a table with a `jsonb` / `json` column often needs "rows
where `data.status` is `failed`". Today a filter condition names a bare
column only, so the tool cannot do this.

```
data->>'status' = 'failed'
payload->'user'->>'id' = '42'
```

## 2. Why this is not just another operator

Each condition's column is matched exactly against the live catalog
before it reaches SQL (`spec/protocol.md` §5.4.2; in Rust,
`table_where_clause` in `implementations/rust/core/src/join.rs`). A JSON
path adds keys that are not catalog objects. The keys must never be
concatenated into SQL, and the operator set on an extracted value must
stay the same hardcoded list.

## 3. Per-backend

- **Postgres:** `col ->> $n`, each key bound. `jsonb_path_query` is out of
  scope.
- **MySQL/MariaDB:** `JSON_UNQUOTE(JSON_EXTRACT(col, ?))`. MariaDB has no
  `->>` operator, so use the function form on both. The path is one string
  (`$."k"`): quote each key by the JSON-path rules, then bind the string.
- **SQLite:** `json_extract(col, ?)`, path built and bound the same way.
  JSON1 is built in only from 3.38; the supported floor is 3.16
  (`docs/adapter-decisions.md`, Supported engine versions), so an older
  build may lack it.

The filter box accepts one path syntax, and each backend translates it.
Record the per-engine forms in `docs/adapter-decisions.md`.

## 4. Touchpoints

- `spec/filter-dsl.md` and `spec/fixtures/parser-tests.json`: grammar for a
  path on the left-hand side. The `.` is taken: a join view already uses
  `alias.column` (§2), so the path needs another form, such as `->>`.
  Cases for depth limits, a missing key, a non-object parent, and hostile
  keys (quotes, `$`, `.`, `[`).
- `frontend/src/lib/filter-dsl.ts` and `filter-tokens.ts`: parse, colour
  and suggest the path.
- `spec/protocol.md` §5.4.2 and `spec/openapi.yaml`: a condition gains an
  optional `path` array of strings next to `column`. It is still one
  condition against the limit of 10. Decide whether §5.11.3 join filters
  accept it too.
- Every port's WHERE builder: column allow-listed as today, path bound,
  value bound.
- `spec/fixtures/filter-builder-tests.json`: the WHERE fragment and binds
  per engine, including the hostile keys. `spec/fixtures/catalogs.json`
  already has `json` columns. `conformance/runner/filter_dsl.rs` runs the
  same cases over HTTP.

## 5. Open questions

- Which columns accept a path: only class `json` (`spec/protocol.md`
  §5.11.2), or any text column? MariaDB and SQLite store JSON as text, and
  SQLite classes a column `json` only by its declared type.
- Cap the path depth? The grammar is flat today.
- Typed comparison: a path result has no column class, so §5.4.2 compares
  it as text (`'10' < '9'`). Ship text-only comparison first, or add an
  explicit cast form?
- On SQLite without JSON1, a path should give a 400, not a 500: map the
  `no such function` error, or probe on the first path filter and keep the
  answer per source. Not at start-up: no port touches the database when
  the router is built.
