# Per-engine expectations for the filter-builder fixtures

> **Status:** DONE · **Area:** ports, conformance · **Ref:** `spec/fixtures/filter-builder-tests.json` over the shared `spec/fixtures/catalogs.json`, run per engine in all five ports; follow-up to [59](59-join-builder-golden-sql-fixtures.md)

**Ask:** give `spec/fixtures/filter-builder-tests.json` one expected
WHERE clause per engine (Postgres, SQLite, MySQL/MariaDB), the way
`join-builder-tests.json` pins one statement per engine. Every port runs
each case once per engine against that engine's own catalog columns and
dialect, with no database.

**Why:** today every port's filter-fixture runner is Postgres-only. The
fixture's `tables` map holds Postgres types, and each runner builds the
WHERE clause with the Postgres dialect. The SQLite and MySQL table-route
builders (their casts, pattern operators, typed-comparison targets and
placeholders) are pinned only by HTTP conformance against a live seed,
which checks rows, not SQL. A dialect bug like #283 (MySQL's zero date)
can pass that suite when the seed has no row that exposes it. The join
fixture already covers some filter shapes per engine, but only on the
join route, through generated `t{n}` aliases. A new port in a popular
language should get a per-engine test table for the table route too,
instead of deriving each engine's casts from prose.

**Shape:** owned by `spec/fixtures/README.md`. Catalog columns are
engine-native, as in the join fixture, so each runner calls the engine's
own type-to-class and typed-comparison functions. Structural rejections
stay engine-independent. The black-box HTTP suite
(`conformance/runner/filter_dsl.rs`) keeps consuming the same file.

**Done when:** every valid case pins `where` and `values` for each engine
it applies to, every port's runner checks all three engines, the HTTP
suite still passes against every backend, and `spec/fixtures/README.md`
documents the new shape.
