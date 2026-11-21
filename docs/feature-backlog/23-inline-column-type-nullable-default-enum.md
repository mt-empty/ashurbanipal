# Inline column type, nullability, default, and enum values

> **Status:** PARTIAL · **Area:** spec, ports, conformance, frontend · **Ref:** raw type shipped; `nullable`, `default` and `enum_values` open

Read-only — catalog metadata only.

## 1. The ask

A dev coding against a table wants to see, without leaving the grid:

- `NOT NULL` vs nullable
- default expression
- for enum-typed columns, the allowed values

The column's type already shows: `type` is on the wire (`spec/protocol.md`
§5.4.1), in the grid header and as a chip beside each record-view field
name (`typeChip` in `frontend/src/features/column-parts.ts`). The new
facts belong beside that chip.

## 2. Per-backend source

- **Postgres** — the §5.4.1 lookup already joins
  `information_schema.columns` to `pg_attribute`
  (`implementations/rust/core/src/db/postgres.rs`), which has nullability
  and the default. Enum labels come from `pg_enum` for the type that
  §5.4.1's `enum_type` names, so a domain over an enum works too. Postgres
  needs `enum_values` most: its `type` shows only the enum's name.
- **MySQL/MariaDB** — `information_schema.columns` (`is_nullable`,
  `column_default`). `ENUM`/`SET` members are already visible in `type`,
  which sends `COLUMN_TYPE` verbatim (`enum('a','b')`). MariaDB quotes
  string defaults in `column_default` and MySQL does not; record how the
  two are reconciled.
- **SQLite** — `pragma_table_info` gives `notnull` and `dflt_value`. No enum
  concept.

`CHECK (col IN (…))` lists are out of scope; §5.10's `check[].expression`
already shows their text in the structure dialog. Differences in what
"default" and "enum" mean across engines belong in
`docs/adapter-decisions.md`.

## 3. Touchpoints

- `spec/protocol.md` + `spec/openapi.yaml` — `nullable`, `default` and
  `enum_values` per column, on §5.4.1's `columns[]` or on the lazy §5.10
  structure route (see §5).
- All five ports — the catalog queries that fill them.
- Frontend — render beside the record view's type chip; reuse the §5.10
  fetch if the fields go there.
- Conformance — schema-test assertions for the new fields across engines.

## 4. Decided

- **Raw type, not a normalised label.** §5.4.1 sends the engine's full
  type spelling as `type` and a closed vocabulary as `class` (story 47).
  A new popover or chip renders the same `<code>`-wrapped raw type.
- **Shape of the new fields.** `nullable`, `default` and `enum_values`
  arrive as separate optional fields, each meaning what its name says, not
  as a traits bag: a bag still costs five ports and conformance per trait.
  Prior art pairs a native type name with a small closed vocabulary, as
  `type` + `class` do: JDBC, Metabase, Arrow, Frictionless Table Schema.

## 5. Open questions

- §5.4.1 or §5.10? [[26-index-and-constraint-metadata-panel]] put indexes and
  constraints on the lazy §5.10 route so `/tables/data` stays cheap on
  every page. These fields are the same kind of per-table data, so §5.10
  is the likely home unless the grid needs them before the user asks.
- Where else do they show? The header popover was drawn (design canvas
  board AT) and parked by the user on 2026-11-02. The structure dialog
  (`frontend/src/features/structure.ts`) has no column list today.
- Should `enum_values` feed the filter autocomplete? It already suggests a
  column's common values after an operator
  (`frontend/src/features/filter-ui.ts`); an enum would give the full
  list. Separate story.
