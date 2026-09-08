# Adapter decisions

Status: non-normative (companion to `spec/protocol.md`)

`spec/protocol.md` states the *property* every implementation must
guarantee for a route or field. Where a Postgres mechanism (a system
catalog, a cast operator, a stats table) is the natural way to satisfy that
property, the protocol used to name the mechanism directly. As soon as a
second backend exists, that stops working: some engines have no equivalent
catalog, so the same MUST can't be satisfied the same way.

This document is the registry of those per-backend decisions — one entry
per relaxed protocol clause, one row per implementation. When a new backend
is added, it either matches an existing row's strategy or adds a new one;
either way, add a row here rather than reopening the protocol clause.
Adding a *new* backend or a *new* row shape may still need a
`spec/protocol.md` proposal if the property itself, not just the
mechanism, would have to change (see `docs/design.md`'s governance note).

## §5.3 / §5.4.4 — `approx_rows` / `total_approx`

Protocol property: a per-table row-count figure, cheap enough to compute
for every table on every `/api/table-counts` call, that MAY be stale or
approximate — it is explicitly not a correctness-critical value.

| Backend  | Mechanism | Notes |
|----------|-----------|-------|
| Postgres | `pg_class.reltuples` | Planner estimate; MAY be `-1` before the table's first ANALYZE/VACUUM. Never `COUNT(*)` — the whole point is avoiding a full scan on every table on every page load. |
| MySQL    | `information_schema.tables.table_rows` | InnoDB's own row-count estimate, refreshed by `ANALYZE TABLE` — the direct `reltuples` analog, so unlike SQLite, MySQL never needs the "no mechanism at all" `-1` sentinel. `table_rows` is `NULL` before InnoDB has gathered any statistics for a freshly created table; `mysql.rs::table_counts`/`query_table` map that to `-1`, the same "no estimate yet" case Postgres uses before ANALYZE/VACUUM. |
| SQLite   | Always `-1` | SQLite has no `reltuples`-equivalent cardinality catalog. `implementations/rust/core/src/db/sqlite.rs::table_counts`/`query_table` used to fall back to an exact `COUNT(*)` (O(tables × rows) per `/api/table-counts` call, and a second `COUNT(*)` per page load for `total_approx`); that fallback was removed in favor of the protocol's own "no estimate" sentinel — deliberately disabled, not a stopgap. This also fixed a latent §5.4.4 nonconformance: the old `total_approx` count re-applied the request's filter `WHERE` clause, so a filtered page load returned a filtered count, not the whole-table figure the spec requires. The previously-suggested `PRAGMA` page-count estimate and caching are superseded by this decision, not still open. |

## §5.5 — `common-values`

Protocol property: cheap, catalog-derived (never a live scan) most-common
values for one column; an empty list is a valid answer, not an error.

| Backend  | Mechanism | Notes |
|----------|-----------|-------|
| Postgres | `pg_stats.most_common_vals`/`most_common_freqs` | Pre-computed by ANALYZE; a column with no stats (never analyzed, or all-unique) yields an empty list. Never `SELECT DISTINCT` or any other data query. |
| MySQL    | Always empty `values` | No `pg_stats` analog exists. MySQL 8's `information_schema.column_statistics` histogram needs an explicit `ANALYZE TABLE ... UPDATE HISTOGRAM` to populate, has a structurally different shape (singleton/equi-height buckets, not a flat most-common-values array), and doesn't exist at all on MariaDB or MySQL 5.7. Rather than branch on histogram type/version, `mysql.rs::common_values` deliberately mirrors SQLite's choice: an unconditional empty list, the protocol's own "no statistics available" answer, not a live scan. Table/column names are still validated against the live allow-list first, so an unknown table/column is still rejected. |
| SQLite   | Always empty `values` | No `pg_stats` analog exists. `sqlite.rs::common_values` used to compute frequencies from a bounded, capped live `GROUP BY ... LIMIT 20` aggregate; that was removed in favor of the protocol's own "no statistics available" answer — SQLite never maintains such statistics, so an unconditional empty list is the deliberate, permanent answer, not a stopgap. Table/column names are still validated against the live allow-list first, so an unknown table/column is still rejected before the (now-skipped) query would have run. The previously-suggested `sqlite_stat1`/`sqlite_stat4` reads and caching are superseded by this decision, not still open. |

## §5.4.3 — value serialization (text cast)

Protocol property: every cell crosses the wire as a JSON string or `null`,
produced by a cast that happens *in the query itself* (not a
decode-then-restringify step in application code), so formatting is
locale- and timezone-independent and consistent across implementations.

| Backend  | Mechanism | Notes |
|----------|-----------|-------|
| Postgres | `column::text` in the select list | Postgres's own cast; locale/timezone-independent by construction. |
| MySQL    | `CAST(column AS CHAR)` in the select list | Same property, different syntax — MySQL has no `::` operator and no `TEXT` cast target (`CHAR` is the cast target for a text representation). The `type` metadata label comes from `information_schema.COLUMNS.DATA_TYPE`, which is bare `tinyint` for a `TINYINT(1)` boolean column — the `(1)` that marks it a bool lives only in `COLUMN_TYPE`, which is not sent — so the frontend renders MySQL booleans as numbers (accepted gap). |
| SQLite   | `CAST(column AS TEXT)` in the select list | Same property, different syntax — SQLite has no `::` cast operator. SQLite's declared column types can be the empty string (dynamic typing); `sqlite.rs::query_table` falls back to the literal `"unknown"` type-name label rather than emitting `""`. |

Both mechanisms satisfy the same requirement: the cast is server-side SQL,
not a client-side or driver-level reformat. A future backend whose driver
can only decode-then-restringify would need a protocol conversation, not
just a row in this table — see the locale/timezone drift example in
`spec/protocol.md` §5.4.3.

**Undecodable bytes** (spec/protocol.md §5.4.3's `"<undecodable>"`
sentinel): SQLite is dynamically typed, so `CAST(blob AS TEXT)` passes raw
bytes through unchanged — a genuinely non-UTF-8 BLOB reaches the Python
driver's decode step and must be caught there (`sqlite.py`'s
`text_factory`). MySQL/MariaDB instead sanitize a `VARBINARY`/`BLOB`
column's `CAST(... AS CHAR)` *server-side*, before the client ever sees
it — and the two forks diverge again here: MySQL returns SQL `NULL` for
the cast (observed, not just documented — `1300 Invalid utf8mb4 character
string` warning), MariaDB substitutes `?` per invalid byte and still
returns a valid string. Neither engine's driver-level decode step is
actually reachable with invalid bytes as a result, so `mysql.py`'s
per-cell decode/sentinel guard is defense-in-depth (parity with
`mysql.rs`), not a fix for a live-reproducible crash there. Postgres never
reaches this either: `bytea::text` renders as a hex-encoded (`\x...`)
string, always valid ASCII, and Postgres enforces UTF-8 validity for
`text`/`varchar` storage directly, so `postgres.py`'s guard is the same
kind of defense-in-depth as MySQL/MariaDB's.

## §5.4.2 — filter operator mapping (`ILIKE`)

Protocol property: `ILIKE` is case-insensitive `LIKE`, distinct from
case-sensitive `LIKE`, for every implementation.

| Backend  | Mechanism | Notes |
|----------|-----------|-------|
| Postgres | `ILIKE` keyword | Native case-insensitive operator. |
| MySQL    | `LOWER(...) LIKE LOWER(?)` | Unlike SQLite, MySQL's plain `LIKE` case-sensitivity depends on the column's/comparison's *collation* — a `_ci`-collation column is already case-insensitive, a `_bin`/`_cs` one isn't, and this crate has no control over a host table's collation. A bare keyword swap to `LIKE` (SQLite's approach) can't reliably hold the case-insensitive guarantee `ILIKE` promises, so `mysql.rs::build_where_clause` wraps both sides in `LOWER(...)` instead. Plain `LIKE` (non-`ILIKE`) is left alone, so its case-sensitivity still depends on the column's collation exactly as MySQL's native `LIKE` always has. |
| SQLite   | Mapped to plain `LIKE` | SQLite's `LIKE` is already ASCII case-insensitive by default, so there's no separate keyword to map to — `ILIKE` and `LIKE` compile to the same SQL fragment (`sqlite.rs::build_where_clause`). The *observable* behavior (case-insensitive match) still holds; only the SQL-fragment mechanism collapses. Note this only covers ASCII case-folding — Postgres's `ILIKE` is more permissive on non-ASCII text, a known gap if a table has non-ASCII data. |

### Boolean values in a filter comparison

Every backend casts the target column to text before comparing a filter
value (`"col"::text` / `CAST(col AS CHAR|TEXT)` — see §5.4.4), so a filter
condition on a boolean column matches against the engine's *text
rendering* of that boolean: Postgres `true`/`false`, MySQL and SQLite
`1`/`0`. A frontend-built condition like `in_stock = true` therefore only
matches on Postgres; on MySQL/SQLite the value would need to be `1`. This
is inherent to the text-cast contract, not a per-engine mapping choice;
`conformance/runner/filter_dsl.rs` selects the literal via
`Backend::bool_true_literal()`.

## §1 — resolved schema

Protocol property: every catalog and data query for one operation is
scoped to that operation's resolved schema — an absent `schema` param
resolves to the connection's own default, a present one MUST be validated
against §5.7's live list before use — never hardcoded to a default such
as `public`.

| Backend  | Mechanism | Notes |
|----------|-----------|-------|
| Postgres | A bound `$N` parameter against `information_schema`/`pg_catalog` predicates (e.g. `table_schema = $1`), resolved once as the first statement in the operation's transaction and reused for every later query in that same transaction; absent `schema` falls back to `select current_schema()` on that connection. The one place the resolved name becomes *part of spliced SQL text* — the data query's `FROM` clause — goes through the same allow-list-then-escape discipline as table/column names (validated against §5.7's list first, then `db::quote_ident`, never spliced raw). | A Postgres database has multiple schemas; the protocol's "resolved schema" concept maps directly. Resolving once per transaction (not re-querying `current_schema()` per statement) is what keeps a multi-query operation immune to connection-pool sessions with divergent `search_path` — see `implementations/rust/axum/tests/schema_isolation.rs`. |
| MySQL    | A bound `?` parameter against `information_schema` predicates (e.g. `table_schema = ?`), resolved once as the first statement in the operation's transaction (a `Transaction<'_, MySql>` pins one physical connection exactly like Postgres's does) and reused for every later query in the same transaction; absent `schema` falls back to `select database()`. The resolved name is spliced into the data query's `FROM` clause via `mysql.rs::quote_ident_mysql` (backtick-doubling, not the shared `db::quote_ident`), after the same allow-list check. | MySQL's schema/database model is architecturally like Postgres's (`CREATE SCHEMA` is a literal synonym for `CREATE DATABASE`), not SQLite's single-file degenerate case — so it needs the same pool-session-drift regression coverage as Postgres; see `implementations/rust/axum/tests/schema_isolation_mysql.rs`, which uses `after_connect` issuing `USE {database}` as the drift-simulation mechanism (MySQL resolves unqualified table names against the connection's default database, not a searchable list like `search_path`). |
| SQLite   | Fixed single name (`"main"`); any other requested value is rejected the same way an unrecognized Postgres schema name would be | SQLite has no schema concept above the single main database file (ignoring `ATTACH`, which this crate doesn't use) — §5.7's list always has exactly one entry, and "resolved schema" degenerates to "the whole database". |

## §5.7 — schema listing

Protocol property: `GET /api/schemas` lists exactly the schemas an
operation's `schema` param may validly name — MUST exclude the engine's
own system/internal namespaces, SHOULD exclude anything the connected
role can't access.

| Backend  | Mechanism | Notes |
|----------|-----------|-------|
| Postgres | `pg_namespace`, filtered to exclude `pg_catalog`, `information_schema`, `pg_toast%`, `pg_temp_%`, and gated by `has_schema_privilege(nspname, 'USAGE')` | The `has_schema_privilege` filter is what satisfies the SHOULD clause — a schema the connected role can't use is never offered as a choice that same role's later request would then have to reject. |
| MySQL    | `information_schema.schemata`, filtered to exclude `mysql`, `information_schema`, `performance_schema`, `sys` | MUST clause satisfied. The SHOULD clause (excluding schemas the connected role can't access) is a documented, accepted gap: MySQL has no single boolean-returning function equivalent to Postgres's `has_schema_privilege` — the nearest analog (`information_schema.schema_privileges`/`user_privileges`) is materially more awkward to apply correctly, and this was deliberately not attempted for a first cut. |
| SQLite   | Fixed single-element list (`["main"]`) | No live catalog to query — trivially satisfied the same way §1's resolution is. |

**Identifier case-folding (MySQL).** `spec/protocol.md` §5.4 requires
`table`/`column`/`schema` matching to be case-sensitive exact. On MySQL
that holds only when the server runs `lower_case_table_names = 0` (the
Linux default, and what the `mysql:8` conformance CI image uses); a server
with `lower_case_table_names = 1` (macOS default, some managed hosts)
folds table identifiers to lowercase, so `table=Users` would resolve to
`users`. The conformance suite's `table_data::table_param_match_is_case_sensitive`
assumes the `= 0` setting; running it against a `= 1` server is out of
scope.

## §5.2 / §5.3 — table listing & the `table` allow-list

Protocol property: `GET /api/tables` *is* the allow-list every other
route validates a `table` param against (§5.2), and SHOULD exclude any
table the connected role can't `SELECT`; `/api/table-counts` covers the
same set.

| Backend  | Mechanism | Notes |
|----------|-----------|-------|
| Postgres | `list_tables`/`table_counts` (`pg_class`, `relkind = 'r'`) and the allow-list (`information_schema.tables`, `BASE TABLE`) are each gated by `has_table_privilege(…, 'SELECT')` | `information_schema.tables` on its own lists a table on *any* privilege (INSERT, REFERENCES, …), not `SELECT` — so without this filter an `INSERT`-only table cleared the allow-list and then failed the row fetch with a raw `permission denied` 500. The `has_table_privilege` gate keeps the listing, the counts, and the allow-list in lockstep, all on "the role can actually read it". A residual 42501 at the row fetch is still mapped to `NotAllowed` (→ 400) at the fetch site. Implemented in all five ports' Postgres sources; each has a port-local integration test (`table_listing_privileges` / `TableListingPrivilegesTest`). |
| MySQL/MariaDB | `list_tables`/`table_counts`/allow-list all from `information_schema.tables` (`BASE TABLE`) — the listing is **not** privilege-gated; a residual `ER_TABLEACCESS_DENIED_ERROR` (1142, both engines) at the row fetch is mapped to `NotAllowed` (→ 400) at the fetch site, mirroring the Postgres 42501 mapping | `information_schema.tables` lists a table on *any* privilege, so an `INSERT`-only table clears the allow-list and used to fail the row fetch with a raw 500 — the 1142 mapping closes that. The listing itself stays un-gated as a deliberate, documented gap: neither engine has a `has_table_privilege` function; `information_schema.{table,schema,user}_privileges` are role-blind (a table readable only via an active role produces no row — verified on MySQL 8.4 and MariaDB 11.8), so a filter built on them would *hide* readable tables; MySQL-only `information_schema.role_table_grants` is role-aware but table-scope-only (misses `GRANT SELECT ON db.*`) and absent on MariaDB. The one method that is accurate on both engines and all grant paths — an `EXPLAIN SELECT * FROM s.t` probe per candidate table — costs one round-trip per listed table and isn't a set predicate, so it was not adopted. The listing and the §5.2 allow-list still share one catalog source, so they never disagree with each other (the MUST). Same family of gap as the §5.7 schema case. Error mapping implemented in all five ports' MySQL sources; each has a port-local integration test (`table_listing_privileges_mysql` / `TableListingPrivilegesMysqlTest`) run against both engines. |
| SQLite   | `sqlite_master` / `pragma_table_info`; no privilege model | SQLite has no per-table access control, so "exclude what the role can't read" is vacuous — every table in the file is readable. |

## §5.2 — table/column comments

Protocol property: `comment` fields are sourced from catalog comments,
omitted (never emitted as `null` or `""`) when the table/column has none.

| Backend  | Mechanism | Notes |
|----------|-----------|-------|
| Postgres | `COMMENT ON TABLE`/`COMMENT ON COLUMN` via `obj_description`/`col_description` | |
| MySQL    | `information_schema.tables.table_comment` / `columns.column_comment` | Both sit as plain columns — no `obj_description`-style function call, and no `pg_attribute` join needed (MySQL doesn't reuse ordinal positions after a dropped column the way Postgres's `attnum` can diverge from `ordinal_position`, so there's no attnum-drift problem to work around either). The empty string means "no comment" and is mapped to `None` rather than emitted as `""`. |
| SQLite   | Always omitted | No comment mechanism exists in SQLite's catalog. `TableInfo.comment`/`ColumnInfo.comment` are always `None` — not a relaxation of the property (comments are still correctly omitted when absent), just a backend where they're *always* absent. |

## §5.2 — table listing order

Protocol property: tables SHOULD be returned in a stable order (`sort by
name` in the reference implementation) — a SHOULD, not a MUST, and "by
name" doesn't pin a specific collation. Discovered while adding the
`order_extra` fixture (docs/feature-backlog/13-pk-that-is-also-fk-loses-references.md):
MariaDB's default collation sorts `order_extra` *after* `orders`
(underscore outweighs letters), while MySQL, Postgres, and SQLite all
sort it before — each backend's `order by table_name`/equivalent defers
to that engine's own default collation, so exact cross-backend ordering
of two names sharing a prefix isn't guaranteed. Port-level tests that
assert on table order should treat this as backend-specific rather than
assume ASCII/byte ordering universally.

## §5.9 — incoming FK references (`/api/tables/referenced-by`)

Protocol property: for a given `table`, the foreign keys elsewhere whose
*target* is that table — a catalog-only reverse scan of the FK graph
(§5.4.1 reports the forward direction per column). Composite FKs are
included, with the column pairing explicit. Entries SHOULD be limited to
referencing tables the role can read, mirroring §5.2's own listing
courtesy; an engine whose readable-table allow-list is single-schema MAY
restrict the result to the resolved schema rather than report
cross-schema referrers it can't privilege-check. This section is the
reverse-direction companion to the `## §5.2 / §5.3` table-listing
privilege split above, and inherits it.

| Backend  | Mechanism | Notes |
|----------|-----------|-------|
| Postgres | `pg_catalog.pg_constraint` (`contype = 'f'`, `confrelid` = the target table's OID), joined to `pg_class`/`pg_namespace` for the referencing table's schema and `unnest(conkey, confkey) WITH ORDINALITY` ⨝ `pg_attribute` for the column pairs; gated in-query by `has_table_privilege(con.conrelid, 'SELECT')` | The `information_schema` reverse query (the forward `table_constraints`/`key_column_usage`/`constraint_column_usage` join with the filter moved to the referenced side) is correct but measured 18–140 ms on a ~2,000-table catalog — the standard-SQL views have no predicate push-down, expand `conkey` per constraint, and call `has_*_privilege` per row; the same tax the forward `key_metadata` query already pays. `pg_catalog` filtered on `confrelid` is ~1–6 ms at that size (see `docs/feature-backlog/14-incoming-fk-references.md` for the measurements). The `confrelid` predicate is a small sequential scan of `pg_constraint` — there is no `confrelid` index — but the catalog is tiny; the target OID is resolved with a bound-parameter `pg_class`/`pg_namespace` lookup, never a `::regclass` cast on request text. The in-query `has_table_privilege` gate is the whole privilege story: it works per-referrer regardless of schema, so cross-schema referrers are included (and gated), and there is no separate `allowed_tables` intersection (which is single-schema and would drop them). This is the one place the Rust Postgres source reads FK topology from `pg_catalog` rather than `information_schema` (§6 server invariant "no unvalidated identifier reaches SQL" is unaffected — the request's `table` is already allow-list-validated, and every referencing name in the result is allow-list-checked before any §5.4 drill-in). |
| MySQL/MariaDB | `information_schema.key_column_usage` predicate-flip: `WHERE referenced_table_schema = ? AND referenced_table_name = ? AND table_schema = ?` (the last clause scopes to the resolved database — cross-database FKs are not surfaced). Match on `key_column_usage`, **not** `referential_constraints`: MariaDB nulls `referential_constraints.referenced_table_name` for a role lacking privilege on the *referenced* table, while `key_column_usage.referenced_table_name` stays populated (verified on MariaDB 11.8). Then intersect the referencing table names against the un-gated `information_schema.tables` allow-list | MySQL 8.0+'s `information_schema` is an indexed view over the transactional data dictionary, so this stays fast — no `pg_catalog` escape hatch needed (MariaDB keeps the pre-8.0 `.frm`-era catalog and is slower on a large schema, but on-demand once per panel open it is acceptable, and `information_schema.INNODB_SYS_FOREIGN` — its only faster alternative — needs the server-wide `PROCESS` privilege). `schema` is never emitted (the result is single-database by construction). Neither engine has a `has_table_privilege` analog (no scalar privilege predicate at all — verified against MySQL 8.4 / 9.x and MariaDB 11.8 / 12.x docs), so the privilege gate is only partial: `information_schema` rows are already privilege-scoped, so a referencing table the role has **no** privilege on is not listed at all (verified on both engines); one the role has *some* privilege on (INSERT/UPDATE/REFERENCES/…) but not `SELECT` still lists, and fails the later §5.4 row fetch with `ER_TABLEACCESS_DENIED_ERROR` (1142) → `NotAllowed` (400) — the same residual-mapping gap already documented for the forward direction in `## §5.2 / §5.3`. `key_column_usage` itself needs no special privilege (unlike `INNODB_SYS_FOREIGN`). MariaDB 12.1+ makes FK constraint names unique per table rather than per database, so `constraint` alone is not a response-wide key there; `(table, constraint)` still is (`spec/protocol.md` §5.9). |
| SQLite   | `sqlite_master` ⨝ `pragma_foreign_key_list(m.name)` table-valued function (SQLite 3.16+), `WHERE fkl."table" = ? COLLATE NOCASE` | No reverse-FK index and no `information_schema` — but the whole schema is parsed into memory when the DB opens, so scanning every table's `pragma_foreign_key_list` is single-digit ms even for thousands of tables. The TVF argument is a column reference (no splicing); `fkl."table" = ?` is an ordinary bound predicate. `pragma_foreign_key_list` returns the referenced table name as written in the `REFERENCES` clause (DDL text), while SQLite resolves names case-insensitively — `COLLATE NOCASE` closes that gap. FK constraints are unnamed in SQLite, so `constraint` is synthesized as `fk_<id>` from `pragma_foreign_key_list.id` (stable within one catalog read, not across schema changes — spec/protocol.md §5.9 permits this). `schema` is never emitted (single schema). No privilege model, and the `sqlite_master` predicate here (`type = 'table'`, no `sqlite_%`) is byte-identical to `allowed_tables()`, so every referrer it yields is already allow-listed — no separate intersection step, unlike Postgres/MySQL. The request `table` is still allow-list-checked before the query runs. |

## §6 — query timeouts

Protocol property: every database query, catalog and metadata queries
included, MUST be bounded by a timeout so a pathological query can't hold
a host-pool connection indefinitely.

| Backend  | Mechanism | Notes |
|----------|-----------|-------|
| Postgres | `SET LOCAL statement_timeout` inside the operation's transaction | Genuinely transaction-scoped in Postgres — set once, applies to every query in that transaction, no explicit cleanup needed. |
| MySQL    | `MAX_EXECUTION_TIME(ms)` optimizer hint on every individual `SELECT` | MySQL's `SET LOCAL` is a documented plain synonym for `SET SESSION`, not transaction-scoped like Postgres's — reusing the Postgres pattern verbatim would leak the timeout onto the pooled connection's next reuse. The hint is self-resetting (applies only to the one statement it's attached to), so unlike SQLite's progress handler it needs no explicit clear-before-pool-return step. Same mechanism in both the Rust (`mysql.rs::timed_select`) and Node (`db/mysql.ts::timedSelect`) implementations — `mysql2` sends the hint text verbatim, same as `sqlx`. |
| MariaDb  | `SET STATEMENT max_statement_time=N FOR SELECT ...` wrapping every individual `SELECT` (`N` in seconds, not ms) | MariaDB never implemented MySQL's `MAX_EXECUTION_TIME` optimizer-hint syntax at all — an unrecognized `/*+ ... */` comment is silently ignored rather than rejected, so reusing MySQL's hint on MariaDB would fail open (query runs unbounded, no error). `mysql.rs::timed_select` (Rust) and `db/mysql.ts::timedSelect` (Node) both detect which fork they're talking to once per source instance (`SELECT VERSION()` containing `MariaDB`, cached) and branch accordingly. Also self-resetting, no explicit cleanup needed. Verified empirically against both live devcontainer services (`mysql`, `mariadb`) in both implementations' own test suites — the Node port's `test/db/mysql.test.ts` runs the identical slow-recursive-CTE proof against each fork by name, not just one and an assumption of symmetry. |
| SQLite (Rust) | `sqlite3_progress_handler`, checked every 1000 VM opcodes, explicitly cleared after each query | No `SET LOCAL`/session-timeout equivalent, and no per-statement hint mechanism either; each SQLite connection runs on its own dedicated worker thread, so wrapping the query future in `tokio::time::timeout` would only stop *waiting*, not the blocking call itself. Must be cleared (`set_progress_handler(0, ...)`) before the connection returns to the pool, or a reused connection would inherit an already-elapsed deadline — see `sqlite.rs::bounded`. Not Rust-specific: `implementations/flask-python`'s port confirmed the same C-level hook is exposed by Python's stdlib `sqlite3` too (`Connection.set_progress_handler`), empirically aborting a real slow query rather than just failing to observe one — see `flask-python/ashurbanipal/db/sqlite.py` and its `test_slow_query_is_aborted_by_the_progress_handler_not_left_to_run` test. Worth confirming per-driver rather than assuming a binding lacks it. |
| SQLite (Go/net-http) | Plain `context.WithTimeout` around every `database/sql` `QueryContext`/`QueryRowContext` call | Genuinely different mechanism from the Rust reference, not just a different binding of the same one — `sqlite3_progress_handler` is an `sqlx`-driver-specific escape hatch the *C* library forced (the Rust async runtime's own cancellation only stops waiting, not the underlying blocking call), not something inherent to every SQLite binding. Empirically verified (not inferred from documentation) against a real on-disk file with a single-connection pool: a slow recursive-CTE query canceled by `ctx` returns in ~1s rather than running to completion, and a query issued immediately afterward on the *same physical connection* completes without delay — proving `modernc.org/sqlite` actually aborts execution on cancellation, not just the caller's wait. See `implementations/go-nethttp/sqlite.go::bounded` and `sqlite_test.go::TestSQLiteSlowQueryIsAbortedNotLeftToRun`. Nothing needs clearing afterward, unlike the Rust mechanism. |
| SQLite (Node/node-express) | `Database.prototype.interrupt()` (`sqlite3_interrupt()`), fired from a JS timer if the query hasn't settled by the deadline | The `sqlite3` npm package (mapbox/node-sqlite3) exposes no progress-handler equivalent, so `db/sqlite.ts::bounded` uses SQLite's coarser `sqlite3_interrupt()` instead, guarded by a `settled` flag cleared as the first synchronous step of the query's own completion so a timer that fires after the query already finished becomes a no-op. Two Node SQLite drivers were rejected after checking empirically (not just from docs): `node:sqlite`'s `DatabaseSync` and `better-sqlite3` both execute fully synchronously with no interrupt hook at all, so a slow query would block the whole process with no cancellation path short of a worker-thread rewrite. **Accepted gap**: calling `interrupt()` on an idle connection was confirmed empirically to poison the *next* query issued on it rather than no-op, so a timer that matures in the exact same event-loop tick as the query's own completion (a race the `settled` guard cannot close, since JS has no atomic check-and-clear across two independently-scheduled callbacks) could spuriously fail an unrelated later query on that connection. This is a narrower, JS-event-loop-specific version of the same "must not leak stale timeout state onto the next query" hazard the Rust progress handler guards against, not a new protocol-property relaxation — the timeout property itself (a genuinely slow query is bounded) still holds, proven by `test/db/sqlite.test.ts`'s live interrupt test. |
| MySQL/MariaDB (Spring Boot) | Same `timedSelect`-wrapped SQL text as the Rust rows above (`MySqlSource.kt::timedSelect`, identical branch logic) | The JDBC layer needs one extra step the Rust `sqlx` driver doesn't: Connector/J's `PreparedStatement.executeQuery()` rejects any SQL that doesn't *textually* start with a query keyword, and MariaDB's `SET STATEMENT ... FOR SELECT ...` wrapping trips this even though the server would return a result set (`Statement.executeQuery() cannot issue statements that do not produce result sets`, verified empirically). `MySqlSource.kt`'s `query()` helper uses `PreparedStatement.execute()` + `getResultSet()` instead, which has no such restriction. |
| SQLite (Spring Boot) | `org.sqlite.ProgressHandler` (Xerial `sqlite-jdbc`'s public binding to `sqlite3_progress_handler`), checked every 1000 VM opcodes, explicitly cleared after each query — `SqliteSource.kt::bounded` | Verified empirically (not trusted from documented intent) that plain JDBC `Statement.setQueryTimeout()` does **not** cancel a running query on this driver — decompiling `JDBC3Statement.withConnectionTimeout` shows it only calls `SQLiteConnection.setBusyTimeout()`, the *lock-wait* timeout, not a query-execution bound; a first version of the timeout test using `setQueryTimeout` ran a genuinely slow query to completion in ~11s instead of aborting near a 1s budget. The real mechanism is Xerial's own `org.sqlite.ProgressHandler.setHandler(Connection, int, ProgressHandler)`/`clearHandler(Connection)` static API, which requires the connection to be (or unwrap to) `org.sqlite.SQLiteConnection` — a pooled connection (HikariCP) hands back a proxy that fails that `instanceof` check directly, so `SqliteSource.kt::bounded` calls `Connection.unwrap(SQLiteConnection::class.java)` before registering/clearing the handler. |

## Status note

The SQLite adapter (`implementations/rust/core/src/db/sqlite.rs`, gated behind
the `sqlite` Cargo feature) and the MySQL/MariaDB adapter
(`implementations/rust/core/src/db/mysql.rs`, gated behind the `mysql` Cargo
feature) are both off by default and have been reviewed and merged as
supported backends of the Rust implementation — neither is a separate
entry in `readme.md`'s implementation table, since each is an alternate
`DbSource` within `implementations/rust` rather than a distinct
language/framework port under `PORTING.md`. `MySqlSource` targets one
`sqlx` driver serving both MySQL and MariaDB (they share a wire protocol)
but the two forks diverge on the query-timeout mechanism (§6 above); it
detects which one it's talking to at runtime rather than requiring the
host to declare it. Both adapters now run through `conformance/runner`:
`rust-axum-conformance.yml`'s `mysql-conformance` and `sqlite-conformance`
jobs boot a `DB_BACKEND=mysql` / `DB_BACKEND=sqlite` demo against a
hand-authored dialect seed (`conformance/seed/seed.mysql.sql` /
`seed.sqlite.sql`, the sqlx-style split — the Postgres seed's generator
emits Postgres-only SQL) and point the kit at it; the runner learns which
engine's expectations to hold from the seed's `_conformance_meta.dialect`
column (`conformance/runner/backend.rs`). A `non-default-backend-tests`
job runs the feature lint plus the `sqlite`/`mysql` unit and integration
tests (`mise run rust:backends`) against `mysql:8` + `mariadb:11` service
containers. The devcontainer still runs permanent `mysql` and `mariadb`
services for local runs (`MYSQL_TEST_URL` / `MARIADB_TEST_URL`). The rows above
describe the per-clause decisions each makes to satisfy
`spec/protocol.md`'s properties without Postgres's catalog/stats
mechanisms — most notably SQLite's exact-`COUNT(*)`-turned-`-1` and live-
`GROUP BY`-turned-empty relaxations, and MySQL/MariaDB's `LOWER(...)`-
wrapped `ILIKE`, always-empty `common_values`, and per-fork timeout
mechanism — which remain real behavioral differences from the Postgres
path (see their notes above), not open questions blocking use.

`implementations/node-express` (`src/db/sqlite.ts`, `src/db/mysql.ts`)
brings the same two backends to the Node port, behind the same
`DbSource`-equivalent seam (`src/db/types.ts`) rather than Cargo-style
compile-time feature gating, which TypeScript/npm has no direct analog
for — see the port's own README for how it keeps backend selection
explicit (the host constructs and passes the `DbSource` it wants; neither
backend is re-exported from the package's main barrel, so importing the
library at all doesn't pull in `sqlite3`/`mysql2`). Every per-clause
mechanism matches the Rust reference's choice (§5.3–§5.5, §5.7 above)
except query timeouts, where SQLite's driver difference forced a new
mechanism — see the split "SQLite (Rust)" / "SQLite (Node/node-express)"
rows in §6 above. Both new backends are verified against real live
instances (`MYSQL_TEST_URL`, `MARIADB_TEST_URL`, plus an in-memory SQLite
db), not just unit-tested against a description of expected behavior.

`implementations/spring-boot-starter`'s `MySqlSource`/`SqliteSource`
(Kotlin, gated behind the explicit `ashurbanipal.backend=mysql`/`sqlite`
config property, never classpath/driver detection — see `PORTING.md`'s
hardening checklist item 2) follow the same per-clause decisions as their
Rust counterparts, with the two JDBC-specific mechanism notes in the §6
rows above (the "MySQL/MariaDB (Spring Boot)" and "SQLite (Spring Boot)"
rows). Also off by default, also not a separate `readme.md` entry (an
alternate `DbSource` within an already-listed port, not a distinct port),
also outside `conformance/runner`. `SqliteSourceTest` needs no external
infrastructure (a temp on-disk file — `sqlite::memory:`-equivalent
isolation isn't available through plain JDBC `DriverManager` connections
the way `SqlitePool` gives Rust); `MySqlSourceTest` needs
`MYSQL_TEST_URL`/`MARIADB_TEST_URL` and, unlike the Rust suite, actively
runs every test against *both* when both are reachable (the devcontainer
has permanent `mysql` and `mariadb` services), rather than only one
variable covering whichever fork happens to be behind it.
