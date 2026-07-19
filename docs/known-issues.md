# Known issues

Status: both entries below are fixed. Kept as a record of two non-obvious
bugs found while building the Playwright E2E suite — the root-cause
analysis explains code shapes (`order by` table-qualification, the
`loadData()` token guard) that would otherwise look like unexplained
defensive cruft.

---

## 1. Sorting was numerically/chronologically wrong for every non-text column — Fixed

**Found:** 2026-07-19, while writing the Playwright E2E suite's
`sorting.spec.ts` — a test asserting ascending price order on `products`
failed against the real running app, not against test setup.

**Root cause:** `src/db.rs`'s `query_table` builds the select list as
`"{col}"::text` for every column (uniform decoding across
uuid/jsonb/timestamptz/etc., per the comment above `select_list`), but the
`order by` clause referenced the bare column name: `order by "{col}"
{asc|desc}`, unqualified by table. Postgres's `ORDER BY` name resolution
prefers a matching **output column** over a same-named **input** column —
so `order by "price"` bound to the text-cast *output* column, not the
underlying numeric one, and Postgres sorted the text representation
lexicographically instead of the real value.

Confirmed directly against the live seeded db:

```sql
-- correct (native column, no cast in the select list)
select price from products order by price asc limit 5;
--  6.51 / 11.18 / 19.67 / 39.15 / 57.22

-- reproduces the bug (cast+unaliased, same shape as db.rs's actual query)
select price::text from products order by price asc limit 5;
--  107.92 / 11.18 / 113.41 / 121.06 / 126.31

-- fixed by table-qualifying ORDER BY
select price::text from products order by products.price asc limit 5;
--  6.51 / 11.18 / 19.67 / 39.15 / 57.22
```

**Impact:** was live in `mise run demo`, not test-specific. Every sort on
a non-text column (numeric, bigint, real, date, timestamptz — anything
where lexicographic order differs from the real order) returned rows in
the wrong order. Text columns (e.g. sorting `name`) were unaffected, since
lexicographic and "real" order coincide there — which is also why the one
existing black-box sort test (`sort_and_order_are_respected`, sorting
`users.email`) never caught this: it happened to test the one case
structurally invariant under the bug.

**Fix:** table-qualified the `order by` clause in `query_table`:

```rust
let order_clause = match &sort {
    Some(col) => format!(
        " order by \"{}\".\"{}\" {}",
        table, col,
        if opts.descending { "desc" } else { "asc" }
    ),
    None => String::new(),
};
```

`table` is already validated against the live schema allow-list earlier in
the same function, so this doesn't introduce a new injection surface — same
trust boundary as the previous unqualified version.

**Test coverage:** `tests/black_box/table_data.rs`'s
`sort_on_a_numeric_column_is_numeric_not_lexicographic` (sorts `products`
by `price`, asserts real numeric order) is the backend-level regression
test — a non-text column specifically, so it can't be blind to this class
of bug the way the `email` test was. `tools/e2e-tests/tests/sorting.spec.ts`'s
"ascending sort actually reorders rows by value" is the matching E2E
regression test (no longer pinned via `test.fail()`).

---

## 2. No stale-response guard in loadData() — two observable symptoms — Fixed

**Found:** 2026-07-19, while writing the Playwright E2E suite. A helper
that waits for `document.getAnimations()` to empty out (to let
`document.startViewTransition`'s re-render settle before the next action)
sometimes never resolved — traced to one specific `.row-spinner` element
animating indefinitely, confirmed by sampling `getAnimations()` every
200ms across several seconds with nothing ever clearing it.

**Root cause:** `state.table` is a single shared, mutable field, and both
`loadData()` and `fetchTableData()`'s `finally` block used to read it *at
completion time*, not whatever it was when that particular call started.
There was no per-request token guarding against this anywhere in the load
path (contrast `showCommonValues`'s `cvRequestToken`, which exists
specifically to solve the equivalent problem for *that* feature). If a
second `loadData()` call started before an earlier one for a different
table had resolved, whichever response landed *last* won, regardless of
which was requested last. Two distinct symptoms fell out of this one gap:

- **Stuck spinner.** `fetchTableData`'s `finally` cleared the loading flag
  on *whatever table `state.table` named when it ran*, not the table it
  was fetching for. The earlier (now-losing) request cleared the *new*
  table's flag (a no-op, or clearing one that was never set) and left its
  *own* table's row permanently marked `.loading` — spinning forever,
  since nothing else would ever clear it.
- **Wrong data under the right label.** `loadData()` calls
  `updateActiveTableChrome()` (which sets `#current`'s text) *before*
  `renderHeader`/`renderRows` — but both were keyed off whatever `data`
  and `state.table` were at the time *this* call resolved, not which
  table's fetch actually finished most recently in wall-clock time. If an
  older, slower request for table A resolved *after* a newer request for
  table B had already rendered and updated `#current` to "B," table A's
  `finally` still ran, and its own `renderHeader(data.columns)`/
  `renderRows(data)` overwrote the grid with **A's columns and rows** —
  while `#current` still correctly read "B." The chrome and the grid
  silently disagreed.

**Reliably reproduced:** navigate fresh (the default table loads
automatically, e.g. `audit_log`, alphabetically first) and immediately
click a different table before that initial load resolves. Whichever
request lost the race left its symptom behind — confirmed both ways
empirically while building the E2E suite (a permanently-spinning sidebar
row in one case, and `orders` shown as `#current` while the grid still
held `audit_log`'s columns/rows — no `status` column at all — in another).

**Impact:** was more than cosmetic. The stuck spinner was purely visual,
but the second symptom was a real correctness gap: the page could display
one table's data while its own chrome (`#current`, active sidebar
highlighting, `document.title`) claimed a different table was showing,
with nothing to indicate the mismatch.

**Fix:** `loadData()` now takes a monotonic `loadDataToken`, captured at
the start of each call; both the catch branch and the point where fetched
`data` is about to be rendered check `token !== loadDataToken` and bail
out silently if a newer call has since superseded them — same shape as
`showCommonValues`'s guard. Separately, `fetchTableData()` now captures
`state.table` into a local `table` const once at the start and uses that
(not a re-read of `state.table`) for `setRowLoading`, so each call always
clears its own row regardless of what `state.table` becomes afterward.
`aria-busy`/`#status` are now reference-counted (`inFlightFetches`) rather
than a plain boolean, since overlapping fetches are now an expected,
correctly-handled case rather than something to prevent — a single
in-flight fetch finishing early would otherwise have cleared "busy" while
another was still genuinely running.

Checked the other three frontend API call sites for the same gap:
`showCommonValues` (`/tables/common-values`) already had `cvRequestToken`;
`loadTables` (`/tables` + `/table-counts`) has exactly one call site (never
re-entered) so it was never at risk; `loadSiblings` (`/siblings`, polled
every 15s) had the identical structural gap, lower-odds given the health
check's own 3s per-sibling timeout (`routes.rs`) but fixed the same way
(`siblingsRequestToken`) for consistency.

**Test coverage:** `tools/e2e-tests/tests/loading-and-errors.spec.ts`'s
"a slow, superseded response never overwrites a newer table's render"
deterministically forces the exact race (delays responses for one table
via `page.route()`) and asserts the stale one is discarded. `gotoApp`
(`tools/e2e-tests/tests/support/helpers.ts`) also waits for the page's own
initial default-table load to settle before returning, which was needed
to make every other test in the suite reliable once this race was
understood — without it, a test's first `selectTable()` call could
occasionally lose to the page's own auto-loaded default table.
