# Server-side table joins

> **Status:** DONE · **Area:** spec, ports, conformance, docs · **Ref:** implemented 2026-10-15 in spec §5.11 and all five ports; the conformance cases pass on all five ports against Postgres, plus Rust and Flask on MySQL and SQLite and Node on MySQL; every other port and engine pair is covered by the port tests

Read-only. The server builds a `SELECT` with joins from a structured
description. No client text becomes SQL. The UI for building joins is
story 41.

## 1. The ask

A user can join tables on any column pair and browse the result as one
grid: filter, sort and page it on the server, in one call. A saved join is
a definition kept by the client, not a database object.

## 2. Decisions so far

- **Structured request, not SQL.** The client sends a join description;
  the server validates every name against the catalog and builds the SQL.
  A raw SQL box is out: it would break `spec/protocol.md:644-648`, and
  "SELECT only" (`:649-650`) cannot be enforced on arbitrary text.
- **Any column pair** may be joined, not only foreign keys.
- **INNER and LEFT only.** RIGHT is a reversed LEFT. FULL is missing on
  MySQL and old SQLite.
- **Stateless server.** Saved and shared joins live in the client
  (`spec/protocol.md:676-677`).
- **Defaults accepted** — §5 lists them.

## 3. Spec impact

- `spec/protocol.md:655-657` says a data response comes from exactly one
  table. Amend it: the new route (§4) is the one exception, and combines
  rows only from tables the request names. FK navigation stays two
  queries.
- A wholly new route is still protocol v1 (`:684-696`). Extensions go through
  spec revisions (`:101`), so confirm this is acceptable under spec
  governance before building.
- New section `GET {mount}/api/tables/join` in `spec/protocol.md`, and the
  matching entry in `spec/openapi.yaml`.
- `docs/adapter-decisions.md` — join type-compatibility classes per
  engine (§5.1) and any accepted gaps.
- `PORTING.md` — add the route to the checklist.

## 4. The route

`GET {mount}/api/tables/join`

| Param | Required | Rules |
|---|---|---|
| `source`, `schema` | no | As in §5.4. One source and one schema for every table in the join. |
| `join` | yes | URL-encoded JSON object, below. |
| `filter` | no | The §5.4.2 array, plus an optional `join` index per condition (default `0`, the base table). Same op set, same limit of 10 conditions. |
| `sort`, `sort_join`, `order` | no | `sort` is a column name, `sort_join` its table position (default `0`). Unknown column or position → 400. |
| `limit`, `offset` | no | Clamped exactly as §5.4. |

`join` decoded:

```json
{
  "table": "orders",
  "joins": [
    {"type": "left", "table": "users",
     "on": [{"left": {"join": 0, "column": "user_id"}, "right": "id"}]},
    {"type": "left", "table": "order_extra",
     "on": [{"left": {"join": 0, "column": "id"}, "right": "order_id"}]}
  ],
  "columns": [{"join": 0, "column": "id"}, {"join": 1, "column": "full_name"}]
}
```

- **Positions.** `0` is the base table; `1..n` are the entries of `joins`
  in order. A table may appear more than once (self-join), because every
  reference is by position, never by table name.
- **`on`.** Each pair is `left` (a column of an earlier position) `=`
  `right` (a column of this entry's table). Equality only. A pair may
  not reference its own or a later position → 400.
- **`columns`.** Optional. Absent means every column of every table.
- **Response.** `columns[]` entries carry `name` (a unique label chosen by
  the server), `join`, `table`, `column`, `type`, plus the §5.4.1
  optional fields (`key`, `references`, `comment`). Clients never parse
  the label. `rows` are keyed by label. `has_more` is always present;
  `total_approx` is omitted (a join has no cheap count; contrast §5.3 `:163-188` and §5.4.4
  `:357-365`).

## 5. Rules

### 5.1 Defaults agreed in discussion

1. **Type compatibility.** Each `on` pair is checked against the catalog
   types. Allowed classes: integer/decimal (mutually compatible), text,
   uuid, boolean, date/time, binary, and the same enum type. Anything
   else, or a pair from different classes, → 400 naming the pair.
   `json`, `jsonb` and array columns are never joinable. The per-engine
   class table belongs in `docs/adapter-decisions.md`.
2. **Equality only** in `on`.
3. **Up to 3 pairs** per `on`, combined with AND.
4. **Slow joins.** The 5 s timeout stays (`:651-654`), a 500. The body
   carries `code: "query_timeout"` (`:87`), so the UI can say "join took too
   long". Only Postgres emits it today. All five ports map the MySQL,
   MariaDB and SQLite timeout to it on every route, and the accepted gap in
   `docs/adapter-decisions.md` §6 is closed.
5. **Self-joins** allowed (positions, above).
6. **One source and schema.** No cross-schema joins in this story.
7. **No total count.** See `has_more` below.
8. **Error codes.** Reuse existing codes. Unknown names keep
   `unknown_table` and `unknown_column`, filter problems keep
   `invalid_filter`, and join-shape and type errors use
   `invalid_parameter`. The `title` names the part, e.g. `join 1 on:
   users.id (uuid) cannot be joined to orders.status (enum)`.

### 5.2 Bounds

- At most **4 tables** in total (base plus 3 joins) → otherwise 400.
- `max_page_size` and `default_page_size` apply unchanged. No separate
  join setting.
- `offset` stays unbounded; the timeout is the guard, as for §5.4.
- The `join` and `filter` parameters each have a byte bound like
  `:292-298`; oversize → 400, never truncated.

### 5.3 `has_more`

The client cannot ask for `max_page_size + 1` rows. The server fetches
`limit + 1`, returns at most `limit`, and sets `has_more` to whether the
extra row existed.

### 5.4 Safety (each is a MUST, and a conformance case)

- Every table and column — in `join`, `columns`, `on`, `filter`, `sort` —
  is matched exactly against the live catalog before reaching SQL
  (`:644-648`). Postgres tables also pass `has_table_privilege`, as in
  §5.2; a residual `permission denied` maps to the same rejection as
  MySQL's.
- SQL aliases are generated (`t0`, `t1`, `c0`, …) and mapped to labels in
  application code. No request text becomes an alias or label.
- Join type maps through a fixed table (`inner`, `left`). The `on`
  operator is always `=`. Values are bound parameters.
- The whole operation stays on one connection and one transaction, with
  the schema resolved first (`docs/design.md` §5).
- Filter conditions compare the column cast to text, as in `~:320-324`.

## 6. Touchpoints

- **Every port, every engine** — build the join SQL for Postgres, SQLite
  and MySQL. Rust: the SQL lives in `core/` and both adapters reuse it.
  No port is first or canonical; the story is PARTIAL until all five pass
  conformance.
- `spec/protocol.md`, `spec/openapi.yaml`, `docs/adapter-decisions.md`,
  `PORTING.md` — §3.
- `conformance/` — new cases (§7). The seed needs a table pair with
  unmatched rows and a self-reference; regenerate with
  `mise run conformance:seed-gen`.
- Frontend: story 41. The existing `/api/tables/structure` and
  `columns[]` metadata already let the UI suggest `on` columns.

## 7. What "done" means

Conformance cases, run on all five ports and all three engines:

- LEFT keeps unmatched base rows with nulls; INNER drops them.
- Three-table join returns the expected labels, `join`/`table`/`column`
  fields and values.
- Self-join (`orders` to `orders` on a non-FK pair) returns both sides
  without a label clash.
- Filter and sort on a joined table's column, in both `sort_join`
  positions.
- `has_more` is true on a page with a following row and false on the last
  page; `total_approx` is absent.
- 400 for: unknown table or column, forward or self position in `on`,
  incompatible types (`uuid` to `text`), `json`/array column in `on`,
  5 tables, 4 pairs, `=`-less `on`, oversize `join`.
- No identifier injection: a table or column name containing quotes,
  semicolons or `"` is rejected as unknown, never spliced.
- A join that exceeds the timeout returns a 500 with `code:
  "query_timeout"` on all three engines, and the connection is released.
- The two-source and schema-isolation cases still pass for the new route.

`mise run check` is green; `mise run docs` is green.

## 8. Decided while planning

- **Stable paging.** Match the single-table route: no primary-key
  tie-break (`postgres.rs:623-629`, `sqlite.rs:397`). A sort on a
  non-unique column can repeat or skip rows between pages. Record it as an
  accepted gap in `docs/adapter-decisions.md`.
- **MySQL text collations.** Compare `collation_name` of text pairs before
  building the query and answer 400 naming the pair. Error 1267 maps to the
  same 400 as a fallback.
- **SQLite typing.** The class comes from the declared type by affinity
  rules. An empty declared type is its own class and pairs only with
  itself. Note the weaker guarantee in `docs/adapter-decisions.md`.
- **SQLite connection.** The whole operation runs in one `bounded` closure
  on one connection, as §5.4 requires. The existing `query_table` does not.
- **Self-join test data.** Join `orders` to itself on a non-FK pair. No
  seed change.

## Left open after building

- **Long URLs.** A large `join` plus `filter` in a GET may reach proxy URL
  limits. A read-only POST would need a spec decision; not part of this
  story.
- **Timeout label.** The black-box runner cannot provoke a slow query
  (`conformance/runner/COVERAGE.md`), so each port covers `query_timeout`
  in its own tests, on every engine it supports.
- **Node SQLite.** The `sqlite3` native module does not load on this
  devcontainer's glibc, so that path was exercised through a
  `node:sqlite` stand-in; run `pnpm test` where the module loads.

## 9. Out of scope

RIGHT and FULL joins, non-equality `on`, cross-schema or cross-source
joins, raw SQL, server-stored views, aggregates and `GROUP BY`, a total row
count, and the UI (story 41).
