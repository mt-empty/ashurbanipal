# Incoming FK references ("referenced by")

> **Status:** DONE · **Area:** spec, ports, frontend, docs · **Ref:** PR #119 (open)

**Ask:** alongside the outgoing `references` Ashurbanipal already reports
per column (`spec/protocol.md` §5.4.1 — "this column points at
`table.column`"), also surface the reverse direction: which rows in
*other* tables point at the row currently being viewed. Desktop DB
clients (DBeaver, DataGrip) show this as a separate "referenced by"
panel alongside their outgoing-FK navigation — see the discussion on
[[13-pk-that-is-also-fk-loses-references]] for how a PK+FK column's
chain of outgoing references composes without this.

**Not part of #13:** #13 is about a single column's own `key`/`references`
metadata being incomplete when the column is both PK and FK — still a
single-hop, outgoing fact. This is a different, additive capability: for
a given row, find every table+column elsewhere in the schema whose FK
points at it, then query those tables filtered by the current row's key
value(s).

## Feasibility — investigated 2026-09-07/08

Verdict: cheap, if the reverse lookup runs **on-demand** (a request when
the user opens the panel), not eagerly (computed with every row fetch),
and each backend reads the right catalog (see "Per engine" below). That is
also how DBeaver does it.

**Prior art — DBeaver** (`dbeaver/dbeaver` HEAD, 2026-09-07):

- The "References" panel runs a background job only after the user opens
  it and selects a row. It clears on an empty selection and skips an
  unchanged one (`ReferencesResultsContainer.refreshKeyValues`). It never
  runs with the row fetch.
- The "who points at me" list comes from a per-table, cached
  `entity.getReferences(monitor)` call. Per engine:
  - Generic / JDBC path (DBeaver's SQLite uses this): the JDBC-standard
    `DatabaseMetaData.getExportedKeys(catalog, schema, table)` — the
    driver's own incoming-FK call.
  - Native Postgres model: `SELECT DISTINCT connamespace FROM
    pg_catalog.pg_constraint WHERE confrelid = ?` to narrow to the
    schemas holding a referencing FK, then filter those schemas'
    constraint caches. The two-step hydrates DBeaver's own object cache;
    it is not an efficiency trick to copy.
  - Native MySQL model: one `information_schema` query filtered on the
    referenced side (`REFERENCED_TABLE_NAME` + schema).
  - Native SQLite model: no reverse index and no `information_schema` —
    iterate every table, run `PRAGMA foreign_key_list` on each, keep the
    rows that point at the current table.
- The child rows come from an ordinary filtered read: `child_fk_col =
  <this row's key>` for one row, `IN (...)` for many, on the normal data
  path with normal pagination. A combo box shows one referencing table at
  a time, so many child tables are never fetched at once.

**Measured — Postgres 18** (`EXPLAIN (ANALYZE, BUFFERS)`, server-side
time, 5 runs):

| Catalog | reverse via `information_schema` | reverse via `pg_catalog` |
|---|---|---|
| seed — 15 tables, ~20 FKs | 6.6 ms | 0.17 ms |
| synthetic — 2,020 tables, 4,542 FKs; target has 4 referrers | 18 ms | 0.9 ms |
| synthetic — same; target has 501 referrers | 96–139 ms (283 ms cold) | 3–5.5 ms |

The cost is the `information_schema` views, not the reverse direction.
PG's `information_schema` is standard-SQL views with no predicate
push-down, `_pg_expandarray(conkey)` per constraint, and per-row
`has_*_privilege()` calls; the plan discards millions of join-filter rows
and touches ~1 GB of cached catalog pages. The forward query Ashurbanipal
*already* runs on every `GET /api/table` (`postgres.rs` `key_metadata_in_tx`,
uncached) pays the same tax — ~11 ms on the seed DB, ~90 ms on the
2,020-table catalog. `pg_catalog.pg_constraint` filtered on `confrelid`
avoids all of it (small seq scan — there is no `confrelid` index — plus
OID index lookups): 20–40× faster and near-flat as the catalog grows.

On-demand keeps even the slow path to one deliberate click, never added to
a page load. Neither approach is acceptable per row.

**The JDBC `getExportedKeys` shortcut does not transfer.** Only the
Spring Boot port could call it. All five ports hand-roll
`information_schema` today so their behaviour matches byte for byte; a
driver metadata call in one port would break that. Every port writes the
reverse query itself, the same way it writes the outgoing one.

**Per engine — which catalog to read for the reverse scan:**

- **Postgres** — `pg_catalog.pg_constraint` (`contype = 'f'`, filter
  `confrelid` = the current table's OID; resolve the OID with a
  bound-parameter `pg_class`/`pg_namespace` lookup, never a `::regclass`
  cast on a raw string). Standard `information_schema` is too slow on a
  large catalog (table above). This departs from the "`information_schema`
  for Postgres" convention, so it needs a `docs/adapter-decisions.md`
  note; identifier validation is unaffected — the current table name is
  already allow-listed, and the result's child names are allow-listed
  before any drill-in.
- **MySQL 8.0+** — standard `information_schema` is fine. Since 8.0 these
  are indexed views over the transactional InnoDB data dictionary
  (~30–100× faster than 5.7), so the reverse filter on
  `key_column_usage.referenced_table_schema` / `referenced_table_name` is
  an indexed lookup. `information_schema.INNODB_FOREIGN` (InnoDB's own
  dictionary, `REF_NAME` = `db/table`) is lower-level still but needs the
  server-wide `PROCESS` privilege — do not require that for a browser.
- **MariaDB** — same standard `information_schema` query as MySQL. MariaDB
  kept the pre-8.0 `.frm`-era catalog, so this can be slower on a huge
  schema, with no good alternative (`INNODB_SYS_FOREIGN` is also
  `PROCESS`-gated). Acceptable on-demand.
- **SQLite** — no reverse mechanism exists and none is needed. The schema
  is parsed into memory on open. Join the `pragma_foreign_key_list`
  table-valued function against `sqlite_master` in one statement (see
  implementation work below): O(table count), single-digit ms for
  thousands of tables.

## Design decisions (resolved by the investigation)

- **Eager vs on-demand → on-demand.** A separate request when the user
  opens the panel. The measurements and DBeaver's design both point this
  way; eager would take on the N+1-per-row cost this project avoids
  elsewhere.
- **Wire shape → a new route, not a field.** A small catalog endpoint
  returns the incoming-FK list for one table (`{referencing_table,
  referencing_columns, referenced_columns, constraint_name}`). The rows
  themselves reuse `GET /api/table` with a filter — existing filter AST,
  existing `limit`/`offset`, existing FK-cell rendering
  (`frontend/src/features/grid.ts`). A field on the row/table response
  would force eager computation. This mirrors DBeaver's split: catalog
  list, then filtered read.
- **Unbounded cardinality → already handled.** `/api/table`'s existing
  pagination covers it; the panel shows one referencing table at a time.
- **Composite FKs → include them here.** §5.4.1 omits composite FKs from
  per-column `key`/`references` because one per-column field can't say
  which columns pair up. Incoming composites are common (junction
  tables), and a dedicated endpoint has room for column *lists*, so that
  reason does not apply. The child-row filter is an AND of `col = val`
  per column pair.
- **Privilege visibility → the list inherits the table-listing split
  already in `docs/adapter-decisions.md` §5.2/§5.3.** `pg_catalog.pg_constraint`
  is not privilege-filtered (unlike `information_schema.constraint_column_usage`),
  so on every backend the reverse-FK result must be intersected with that
  backend's existing table allow-list (`allowed_tables_in_tx` and peers)
  rather than trusting the catalog query. Residual behaviour then matches
  table listing: Postgres gates its allow-list on `has_table_privilege(…,
  'SELECT')` so an unreadable child table never appears; MySQL / MariaDB /
  SQLite do not gate, so it appears and fails at row fetch (MySQL error
  1142 → `NotAllowed`). Record that as the adapter-decisions row,
  cross-linked to §5.2/§5.3; `PORTING.md`'s hardening review would require
  it.

## Remaining implementation work

- **Per-backend reverse query** (the forward analog is each port's
  `key_metadata` / `key_metadata_in_tx`):
  - Postgres (`implementations/rust/core/src/db/postgres.rs`): a new
    `pg_catalog` query — `pg_constraint con JOIN pg_class / pg_namespace`
    for the referencing side, `unnest(con.conkey, con.confkey) WITH
    ORDINALITY` joined to `pg_attribute` for the column pairs, `WHERE
    con.contype = 'f' AND con.confrelid = $oid`.
  - MySQL / MariaDB (`implementations/rust/core/src/db/mysql.rs`):
    predicate flip on the existing `table_constraints` / `key_column_usage`
    join — filter `kcu.referenced_table_schema` / `referenced_table_name`.
  - SQLite (`implementations/rust/core/src/db/sqlite.rs`): `... FROM
    sqlite_master m JOIN pragma_foreign_key_list(m.name) fkl WHERE m.type
    = 'table' AND fkl."table" = ?` (table-valued function, SQLite 3.16+).
  - Go, Node, Flask, Spring Boot: mirror the same per-engine choice —
    `pg_catalog` for Postgres, `information_schema` flip for MySQL, pragma
    join for SQLite.
  - Intersect every backend's result with its table allow-list (see the
    privilege note above).
- **Frontend panel** — a "referenced by" list for the focused row, each
  entry opening the child table pre-filtered. The single-file / no-CDN
  constraint applies (`docs/frontend-style-guide.md`).
- **Spec** — the new route in `spec/protocol.md` and `spec/openapi.yaml`,
  plus its conformance case.
- **Adapter-decisions row** — the privilege-visibility divergence above.
