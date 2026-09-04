# Inline column type, nullability, default, and enum values

Status: proposed 2026-09-01. Read-only — catalog metadata only. Not
scheduled.

## 1. The ask

Column headers today surface the comment (as a `title` tooltip) and a
PK/FK icon (`docs/design.md` §3.1) — nothing about the column's shape. A
dev coding against a table wants to see, without leaving the grid:

- data type
- `NOT NULL` vs nullable
- default expression
- for enum-typed / `CHECK (col IN (…))` columns, the allowed values

Surfaced in the column header popover and repeated in the record view.

## 2. Per-backend source

- **Postgres** — `information_schema.columns` for type / nullability /
  default; enum values via `pg_type` + `pg_enum`. `CHECK (col IN (…))`
  literal extraction is out of scope for v1.
- **MySQL/MariaDB** — `information_schema.columns`; `ENUM`/`SET` members are
  already in `COLUMN_TYPE` text.
- **SQLite** — `pragma_table_info` gives type affinity, `notnull`,
  `dflt_value`. No enum concept; `CHECK` parsing out of scope.

Divergence in what "type" and "enum" mean across the three belongs in
`docs/adapter-decisions.md`.

## 3. Touchpoints

- `spec/protocol.md` — the `/tables/{table}` (or columns) response grows
  `type`, `nullable`, `default`, `enum_values?` per column. Keep it one
  fetch; this is metadata the frontend already asks for.
- Frontend — header popover + record view rendering only; no new fetch
  path.
- Conformance — schema-test assertions for the new fields across engines.

## 4. Open questions

- Raw engine type string, or a normalised label? Raw is less work and more
  honest; normalised reads better but reintroduces a mapping table.
- Does the enum list feed the filter's value autocomplete (currently
  column-name only)? Natural follow-on, separate story.
