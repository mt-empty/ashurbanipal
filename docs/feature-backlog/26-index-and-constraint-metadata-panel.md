# Per-table index and constraint metadata panel

Status: proposed 2026-09-01. Read-only — catalog introspection only. Not
scheduled.

## 1. The ask

A per-table panel (alongside the column metadata of story 23) listing:

- indexes — name, columns, unique, partial predicate, method
- constraints — primary key, unique, foreign keys (with referenced
  table/columns and on-delete/on-update actions), check constraints

Why a dev reaches for it during feature work: understanding a
unique-violation they just hit, checking whether the column they filter on
is indexed before blaming the query, seeing the FK actions a cascade
depends on.

## 2. Per-backend source

- **Postgres** — `pg_index` / `pg_constraint` (+ `pg_get_indexdef`,
  `pg_get_constraintdef` for the readable text).
- **MySQL/MariaDB** — `information_schema.statistics` for indexes,
  `information_schema.table_constraints` + `key_column_usage` +
  `referential_constraints` for constraints. No partial indexes; check
  constraints only on MySQL 8.0.16+ / MariaDB 10.2+.
- **SQLite** — `pragma_index_list` / `pragma_index_info` /
  `pragma_index_xinfo`, `pragma_foreign_key_list`. Named check constraints
  are not introspectable; note the gap.

The three diverge enough (partial indexes, check-constraint availability,
index methods) to warrant a `docs/adapter-decisions.md` row.

## 3. Touchpoints

- `spec/protocol.md` — a new `GET {mount}/api/tables/{table}/schema` (or an
  expansion of the existing table metadata response) carrying `indexes[]`
  and `constraints[]`. Table name allow-list-checked as everywhere else.
- Frontend — a new panel/tab in the table metadata surface; read-only
  render, no new interaction model.
- Conformance schema-test — assert the shapes across all three engines
  against the shared seed (which needs a multi-column index and an FK with
  a non-default action added).

## 4. Open questions

- One combined endpoint for columns + indexes + constraints + DDL (story
  13), or separate? Combined means one fetch when the panel opens; separate
  keeps each story shippable alone.
- How much to normalise vs. show each engine's own catalog text.
