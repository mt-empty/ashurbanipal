# Inline column type, nullability, default, and enum values

> **Status:** PARTIAL · **Area:** spec, frontend · **Ref:** raw column type now renders inline (via story 32); type also in the record view; `nullable`, `default`, `enum_values` fields remain, header popover parked

Read-only — catalog metadata only.

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

- `spec/protocol.md` — `nullable`, `default` and `enum_values?` per
  column, either on §5.4.1's `columns[]` or on the lazy §5.10 structure
  route (see §4). `type` is already in §5.4.1.
- Frontend — header popover + record view rendering; it reuses the §5.10
  fetch if the fields go there.
- Conformance — schema-test assertions for the new fields across engines.

## 4. Open questions

- Raw engine type string, or a normalised label? Raw is less work and more
  honest; normalised reads better but reintroduces a mapping table. For
  *rendering* purposes this was settled by
  `docs/feature-backlog/32-cross-engine-column-type-rendering.md` (ship the
  raw string, bucket it tolerantly in the frontend); if this story adds a
  popover, the same `<code>`-wrapped raw type and the same `columnTypeClass`
  helper apply.
- **Shape of the new fields (decided 2026-11-04).** JDBC
  (`getColumnTypeName` beside `getColumnType`), Metabase (`base_type`,
  `effective_type`, `semantic_type`), Arrow (the logical type in field
  metadata over the physical type) and Frictionless Table Schema (`type`
  plus `format`) all send the engine's native name beside a small closed
  vocabulary. `type` + `class` is that pair, and `class` is now sent for
  every column (story 47). `nullable`, `default` and `enum_values` therefore
  arrive as separate named optional fields, each meaning what its name says.
  A traits bag (`{sortable, generated, ...}`) was rejected, and so was one
  field whose meaning depends on another, such as a generic "compare token":
  each trait would still cost five ports and conformance, so a bag only hides
  the growth. `collation` was the first such field.
- §5.4.1 or §5.10? Story 26 put indexes and constraints on the lazy §5.10
  route so `/tables/data` stays cheap on every page. These fields are the
  same kind of per-table data, so §5.10 is the likely home unless the grid
  needs them before the popover opens.
- Does the enum list feed the filter's value autocomplete (currently
  column-name only)? Natural follow-on, separate story.

## 5. Partially shipped

The raw engine type string renders in the grid header (landed with
`docs/feature-backlog/32-cross-engine-column-type-rendering.md`) and, since
2026-11-02, as a type chip under each record-view field name, beside the
key icon and comment. `type` was already on the wire (`spec/protocol.md`
§5.4.1). Still open here: the `nullable`, `default`, and `enum_values`
fields on the §5.4.1 column shape, the per-backend catalog queries that
populate them, and the conformance schema-test assertions. The header
popover was drawn (design canvas board AT) and parked by the user on
2026-11-02.
