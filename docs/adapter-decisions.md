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
| SQLite   | Always `-1` | SQLite has no `reltuples`-equivalent cardinality catalog. `implementations/rust/src/db/sqlite.rs::table_counts`/`query_table` used to fall back to an exact `COUNT(*)` (O(tables × rows) per `/api/table-counts` call, and a second `COUNT(*)` per page load for `total_approx`); that fallback was removed in favor of the protocol's own "no estimate" sentinel — deliberately disabled, not a stopgap. This also fixed a latent §5.4.4 nonconformance: the old `total_approx` count re-applied the request's filter `WHERE` clause, so a filtered page load returned a filtered count, not the whole-table figure the spec requires. The previously-suggested `PRAGMA` page-count estimate and caching are superseded by this decision, not still open. |

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
| MySQL    | `CAST(column AS CHAR)` in the select list | Same property, different syntax — MySQL has no `::` operator and no `TEXT` cast target (`CHAR` is the cast target for a text representation). |
| SQLite   | `CAST(column AS TEXT)` in the select list | Same property, different syntax — SQLite has no `::` cast operator. SQLite's declared column types can be the empty string (dynamic typing); `sqlite.rs::query_table` falls back to the literal `"unknown"` type-name label rather than emitting `""`. |

Both mechanisms satisfy the same requirement: the cast is server-side SQL,
not a client-side or driver-level reformat. A future backend whose driver
can only decode-then-restringify would need a protocol conversation, not
just a row in this table — see the locale/timezone drift example in
`spec/protocol.md` §5.4.3.

## §5.4.2 — filter operator mapping (`ILIKE`)

Protocol property: `ILIKE` is case-insensitive `LIKE`, distinct from
case-sensitive `LIKE`, for every implementation.

| Backend  | Mechanism | Notes |
|----------|-----------|-------|
| Postgres | `ILIKE` keyword | Native case-insensitive operator. |
| MySQL    | `LOWER(...) LIKE LOWER(?)` | Unlike SQLite, MySQL's plain `LIKE` case-sensitivity depends on the column's/comparison's *collation* — a `_ci`-collation column is already case-insensitive, a `_bin`/`_cs` one isn't, and this crate has no control over a host table's collation. A bare keyword swap to `LIKE` (SQLite's approach) can't reliably hold the case-insensitive guarantee `ILIKE` promises, so `mysql.rs::build_where_clause` wraps both sides in `LOWER(...)` instead. Plain `LIKE` (non-`ILIKE`) is left alone, so its case-sensitivity still depends on the column's collation exactly as MySQL's native `LIKE` always has. |
| SQLite   | Mapped to plain `LIKE` | SQLite's `LIKE` is already ASCII case-insensitive by default, so there's no separate keyword to map to — `ILIKE` and `LIKE` compile to the same SQL fragment (`sqlite.rs::build_where_clause`). The *observable* behavior (case-insensitive match) still holds; only the SQL-fragment mechanism collapses. Note this only covers ASCII case-folding — Postgres's `ILIKE` is more permissive on non-ASCII text, a known gap if a table has non-ASCII data. |

## §1 — resolved schema

Protocol property: every catalog and data query for one operation is
scoped to that operation's resolved schema — an absent `schema` param
resolves to the connection's own default, a present one MUST be validated
against §5.7's live list before use — never hardcoded to a default such
as `public`.

| Backend  | Mechanism | Notes |
|----------|-----------|-------|
| Postgres | A bound `$N` parameter against `information_schema`/`pg_catalog` predicates (e.g. `table_schema = $1`), resolved once as the first statement in the operation's transaction and reused for every later query in that same transaction; absent `schema` falls back to `select current_schema()` on that connection. The one place the resolved name becomes *part of spliced SQL text* — the data query's `FROM` clause — goes through the same allow-list-then-escape discipline as table/column names (validated against §5.7's list first, then `db::quote_ident`, never spliced raw). | A Postgres database has multiple schemas; the protocol's "resolved schema" concept maps directly. Resolving once per transaction (not re-querying `current_schema()` per statement) is what keeps a multi-query operation immune to connection-pool sessions with divergent `search_path` — see `implementations/rust/tests/schema_isolation.rs`. |
| MySQL    | A bound `?` parameter against `information_schema` predicates (e.g. `table_schema = ?`), resolved once as the first statement in the operation's transaction (a `Transaction<'_, MySql>` pins one physical connection exactly like Postgres's does) and reused for every later query in the same transaction; absent `schema` falls back to `select database()`. The resolved name is spliced into the data query's `FROM` clause via `mysql.rs::quote_ident_mysql` (backtick-doubling, not the shared `db::quote_ident`), after the same allow-list check. | MySQL's schema/database model is architecturally like Postgres's (`CREATE SCHEMA` is a literal synonym for `CREATE DATABASE`), not SQLite's single-file degenerate case — so it needs the same pool-session-drift regression coverage as Postgres; see `implementations/rust/tests/schema_isolation_mysql.rs`, which uses `after_connect` issuing `USE {database}` as the drift-simulation mechanism (MySQL resolves unqualified table names against the connection's default database, not a searchable list like `search_path`). |
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

## §5.2 — table/column comments

Protocol property: `comment` fields are sourced from catalog comments,
omitted (never emitted as `null` or `""`) when the table/column has none.

| Backend  | Mechanism | Notes |
|----------|-----------|-------|
| Postgres | `COMMENT ON TABLE`/`COMMENT ON COLUMN` via `obj_description`/`col_description` | |
| MySQL    | `information_schema.tables.table_comment` / `columns.column_comment` | Both sit as plain columns — no `obj_description`-style function call, and no `pg_attribute` join needed (MySQL doesn't reuse ordinal positions after a dropped column the way Postgres's `attnum` can diverge from `ordinal_position`, so there's no attnum-drift problem to work around either). The empty string means "no comment" and is mapped to `None` rather than emitted as `""`. |
| SQLite   | Always omitted | No comment mechanism exists in SQLite's catalog. `TableInfo.comment`/`ColumnInfo.comment` are always `None` — not a relaxation of the property (comments are still correctly omitted when absent), just a backend where they're *always* absent. |

## §6 — query timeouts

Protocol property: every database query, catalog and metadata queries
included, MUST be bounded by a timeout so a pathological query can't hold
a host-pool connection indefinitely.

| Backend  | Mechanism | Notes |
|----------|-----------|-------|
| Postgres | `SET LOCAL statement_timeout` inside the operation's transaction | Genuinely transaction-scoped in Postgres — set once, applies to every query in that transaction, no explicit cleanup needed. |
| MySQL    | `MAX_EXECUTION_TIME(ms)` optimizer hint on every individual `SELECT` | MySQL's `SET LOCAL` is a documented plain synonym for `SET SESSION`, not transaction-scoped like Postgres's — reusing the Postgres pattern verbatim would leak the timeout onto the pooled connection's next reuse. The hint is self-resetting (applies only to the one statement it's attached to), so unlike SQLite's progress handler it needs no explicit clear-before-pool-return step. |
| MariaDb  | `SET STATEMENT max_statement_time=N FOR SELECT ...` wrapping every individual `SELECT` (`N` in seconds, not ms) | MariaDB never implemented MySQL's `MAX_EXECUTION_TIME` optimizer-hint syntax at all — an unrecognized `/*+ ... */` comment is silently ignored rather than rejected, so reusing MySQL's hint on MariaDB would fail open (query runs unbounded, no error). `mysql.rs::timed_select` detects which fork it's talking to once per `MySqlSource` (`SELECT VERSION()` containing `MariaDB`, cached) and branches accordingly. Also self-resetting, no explicit cleanup needed. |
| SQLite (Rust) | `sqlite3_progress_handler`, checked every 1000 VM opcodes, explicitly cleared after each query | No `SET LOCAL`/session-timeout equivalent, and no per-statement hint mechanism either; each SQLite connection runs on its own dedicated worker thread, so wrapping the query future in `tokio::time::timeout` would only stop *waiting*, not the blocking call itself. Must be cleared (`set_progress_handler(0, ...)`) before the connection returns to the pool, or a reused connection would inherit an already-elapsed deadline — see `sqlite.rs::bounded`. |
| SQLite (Go/net-http) | Plain `context.WithTimeout` around every `database/sql` `QueryContext`/`QueryRowContext` call | Genuinely different mechanism from the Rust reference, not just a different binding of the same one — `sqlite3_progress_handler` is an `sqlx`-driver-specific escape hatch the *C* library forced (the Rust async runtime's own cancellation only stops waiting, not the underlying blocking call), not something inherent to every SQLite binding. Empirically verified (not inferred from documentation) against a real on-disk file with a single-connection pool: a slow recursive-CTE query canceled by `ctx` returns in ~1s rather than running to completion, and a query issued immediately afterward on the *same physical connection* completes without delay — proving `modernc.org/sqlite` actually aborts execution on cancellation, not just the caller's wait. See `implementations/go-nethttp/sqlite.go::bounded` and `sqlite_test.go::TestSQLiteSlowQueryIsAbortedNotLeftToRun`. Nothing needs clearing afterward, unlike the Rust mechanism. |

## Status note

The SQLite adapter (`implementations/rust/src/db/sqlite.rs`, gated behind
the `sqlite` Cargo feature) and the MySQL/MariaDB adapter
(`implementations/rust/src/db/mysql.rs`, gated behind the `mysql` Cargo
feature) are both off by default and have been reviewed and merged as
supported backends of the Rust implementation — neither is a separate
entry in `readme.md`'s implementation table, since each is an alternate
`DbSource` within `implementations/rust` rather than a distinct
language/framework port under `PORTING.md`. `MySqlSource` targets one
`sqlx` driver serving both MySQL and MariaDB (they share a wire protocol)
but the two forks diverge on the query-timeout mechanism (§6 above); it
detects which one it's talking to at runtime rather than requiring the
host to declare it. Neither adapter is run through `conformance/runner`
(that suite targets Postgres); each has its own unit test suite instead —
SQLite's needs no external infrastructure (`sqlite::memory:`), while
MySQL/MariaDB's needs a live instance reachable via `MYSQL_TEST_URL` (the
devcontainer's `mysql` service, or any MariaDB instance pointed at by the
same variable when verifying that path — there is no separate MariaDB
devcontainer service or CI job; this mirrors the same "no CI coverage"
gap already accepted for `mysql`/`sqlite` generally). The rows above
describe the per-clause decisions each makes to satisfy
`spec/protocol.md`'s properties without Postgres's catalog/stats
mechanisms — most notably SQLite's exact-`COUNT(*)`-turned-`-1` and live-
`GROUP BY`-turned-empty relaxations, and MySQL/MariaDB's `LOWER(...)`-
wrapped `ILIKE`, always-empty `common_values`, and per-fork timeout
mechanism — which remain real behavioral differences from the Postgres
path (see their notes above), not open questions blocking use.
