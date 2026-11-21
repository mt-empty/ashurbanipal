# Count the rows that match the filter

> **Status:** OPEN · **Area:** spec, ports, conformance, frontend, docs, e2e

A button that counts, exactly, how many rows match the current filter,
in a table view and in a join view. It runs only when the user clicks
it.

## 1. The ask

"How many orders are stuck in `failed`?" is one of the most common
questions a developer brings to a table. Today the grid cannot answer it:

- `total_approx` is a whole-table estimate and MUST ignore the filter
  (`spec/protocol.md` §5.4.4).
- MySQL/MariaDB and SQLite often have no estimate at all, so the grid
  shows no row count there (`noCountsFor` in
  `frontend/src/features/grid.ts`).
- A join view has no count at all, only `has_more` (§5.11.4), so the
  pager says `50+ rows` and nothing more.
- The only workaround is paging to the end.

DBeaver solves the same problem with a "Calculate total row count" button
in the result toolbar: it fetches one page by default and counts only on
request. This story copies that model.

## 2. Cost

Measured 2026-11-21 on the devcontainer's Postgres 18, using a
10,000,000-row (1.8 GB) temp table with a warm cache and 2 parallel
workers:

| Query | Time |
|---|---|
| `count(*)`, no filter | 0.46 s |
| `count(*)`, rare filter on an unindexed column | about 0.6 s |
| The grid's own page query with that same filter | 0.99 s |

A count costs about the same as a page query the grid already runs for a
rare filter or an unindexed sort: both scan the table. The existing query
timeout (`spec/protocol.md` §6, reference default 5 s) bounds it like
every other query. A cold cache or network storage will be several times
slower, so the timeout will trigger on large tables. That is acceptable
as long as the UI explains it (§4).

A join count was not measured. It can cost more than a table count: an
unindexed join key, or a `LEFT` join that multiplies rows, makes the
engine join every row before it can count. The same timeout bounds it,
and §5.11 already caps a join at 4 tables.

A cap (`LIMIT 10001` inside the count) was considered. It is not needed
when the count runs only on a click, and an exact number is more useful.

## 3. Wire shape

A new route, not a field on §5.4. A field would compute the count with
every page, and the grid would wait for it. Story 14 used the same
reasoning.

`GET {mount}/api/tables/count`

| Param    | Required | Rules |
|----------|----------|-------|
| `source` | no       | As §5.4. |
| `schema` | no       | As §5.4. |
| `table`  | yes      | As §5.4. |
| `filter` | no       | As §5.4: the same JSON AST, the same validation and the same errors. |

```json
{ "count": 1234 }
```

- `count` is exact: `SELECT count(*)` with the same `WHERE` clause §5.4
  would build for this filter. Each port reuses its existing filter
  builder (for example `tableWhereClause` in
  `implementations/go-nethttp/join.go`), so the count and the grid always
  agree on which rows match.
- One bounded transaction, with the schema resolved as the first
  statement, the same as §5.4 (`CLAUDE.md` multi-schema invariant).
- A timeout is a 500 with `code: "query_timeout"`, the same as today.
- `count` is a JSON number. A row count is not a cell value, so the
  "every cell value is a string" rule does not apply.

`GET {mount}/api/tables/join/count`

| Param    | Required | Rules |
|----------|----------|-------|
| `source` | no       | As §5.11. |
| `schema` | no       | As §5.11. |
| `join`   | yes      | As §5.11: the same JSON object, the same validation and the same errors. `columns` is validated but does not change the count. |
| `filter` | no       | As §5.11, including each condition's `join` position. |

The response is the same `{ "count": 1234 }`.

- `count` is the number of rows §5.11 would return across all pages for
  the same `join` and `filter`: `SELECT count(*)` over the same `FROM`,
  joins and `WHERE` clause. Each port reuses its existing join builder.
  A `LEFT` join that matches several rows counts each of them, exactly
  as paging would show them.
- The same execution rules as §5.11.5: one connection and transaction,
  every table's `schema` checked inside it, generated aliases only.
- §5.11.4's "`total_approx` is never present" stays true: the join route
  still carries no count. This route is the explicit way to get one, and
  §5.11.4 should point to it.

## 4. Behaviour

- A `count` button next to the row meta in the pager, in both a table
  view and a join view. It shows with and without a filter. In a table
  view without a filter, it replaces a stale or missing estimate with
  the real number. In a join view, it replaces `50+ rows`.
- Click: the button shows a loading state (R9), then the meta reads
  `· 1,234 rows match` (or `· 1,234 rows` with no filter). A table view
  calls `/tables/count`, a join view `/tables/join/count`.
- Changing the filter, table, join, schema or source clears the result
  back to the button. In a join view, that includes editing the join or
  switching to another saved join. Paging, sorting and showing or hiding
  columns keep it, because they do not change which rows match.
- With a known count, a join view's pager can say `page 2 of 25`, and
  the `next` button no longer depends on `has_more` alone.
- Auto-refresh (story 38) does not count again on its own. A count that
  may be stale after a refresh is marked as such, for example with a
  muted "counted 2 min ago" title. See §7.
- On `query_timeout`: `too slow to count here`, with the full reason in
  the title ("the database stopped the count at its time limit"). The
  client does not know the server's timeout value, so the message must
  not name a number.
- Other errors use the pager's existing error display.

## 5. Rules this must keep

- **R1:** the button only reads. Its label must not suggest a job or an
  export.
- **R7:** the count is a number, not rows. Nothing extra is rendered.
- **R9:** loading, success and failure each show in place.
- **R14:** a result from an earlier table or filter must never show
  after a view switch. Drop late responses whose view no longer matches.
- **Kill switch, allow-list, read-only, timeout:** unchanged from §6.

## 6. Touchpoints

- `spec/protocol.md`: a new §5.12 for both routes, and a pointer from
  §5.11.4. `spec/openapi.yaml`.
- Every port: `count` and `count_join` methods on its database seam and
  two routes. Rust: `implementations/rust/core/src/db/` (all three
  engines, plus `Source` in `db/source.rs`) and the join builder in
  `core/src/join.rs`, with route wiring in `axum/` and `actix-web/`.
- `conformance/runner/`: a new `count.rs` for both routes, plus
  `COVERAGE.md`.
- `frontend/src/features/grid.ts` (`updatePager`, both branches),
  `features/join-view.ts`, `core/api.ts`, `features/api-reference.ts`.
- The demo backends: `frontend/src/demo/synthetic/serve.ts` needs the
  route. The live demo picks it up from `implementations/node-express/src/`.
- Design canvas: no board covers the pager meta. Add a small round
  (button, loading, result, stale, timeout) before building.

## 7. What "done" means

- Conformance on every port and engine: count with no filter equals the
  seed's row count; count with a filter equals the number of rows §5.4
  returns across all pages for that filter; a bad filter gets the same
  400 as §5.4; an unknown table is a 400; a disabled router is a 404.
- Conformance for the join route on every port and engine: the count
  equals the number of rows §5.11 returns across all pages for the same
  `join` and `filter`, including a `LEFT` join with several matches per
  row, a filter on a joined table, and a cross-schema join; a bad `join`
  gets the same 400 as §5.11.
- A port-local test that a slow count returns `query_timeout`.
- An e2e spec, run in a table view and a join view: count, change the
  filter and see the result clear, page and see it stay, edit the join
  and see it clear, and see the timeout message (mocked response).
- The full three-browser e2e suite passes.

## 8. Open questions

- **Auto-refresh.** Should a refresh count again when a count is
  showing? Counting again doubles the load per tick. Marking the number
  as stale is cheaper. Leaning: mark it stale.
- **One route or two.** This story proposes `/tables/count` and
  `/tables/join/count`, following the existing `/tables/data` and
  `/tables/join` split. One route that takes either `table` or `join`
  would save a route but mix two sets of validation rules.
- **A longer timeout for counts.** Hosts with large staging tables may
  want one. Wait until someone asks.

## 9. Out of scope

- Counts per value: story 62.
- Counting automatically on every filter change.
- Counts on referenced-by entries (story 36 covers a cheaper yes/no flag).
