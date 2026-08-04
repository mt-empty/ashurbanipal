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
| SQLite   | `SELECT COUNT(*)` | SQLite has no `reltuples`-equivalent cardinality catalog. `implementations/rust/src/db/sqlite.rs::table_counts` falls back to an exact count. Flagged as a perf concern on large tables — every `/api/table-counts` call is now O(tables × rows), not O(tables) — and worth revisiting (e.g. `PRAGMA` page-count-based estimate, or caching) as a follow-up, not a blocker. |

## §5.5 — `common-values`

Protocol property: cheap, catalog-derived (never a live scan) most-common
values for one column; an empty list is a valid answer, not an error.

| Backend  | Mechanism | Notes |
|----------|-----------|-------|
| Postgres | `pg_stats.most_common_vals`/`most_common_freqs` | Pre-computed by ANALYZE; a column with no stats (never analyzed, or all-unique) yields an empty list. Never `SELECT DISTINCT` or any other data query. |
| SQLite   | Live `GROUP BY ... ORDER BY COUNT(*) DESC LIMIT 20` | No `pg_stats` analog exists. `sqlite.rs` computes frequencies from a bounded, capped live aggregate (`COMMON_VALUES_LIMIT = 20`) rather than reading pre-computed stats. This is a real relaxation of "never a data query" — accepted because the query is `GROUP BY` + `LIMIT`, not an unbounded `SELECT DISTINCT`, but it does real I/O proportional to table size on every call, unlike the Postgres path. Worth reconsidering (e.g. caching, or reading SQLite's own `ANALYZE`-produced `sqlite_stat1`/`sqlite_stat4` tables when present) as a follow-up. |

## §5.4.3 — value serialization (text cast)

Protocol property: every cell crosses the wire as a JSON string or `null`,
produced by a cast that happens *in the query itself* (not a
decode-then-restringify step in application code), so formatting is
locale- and timezone-independent and consistent across implementations.

| Backend  | Mechanism | Notes |
|----------|-----------|-------|
| Postgres | `column::text` in the select list | Postgres's own cast; locale/timezone-independent by construction. |
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
| SQLite   | Mapped to plain `LIKE` | SQLite's `LIKE` is already ASCII case-insensitive by default, so there's no separate keyword to map to — `ILIKE` and `LIKE` compile to the same SQL fragment (`sqlite.rs::build_where_clause`). The *observable* behavior (case-insensitive match) still holds; only the SQL-fragment mechanism collapses. Note this only covers ASCII case-folding — Postgres's `ILIKE` is more permissive on non-ASCII text, a known gap if a table has non-ASCII data. |

## §1 — connected schema

Protocol property: every catalog and data query is scoped to one
connected schema, never hardcoded to a default.

| Backend  | Mechanism | Notes |
|----------|-----------|-------|
| Postgres | `current_schema()` | A Postgres database has multiple schemas; the protocol's "connected schema" concept maps directly. |
| SQLite   | N/A — whole database | SQLite has no schema concept above the single main database file (ignoring `ATTACH`, which this crate doesn't use). "Connected schema" degenerates to "the whole database" — there's nothing to scope against, so the property is trivially satisfied rather than actively enforced. |

## §5.2 — table/column comments

Protocol property: `comment` fields are sourced from catalog comments,
omitted (never emitted as `null` or `""`) when the table/column has none.

| Backend  | Mechanism | Notes |
|----------|-----------|-------|
| Postgres | `COMMENT ON TABLE`/`COMMENT ON COLUMN` via `obj_description`/`col_description` | |
| SQLite   | Always omitted | No comment mechanism exists in SQLite's catalog. `TableInfo.comment`/`ColumnInfo.comment` are always `None` — not a relaxation of the property (comments are still correctly omitted when absent), just a backend where they're *always* absent. |

## Status note

The SQLite adapter (`implementations/rust/src/db/sqlite.rs`) is gated
behind the `sqlite` Cargo feature (off by default) and has been reviewed
and merged as a supported backend of the Rust implementation — not a
separate entry in `readme.md`'s implementation table, since it's an
alternate `DbSource` within `implementations/rust` rather than a distinct
language/framework port under `PORTING.md`. It is not run through
`conformance/runner` (that suite targets Postgres); it has its own unit
test suite instead. The rows above describe the per-clause decisions it
makes to satisfy `spec/protocol.md`'s properties without Postgres's
catalog/stats mechanisms — most notably the exact-`COUNT(*)` and live
`GROUP BY` relaxations, which remain real behavioral differences from the
Postgres path (see their notes above), not open questions blocking use.
