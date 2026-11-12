# Testing-environment gaps: seeds, demos, conformance, e2e and CI

> **Status:** OPEN · **Area:** conformance, ports, frontend, infra, docs, e2e

An inventory of what the test setup cannot catch today. It starts with the
seed data, because every other layer can only test what a seed holds. Each
gap gives what is missing, why it matters, and a rough size: **S** is under
a day, **M** is one to three days, **L** is more.

Gap IDs use letters so they don't clash with story 33's `B1`–`B6`.

## 1. The test layers today

| Layer | Data | Engines | Browsers | Runs in CI |
|---|---|---|---|---|
| Synthetic demo (`docs/demo/`) | `frontend/src/demo/seeds/{shop,tracker}.sql`, snapshotted at build time | Postgres (PGlite 18.6) | 3; 2 smoke tests | `demo.yml` |
| Live demo (`docs/demo/live/`) | same seeds, PGlite in the browser | Postgres (PGlite 18.6) | 3; 3 smoke tests | `demo.yml` |
| Live demo backend conformance | `conformance/seed/seed.sql` | PGlite | — | `demo.yml` `live-backend-conformance` |
| Conformance kit, behavior | `seed.sql`, `seed.mysql.sql`, `seed.sqlite.sql` | see §3 C | — | each `*-conformance.yml` |
| Conformance kit, schema (schemathesis) | `seed.sql` | Postgres only | — | `_conformance-schema.yml` |
| Playwright e2e, full suite | `seed.sql` | Postgres, axum only | 3 | `frontend-e2e.yml` `test-e2e` |
| Playwright e2e, other engines | `seed.sqlite.sql`, `seed.mysql.sql` | SQLite, MySQL 8 | Chromium | `frontend-e2e.yml` `test-e2e-backend` |
| Port tests | each test builds its own tables | Postgres; MySQL + MariaDB and SQLite per port | — | each port's build-and-test job |

The demo seeds are checked only by the 5 smoke tests in
`tools/e2e-tests/demo/demo-pages.demo.ts` (lines 25, 56, 62, 69; the test
at line 25 runs once per demo). Nothing else reads them.

## 2. Fixture coverage by seed

"thin" means the fixture exists but is too small to exercise the feature
that needs it. "n/a" means the engine has no such thing.

| Fixture | `shop.sql` | `tracker.sql` | `seed.sql` (Postgres) | `seed.mysql.sql` | `seed.sqlite.sql` |
|---|---|---|---|---|---|
| json / jsonb | jsonb | jsonb | jsonb | json (2 columns) | text only |
| Arrays | — | — | `text[]` only (`orders.tags`) | n/a | n/a |
| Enum | — | — (text + check) | 4 enum types (`seed.sql:54`) | — (varchar; no native `ENUM`) | n/a |
| uuid | yes | yes | yes | — | — |
| bytea / blob | — | — | thin: `inventory_counts.photo`, 10 bytes max | — | — |
| Exact numeric with precision | — | `numeric(6,2)` | `numeric(5,2)`, `numeric(10,2)` | `decimal` | `REAL` only |
| Timestamp with zone | yes | yes | yes | — (no `TIMESTAMP` column) | text |
| Timestamp without zone | — | — | — | `datetime` | text |
| time, interval, xml, geometric, money, range, bit | — | — | — | — | — |
| Generated (computed) column | — | — | — | — | — |
| Domain (over enum or json) | — | — | — | n/a | n/a |
| Explicit column collation | — | — | — | — | — |
| Untyped column (SQLite) | n/a | n/a | n/a | n/a | — |
| Empty table | — | — | `saved_reports` | yes | yes |
| PK-less table | — | — | thin: `_conformance_meta`, 1 row | thin, 1 row | thin, 1 row |
| Composite PK and FK | — | — | `inventory_locations` / `inventory_counts` | yes | yes |
| Column that is both PK and FK | `user_profiles` | — | `order_extra` | yes | yes |
| Self-referencing FK | — | — | — | — | — |
| Cyclic FKs | — | — | — | — | — |
| More than one schema | `public`, `reporting` | `public` | `public`, `other_schema`, `warehouse` | three databases | one (by nature) |
| FK into another schema | — (`reporting` has no FK) | n/a | `warehouse` → `public` | yes | n/a |
| Same table name in two schemas | — | n/a | `users` | `users` | n/a |
| View, materialized view | — | — | — | — | — |
| Partitioned table | — | — | — | — | — |
| Wide table | 7 columns max | 7 max | 9 max | 9 max | 9 max |
| Long text | — | — | thin: 1,321 chars max | 51 chars max | 51 chars max |
| Large JSON value | — | — | thin: 136 chars max | 18 chars max | 18 chars max |
| Non-ASCII text | — | — | thin: one em dash (`seed.sql:53022`) | em dash | em dash |
| Mixed-case, quoted or spaced identifier | — | — | — | — | — |
| Reserved-word name | — | — | thin: `feature_flags.key` (reserved in MySQL only) | same | same |
| Table and column comments | yes | yes | yes | yes | n/a |
| Table the role can't read | — | — | — | — | n/a |
| Large row count | 240 max | 20,000 | 30,000 (`audit_log`) | 120 max | 120 max |
| Table with no planner statistics | `order_items` | — | `feature_flags` | n/a (never sampled) | n/a (never sampled) |
| Check constraint | — | yes | `reviews_rating_check` | yes | yes (not reported) |
| Partial / expression index | — | partial | partial + expression | — / — | partial / — |

Measured on the devcontainer database and on a scratch SQLite file seeded
from `seed.sqlite.sql`. The MySQL figures come from reading the file, which
was not loaded into a server.

## 3. Gaps

### D — Demo seeds and demo builds

**D1. The demo seeds show few of the types and shapes the UI handles.**
`shop.sql` and `tracker.sql` have no enum, array, bytea, composite key,
self-referencing FK, view, empty table, wide table, long value or non-ASCII
text (§2). `reporting` has no FK into `public` (`shop.sql:98-124`), so the
cross-schema "referenced by" list and cross-schema joins (story 44) can't be
shown. Enum chips, the JSON tree on a large value (story 51), composite-FK
cells (story 49) and the binary rendering never appear in the demo.
*Why it matters:* the demo is the first thing a visitor sees, and the only
place a reviewer can try a feature without a devcontainer. *Size:* M, but see
D4 for limits.

**D2. Both demos run Postgres only.** `DEMO_ENGINE` is fixed to `postgres`
(`frontend/src/demo/sources.ts:6`), and PGlite is Postgres 18.6. MySQL and
SQLite type spellings, the hidden schema picker on SQLite, and "no common
values" on MySQL are never shown. *Why it matters:* only for demo fidelity;
the e2e mocks in E3 cover the rendering. *Size:* L (it would need a second
engine in the browser). Record as accepted unless someone asks.

**D3. The synthetic demo has its own filter, sort and paging, and nothing
checks it against a port.** `frontend/src/demo/synthetic/serve.ts`
re-implements `/tables/data` in JS. It differs from the protocol on purpose:
range filters compare by native type, not the §5.4.2 text cast
(`serve.ts:37-48`). It also hard-codes a page cap of 100
(`serve.ts:147`) and always rejects joins (`serve.ts:167`). The live-backend
conformance job tests node-express's handlers on PGlite, not `serve.ts`
(`frontend/src/demo/build/conformance-server.ts:17`). *Why it matters:* the
synthetic demo can show behavior no port has, and a bug there is invisible
to CI. *Size:* M — a small differential test that replays a fixed set of
requests through `serve.ts` and through the live backend on the same seed,
and accepts only the documented differences.

**D4. The snapshot caps every table at 200 rows and clamps its count.**
`ROW_CAP = 200` (`frontend/src/demo/build/snapshot.ts:10`) and
`approxRows: Math.min(approx, rows.length)` (`snapshot.ts:37`).
`tracker.location_pings` has 20,000 rows (`tracker.sql:67-71`), but the
synthetic page shows 200. Paging deep into a table, large `total_approx`
figures and the count display can't be shown there. The snapshot also sorts
by the first column whose `key` is `pk` (`snapshot.ts:26`). Two limits
follow for D1:
- a PK-less table gets no `ORDER BY`, so its snapshot order is not fixed and
  `frontend:build-demo-check` could fail between builds;
- a composite PK sorts on its first column only, so the same risk applies
  when that column repeats.

*Size:* S to document; S to sort by every PK column, or every column, when
building the snapshot.

**D5. Only 5 smoke tests cover both demos.** They browse, filter `status`,
open structure, switch source, and run one join (`demo-pages.demo.ts`). No
test checks the "no estimate" count on `order_items` (`shop.sql:126-128`),
the PK+FK table, the second schema, or common values. *Size:* S per test.

**D6. A demo deploy does not wait for the demo tests.** `pages.yml` deploys
on every push to `main` (`pages.yml:7-10`), and its only `needs:` is its own
build job (`pages.yml:49`). `demo.yml` runs separately. A broken live demo
can go out while `demo.yml` fails. *Size:* S (run the smoke in `pages.yml`
before deploy, or trigger on `workflow_run`).

### S — Shared conformance seeds

Story 35 owns FK parity between the three conformance seeds. These gaps are
about what all three lack.

**S1. No view, materialized view or partitioned table in any seed.** No
test in any port creates a view either (searched every port's tests for
`create view` and `materialized`). So nothing checks that `/api/tables`
lists base tables only (spec §5.2). A port that started listing views would
pass every check. Partitioned tables are covered only by port-local
Postgres tests (Rust `referenced_by_partitioning.rs`, `structure_partitioning.rs`;
Go `referenced_by_partitioning_test.go`; Spring `StructureIntegrationTest.kt:48`;
Node and Flask in their Postgres integration tests). Story 25 plans to add
a view and a materialized view to the seed; this gap is the exclusion test,
which is needed whether or not story 25 ships. *Size:* S for a view plus a
listing assertion on Postgres; M for all three seeds.

**S2. Several column classes are never asserted.**
`table_data::columns_report_their_column_class`
(`conformance/runner/table_data.rs:538`) checks `number`, `uuid`, `enum`,
`text`, `json`, `float`, `array` and `other`. No runner file names `boolean`,
`temporal` (columns exist but are not asserted), `time`, `binary` (columns
missing or too thin) or `untyped` (no SQLite column without a declared
type). No seed has a domain, so the case where `type` and `enum_type`
differ (spec §5.4.1) is untested. No seed has an explicit collation or a
type without ordering, so `P5.11-COLLATION` and `P5.4-UNSORTABLE` are left
to port tests (`conformance/runner/COVERAGE.md:234-235`). *Why it matters:*
`class` drives the join check and the UI's type-aware rendering. *Size:* M.

**S3. MySQL and SQLite seeds miss engine-specific types.** `seed.mysql.sql`
has no native `ENUM` or `SET`, no `TIMESTAMP`, `TIME`, `YEAR`, `BLOB`,
`BINARY`, `BIT`, `unsigned` or generated column, no MariaDB `uuid`, and no
4-byte UTF-8 text (the case `utf8mb4` exists for). `seed.sqlite.sql` declares only `INTEGER`,
`REAL` and `TEXT`: no `BLOB`, no `NUMERIC` affinity, no untyped column, no
`WITHOUT ROWID` or `STRICT` table. The conformance runner also lacks
MySQL expression indexes on purpose (`conformance/runner/backend.rs:228-231`),
though MySQL 8.0.13+ has them (`docs/adapter-decisions.md:259`). *Size:* M.

**S4. Edge-case identifiers are tested only as string functions.** No seed
has a table or column with mixed case, a space, a quote, non-ASCII letters,
or an SQL reserved word on Postgres. Quoting is unit-tested (Rust
`core/src/db/mod.rs:514`, Node `test/errors.test.ts:5`, Spring
`IdentifierQuotingTest.kt`), but never end to end: catalog lookup, SQL,
URL encoding, the column chips and the filter text. The filter grammar's
`name` rule has no quoted form for a column (`spec/filter-dsl.md:56`).
What click-to-filter, FK navigation and the common-values menu do for a
column outside that rule was not checked. *Why it matters:* real schemas have
such names, and the frontend builds filter text from column names. *Size:*
M (new fixture plus a few e2e checks).

**S5. No self-referencing or cyclic FK.** `references` metadata, FK
navigation and "referenced by" all have a case where a table points to
itself (a `parent_id` tree) or two tables point at each other. None of the
seeds has one. *Size:* S.

**S6. Long and non-ASCII values are thin.** The longest Postgres text is
1,321 characters and the largest JSON is 136 characters (§2). Story 51
needs a JSON array of 2,000 elements and long text in the record view.
The only non-ASCII data is an em dash. No emoji, CJK, right-to-left text or
combining marks reach the grid, the filter or `LIKE`. *Size:* S on
Postgres; M on all three.

**S7. The only PK-less table has one row.** `_conformance_meta`
(`seed.sql:214`) has no primary key but a single row. That can't show paging
order with no key, record previous/next, or the refresh highlight's row
keying (story 55 lists "PK-less table" in its tests). It also can't show the
unstable paging story 33 B1 describes. *Size:* S.

**S7a. No test pages across a non-unique sort.** The seeds have many
non-unique columns (`orders.status`, `events.event_type`). No conformance
test pages through one and checks for repeated or skipped rows: the
only offset tests ask for a page past the end
(`conformance/runner/table_data.rs:338`, `join.rs:366`), and `tools/e2e-tests/tests/pagination.spec.ts:4`
checks the buttons, not row identity. This is the test story 33 B1 needs
once the spec decides the rule. *Size:* S after B1.

**S8. The role always reads everything.** Conformance, e2e and both demos
connect as a role that can read every table. The privilege cases
(`P5.2-SELECT-PRIVILEGE`, `COVERAGE.md:65`) and story 33 B5's MySQL "listed,
then 400 on click" exist only in port tests. The UI has never been tested
against a table it lists but can't read. *Size:* M (a second, limited role
in the seed and one e2e spec on MySQL).

**S9. Two SQLite seeds exist and nothing compares them.** `tools/seed-gen`
already emits a reduced SQLite dialect (`tools/seed-gen/src/main.rs:15-17`,
`generate_sqlite` at line 1651) for `mise run rust:demo-sqlite`. The
conformance kit uses the hand-written `seed.sqlite.sql`. Story 35's first
option ("teach seed-gen to emit MySQL and SQLite") is half built already.
Link this into story 35 when it is picked up. *Size:* folded into story 35.

### C — Conformance runs

**C1. actix-web never runs conformance on MySQL, MariaDB or SQLite.**
`rust-actix-web-conformance.yml` has Postgres, two-source and schema jobs,
but no `other-backend-conformance` job (axum has one at
`rust-axum-conformance.yml:157`). The actix demo reads only `DATABASE_URL`
(`implementations/rust/actix-web/examples/demo.rs:35`) and has no
`DB_BACKEND` switch. actix ships `sqlite` and `mysql` features
(`actix-web/Cargo.toml`) that no CI job builds into a running server. The
shared `core/` lowers the risk, but the adapter's own glue is untested on
those engines. *Size:* S to M.

**C2. Schemathesis runs on Postgres only.** `_conformance-schema.yml:66,86`
starts Postgres and applies `seed.sql`, for every port. No port's MySQL or
SQLite responses are fuzzed against `spec/openapi.yaml`, and neither is the
live demo backend. Story 43 owns the Node flakiness in this job. *Size:* M.

**C3. Two-source and labelled-sibling runs are Postgres only.** Every
port's `two-source-conformance` job uses the Postgres default. A source on
MySQL or SQLite next to a Postgres one is tested only by Rust's
`tests/mixed_backends.rs`. *Size:* M.

**C4. MariaDB and MySQL share one backend in the runner.**
`conformance/runner/backend.rs:122` maps both to `Backend::Mysql`. Where the
engines differ (FK default action `NO ACTION` vs `RESTRICT`, expression
indexes, `adapter-decisions.md:259`; JSON as a checked `longtext` and a
native `uuid` on MariaDB, line 274) the
kit can only accept either answer. *Size:* S per difference.

**C5. Known gaps already listed in `COVERAGE.md`.** The undecodable-value
sentinel, query timeout, sibling health semantics and source drift are in
`conformance/runner/COVERAGE.md` from line 279. Not repeated here.

**C6. Adding a table to the conformance seed is costly.**
`SEEDED_TABLES` (`conformance/runner/tables.rs:5`) and
`tools/e2e-tests/tests/table-listing.spec.ts:5` both assert the exact table
list, and `conformance/seed/VERSION` must change. A new schema is cheaper:
the schemas test only checks that the expected schemas are present. This
is a constraint on S1–S8, not a bug. *Size:* none on its own.

### E — Playwright e2e

**E1. The full suite runs against one port and one engine.** It starts
axum's demo on Postgres (`tools/e2e-tests/playwright.config.ts:10,16`). On
SQLite and MySQL it runs only `default-scope.spec.ts` — 2 tests, Chromium
only (`playwright.config.ts:19,87`; `frontend-e2e.yml:102-109`). MariaDB
never runs in e2e (`frontend-e2e.yml:119` starts `mysql:8`). *Why it
matters:* the UI's engine-specific paths — no schema picker, no common
values, `-1` counts everywhere, MySQL type spellings — are seen in e2e only
through mocks. *Size:* M to run a chosen subset of specs per engine, with
the seed facts each spec needs.

**E2. No port other than axum serves the UI under test.**
`PLAYWRIGHT_BASE_URL` (`playwright.config.ts:32`) lets the suite target any
running port, but no workflow sets it. Each port serves the same file, and
conformance checks the page bytes and gzip. Headers a browser cares about
(CSP, caching) and mount-prefix handling are seen in a browser only on
axum. *Size:* S for one smoke spec per port.

**E3. Many specs mock `/api` with hand-written payloads.** About 20 specs
use `page.route` or `fulfill`. `cross-engine-types.spec.ts` checks MySQL and
SQLite rendering from a hand-written payload, not real port output. Nothing
checks the mocks against `spec/openapi.yaml`, so a mock can drift from the
wire contract. Story 31 §1 covers the same drift on the frontend's own
types. *Size:* M (validate each mocked body against the OpenAPI schema in a
fixture helper).

**E4. Two specs run on Chromium only** (`playwright.config.ts:24`).
`inspection-affordances.spec.ts` needs clipboard permissions, which
Playwright grants on Chromium only (`playwright.config.ts:120-121`).
`scrollbar-gutter.spec.ts` needs scrollbars with layout width, which only
Chromium gives headless (`scrollbar-gutter.spec.ts:4-5`). Copy buttons and
the gutter are untested on Firefox and WebKit. *Size:* none; both limits
are the tools'. Recorded so the gap is known.

**E5. The e2e suite can't change data.** `tools/e2e-tests/package.json` has
no database client. Story 55's "update a seed row, then refresh" test has no
way to run yet, and neither has any test of live data change. *Size:* S
(add a client and a helper that writes through `DATABASE_URL`).

**E6. Seed facts the suite needs are thin.** Wide tables (column widths,
column menu, horizontal scroll) top out at 9 columns. Long values stop at
1,321 characters, just above the 1,024-byte filter cap that
`click-to-filter.spec.ts:100` relies on. See S4–S7. *Size:* follows S.

**E7. CI retries hide flaky tests.** `retries: process.env.CI ? 2 : 0`
(`playwright.config.ts:89`). A test that passes on retry counts as green. A
report upload for flaky runs was declined in PR #191, so it is not
re-proposed here. Recorded so the retry count is a known trade-off.

### P — Port tests

**P1. Most ports skip MySQL tests when the URL is missing.** Go
(`mysql_test.go:24`), Node (`test/db/mysql.test.ts:88`), Flask
(`tests/test_mysql_integration.py:80`) and Spring
(`TableListingPrivilegesMysqlTest.kt:35`, `MySqlSourceTest.kt:111`) skip.
Rust fails instead (`core/src/db/mysql.rs:1031`). If a CI job loses or
renames `MYSQL_TEST_URL` or `MARIADB_TEST_URL`, those tests disappear and CI
stays green. The same holds for `DATABASE_URL` in Go's Postgres tests.
*Size:* S per port (fail when `CI` is set and the URL is not).

**P2. Rust Postgres tests leak schemas when an assert fails.** The
partitioning tests call `teardown` after their asserts
(`axum/tests/referenced_by_partitioning.rs:78,85`;
`axum/tests/structure_partitioning.rs:57,86`), not in a `Drop` guard like
`MysqlCleanup` (`axum/tests/common/mod.rs:27`). The devcontainer database
holds a leftover `ashb_test_referenced_by_partitioning` schema today. That
name is not in the current code, so it comes from an older version or a
failed run. A leaked schema shows up in `/api/schemas` under `rust:dev`.
Other ports' teardown was not audited. *Size:* S.

**P3. Engine coverage per port is uneven.** Each port tests its own
engines, but the topics differ. Partitioned tables: Rust, Go, Node, Flask,
Spring (Postgres only; InnoDB has no FKs on partitioned tables,
`adapter-decisions.md:242`). NUL byte in an identifier or value: Rust
(`nul_byte_identifiers.rs`), Go, Node, Flask, Spring. The undecodable
sentinel: only Flask's tests name it. Rust has the code path
(`core/src/db/postgres.rs:628`, `sqlite.rs:299`, `mysql.rs:487`) but no
test, and a search of Go, Node and Spring tests finds none. *Size:* S per
missing case. A per-topic matrix in `PORTING.md` would make this visible;
one was not built here.

### V — Engine versions and CI

**V1. One Postgres version, and no stated supported range.** CI, the
devcontainer and PGlite all run Postgres 18 (`postgres:18-alpine` in every
workflow; `.devcontainer/docker-compose.yml:17`). No supported Postgres
range is stated in `readme.md`, `docs/`, `PORTING.md` or the port READMEs.
The catalog queries need at least Postgres 11: Rust's structure query reads
`pg_index.indnkeyatts` (`core/src/db/postgres.rs:252`), added in 11. Nothing
checks which other version limits the ports have. *Size:* S to state a range; M to
add one older version to a CI matrix.

**V2. MySQL and MariaDB tags float, and the stated minimums are untested.**
CI and the devcontainer use `mysql:8` and `mariadb:11`
(`docker-compose.yml:32,49`). `adapter-decisions.md:259` says the port
needs MySQL 8.0.13 and that checks exist from 8.0.16 and MariaDB 10.2.
Line 242 records a MariaDB 12.1+ change to FK name uniqueness. No job runs
8.0.x, MySQL 9, or MariaDB 12. A floating tag also means CI can change
engine version with no commit. *Size:* M (pin tags; add a min and a latest
entry).

**V3. Each port uses its own SQLite build.** Rust uses sqlx's bundled
library, Go `modernc.org/sqlite`, Spring `xerial` sqlite-jdbc, Node the
`sqlite3` package, and Flask the Python build's own `sqlite3`
(`implementations/flask-python/pyproject.toml:26`). The SQLite adapter uses
`pragma_foreign_key_list` as a table-valued function, which needs 3.16+
(`adapter-decisions.md:243`). Flask's version depends on the runner image.
*Size:* S (log the SQLite version in each port's tests).

**V4. `mise run check` leaves out several CI jobs.** `rust:backends` is
not in `rust` or `check` (`mise.toml:35-36`). `check` also leaves out
`frontend:test-demo` and `frontend:test-e2e-backend` (`mise.toml:61-63`).
A green local `check` doesn't mean the demo smoke, the other-engine e2e or
Rust's SQLite and MySQL tests pass. No CI job runs
`frontend:test-e2e-coverage` either. *Size:* S to document; the split may
be on purpose because these need services.

### H — Stale docs found while checking

- `conformance/seed/seed.mysql.sql:8-11` and `seed.sqlite.sql:11-12` say
  nothing wires the file into the runner. `_conformance-behavior.yml:97-128`
  applies both, and every port but actix runs them (C1).
- Story 35 (line 41) says `seed.mysql.sql` has no `warehouse`. It has one
  (`seed.mysql.sql:372`).
- Story 40's `Ref` (line 3) lists only some port and engine pairs for the
  join cases. Every port but actix now runs MySQL, MariaDB and SQLite.

*Size:* S, in one docs commit.

## 4. Not checked

- `seed.mysql.sql` was not loaded into a server; its figures in §2 come
  from the file.
- No suite was run. Claims about what a test asserts come from reading it.
- What the UI does with a column name outside the filter grammar (S4).
- Every port's test teardown (P2), and the full per-topic port matrix (P3).

## 5. Suggested order

1. **H** and **D6**: stale docs, and make the Pages deploy wait for the demo
   smoke. Small and safe.
2. **P1** and **P2**: stop silent skips and schema leaks, so the later
   additions are trusted.
3. **S1** (a view and the base-tables-only assertion), **S5**, **S7** and
   **S6** on Postgres, in a new schema where possible to avoid C6's churn.
   These unblock stories 25, 51 and 55. Add **S7a** once story 33 B1
   settles the paging rule.
4. **D1** with **D4**'s sort fix: enrich the demo seeds with the same shapes.
5. **E5**, then **E1**: a database client for e2e, then a chosen subset of
   specs on SQLite and MySQL.
6. **C1**, **V2**, **V1**: actix on other engines, pinned engine versions,
   one older Postgres.
7. **S2**, **S3**, **S4**, **S8**, **C2**, **C3**, **D3**, **E3**: the larger
   fixture and contract work, alongside story 35.
