# Count rows per value in one column

> **Status:** OPEN · **Area:** spec, ports, conformance, frontend, docs, e2e

A column action that shows how many rows hold each value, over the rows
that match the current filter, most common value first. It runs only
when the user asks.

## 1. The ask

"How many orders per `status`?" and "which customers have the most
failed payments?" are everyday questions while checking a feature.
Today there is no way to answer them:

- `GET /tables/common-values` (§5.5) gives planner statistics, not
  counts. It ignores the filter, it can be stale, and MySQL/MariaDB and
  SQLite always return an empty list (`docs/adapter-decisions.md` §5.5).
- Story 40 left `GROUP BY` out of joins on purpose, and §6 allows only
  single-table data queries.

DBeaver's Grouping panel answers this with a real `GROUP BY` query, run
when the user opens the panel. This story does the same for one column.

## 2. Cost

Measured 2026-11-21 on the devcontainer's Postgres 18, using a
10,000,000-row (1.8 GB) temp table with a warm cache and 2 parallel
workers:

| Query | Time |
|---|---|
| `GROUP BY` with 5 groups, no filter | 0.94 s |
| `GROUP BY` with 100,000 groups, no filter | 1.04 s |

A `GROUP BY` must read every matching row, so a `LIMIT` on the groups
does not shorten it. It still costs about the same as a page query that
sorts by an unindexed column (0.64 s on the same table). The existing
query timeout (§6) bounds it. At these speeds, a 5 s timeout triggers at
roughly 50 million rows, and sooner on a cold cache.

Grouping only the first N matching rows was considered. It is not needed
when the query runs only on request, and its counts lean toward whatever
rows the engine reads first.

The SQLite `GROUP BY` removed from §5.5 does not argue against this
story. That query ran automatically to fill in suggestions. This one runs
on an explicit request.

## 3. Wire shape

`GET {mount}/api/tables/value-counts`

| Param    | Required | Rules |
|----------|----------|-------|
| `source` | no       | As §5.4. |
| `schema` | no       | As §5.4. |
| `table`  | yes      | As §5.4. |
| `column` | yes      | Validated against the table's real columns, as §5.5. |
| `filter` | no       | As §5.4: the same JSON AST, the same validation and the same errors. |

```json
{
  "values": [
    { "value": "paid", "count": 2000000 },
    { "value": "failed", "count": 1999950 },
    { "value": null, "count": 50 }
  ],
  "group_count": 3,
  "matching_rows": 4000000
}
```

- `SELECT col, count(*) … WHERE <the §5.4 filter> GROUP BY col`, one
  bounded transaction, schema resolved first (`CLAUDE.md`). Each port
  reuses its existing filter builder.
- At most **50** entries, largest `count` first. Ties are broken the same
  way on every request (proposed: by the value's text rendering).
- `group_count` is the number of distinct values, and `matching_rows`
  the sum of all counts. Both come from the same aggregate (a window over
  the grouped rows), so they cost almost nothing extra. Together they
  let the UI say "top 50 of 100,000 values" and show each share as a
  percentage.
- `value` uses the §5.4.3 rendering, so a click turns it into an `=`
  filter that matches the same rows. `null` is its own group, and a
  click on it gives `IS NULL`.
- A column whose type has no equality operator (Postgres `json`, `xml`,
  and the geometric types) → 400 `ungroupable_column`. Postgres raises
  SQLSTATE 42883 here, the same code already mapped to
  `unsortable_column` (`map_select_denied` in
  `implementations/rust/core/src/db/postgres.rs`). MySQL/MariaDB and
  SQLite group every type.
- A timeout is a 500 with `code: "query_timeout"`.

## 4. Behaviour

- Opened from a column, in a table view. Where it opens is a design
  question (§8): the header popover was parked in design canvas Round 14
  (board AT).
- A popover lists each value, its count and its share, with a bar. The
  footer says `top 50 of 100,000 values` when `group_count` is over 50
  (R8: the filter is the way to narrow the list).
- Clicking a value adds it to the filter as `column = value` (or
  `column IS NULL`). Whether it replaces or extends the current filter
  follows story 01's decision.
- Loading, empty and error states show in the popover (R9). On
  `query_timeout`: `too slow to count here`. On `ungroupable_column`:
  `this column's type can't be grouped`.
- The popover closes, and a late response is dropped, on any view
  switch (R14).

## 5. Rules this must keep

- **R1:** reading only. No wording that suggests a report job.
- **R7:** at most 50 rows of output, all from the server.
- **R8:** "top 50 of N" is a capped list, and the filter is its escape
  hatch.
- **R9, R14:** as §4.
- **§6 single-table rule:** one table, one aggregate. This story does not
  open the door to general `GROUP BY` or joins with aggregates.

## 6. Touchpoints

- `spec/protocol.md`: a new section after story 61's §5.12.
  `spec/openapi.yaml`.
- Every port: a `value_counts` method on its database seam and a route.
  Rust: `implementations/rust/core/src/db/` (all three engines, plus
  `Source`), with route wiring in `axum/` and `actix-web/`.
- `conformance/runner/`: a new `value_counts.rs`, plus `COVERAGE.md`.
- `frontend/src/`: a feature module for the popover, `core/api.ts`,
  `features/api-reference.ts`, `features/filter-ui.ts` (adding the
  clicked value to the filter).
- The demo backends, as story 61.
- Design canvas: a new round for where the action lives and how the
  popover looks (list, long values, null, many groups, timeout,
  ungroupable).

## 7. What "done" means

- Conformance on every port and engine: counts per value match the seed
  for a column with known values, with and without a filter; `null` is
  its own group; more than 50 values gives 50 entries and the right
  `group_count`; every returned `value`, used as an `=` filter on §5.4,
  returns exactly `count` rows; a Postgres `json` column is a 400
  `ungroupable_column`; an unknown column is a 400.
- An e2e spec: open the popover, click a value and see the filter
  applied, see the "top 50 of N" footer, and see the timeout message
  (mocked response).
- The full three-browser e2e suite passes.

## 8. Open questions

- **Where the action lives.** A column-header menu (parked as AT), the
  columns menu, or the record view next to each value's `=` button?
  This needs a design-canvas round before any build.
- **Long values.** Fifty large `text` values can make a large response.
  Truncate each value in the response (which breaks the click-to-filter
  round trip for those), or truncate only in the display and keep the
  full value for the filter?
- **Join views.** Story 61 counts in join views. Counts per value on a
  joined column would follow the same pattern; decide once this story's
  table version has shipped.
- **Replacing §5.5.** Not proposed. Common values stay cheap and
  automatic for filter suggestions. This route stays explicit.

## 9. Out of scope

- Other aggregates (sum, average, min, max). Story 28 §B keeps
  client-side aggregates on a selection as a separate item.
- Grouping by more than one column.
- Charts.
