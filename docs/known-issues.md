# Known issues

Status: draft — confirmed bugs found during development, not yet fixed.
Not a design-question backlog like `dbviewer-feedback-backlog.md`; entries
here have a known root cause and a known fix, just not applied yet.

---

## 1. Sorting is numerically/chronologically wrong for every non-text column

**Found:** 2026-07-19, while writing the Playwright E2E suite's
`sorting.spec.ts` — a test asserting ascending price order on `products`
failed against the real running app, not against test setup.

**Root cause:** `src/db.rs`'s `query_table` builds the select list as
`"{col}"::text` for every column (uniform decoding across
uuid/jsonb/timestamptz/etc., per the comment above `select_list`), but the
`order by` clause references the bare column name: `order by "{col}" {asc|desc}`,
unqualified by table. Postgres's `ORDER BY` name resolution prefers a
matching **output column** over a same-named **input** column — so
`order by "price"` binds to the text-cast *output* column, not the
underlying numeric one, and Postgres sorts the text representation
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

**Impact:** live in `mise run demo` today, not test-specific. Every sort on
a non-text column (numeric, bigint, real, date, timestamptz — anything
where lexicographic order differs from the real order) returns rows in the
wrong order. Text columns (e.g. sorting `name`) are unaffected, since
lexicographic and "real" order coincide there.

**Fix (not yet applied):** table-qualify the `order by` clause in
`query_table`:

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
trust boundary as the existing unqualified version.

**Test coverage:** `tools/e2e-tests/tests/sorting.spec.ts`'s "ascending
sort actually reorders rows by value" test currently asserts against
*correct* behavior and will fail until this is fixed — left that way
deliberately (a red test pinned to the right behavior) rather than
adjusting the assertion to match the bug. A backend-level regression test
(`tests/black_box/table_data.rs`, sorting a numeric column and asserting
real numeric order) should be added alongside the fix.

---

## 2. No stale-response guard in loadData() — two observable symptoms

**Found:** 2026-07-19, while writing the Playwright E2E suite. A helper
that waits for `document.getAnimations()` to empty out (to let
`document.startViewTransition`'s re-render settle before the next action)
sometimes never resolved — traced to one specific `.row-spinner` element
animating indefinitely, confirmed by sampling `getAnimations()` every
200ms across several seconds with nothing ever clearing it.

**Root cause:** `src/frontend/dbviewer.html`'s `fetchTableData()`:

```js
async function fetchTableData() {
  ...
  setRowLoading(state.table, true);
  try {
    return await api("/tables/data?" + params);
  } finally {
    setStatus("");
    setRowLoading(state.table, false);   // <- reads state.table NOW, not
    document.querySelector("table").removeAttribute("aria-busy");
                                          //    whichever table this fetch
                                          //    was actually for
  }
}
```

`state.table` is a single shared, mutable field, and both `loadData()` and
`fetchTableData()`'s `finally` block read it *at completion time*, not
whatever it was when that particular call started. There's no per-request
token guarding against this anywhere in the load path (contrast
`showCommonValues`'s `cvRequestToken`, which exists specifically to solve
the equivalent problem for *that* feature — `loadData`/`fetchTableData`
have no equivalent). If a second `loadData()` call starts before an
earlier one for a different table has resolved, whichever response lands
*last* wins, regardless of which was requested last. Two distinct
symptoms fall out of this one gap:

- **Stuck spinner.** `fetchTableData`'s `finally` clears the loading flag
  on *whatever table `state.table` names when it runs*, not the table it
  was fetching for. The earlier (now-losing) request clears the *new*
  table's flag (a no-op, or clearing one that was never set) and leaves
  its *own* table's row permanently marked `.loading` — spinning forever,
  since nothing else will ever clear it.
- **Wrong data under the right label.** `loadData()` calls
  `updateActiveTableChrome()` (which sets `#current`'s text) *before*
  `renderHeader`/`renderRows` — but both are keyed off whatever `data` and
  `state.table` are at the time *this* call resolves, not which table's
  fetch actually finished most recently in wall-clock time. If an older,
  slower request for table A resolves *after* a newer request for table B
  has already rendered and updated `#current` to "B," table A's `finally`
  still runs, and its own `renderHeader(data.columns)`/`renderRows(data)`
  overwrite the grid with **A's columns and rows** — while `#current`
  still correctly reads "B" (nothing in A's callback touches it, since
  `state.table` is already "B" by then and A's callback doesn't re-check
  which table its own `data` belongs to). The chrome and the grid
  silently disagree.

**Reliably reproduced:** navigate fresh (the default table loads
automatically, e.g. `audit_log`, alphabetically first) and immediately
click a different table before that initial load resolves. Whichever
request loses the race leaves its symptom behind — confirmed both ways
empirically while building the E2E suite (a permanently-spinning sidebar
row in one case, and `orders` shown as `#current` while the grid still
held `audit_log`'s columns/rows — no `status` column at all — in another).

**Impact:** more than cosmetic. The stuck spinner is purely visual, but
the second symptom is a real correctness gap: the page can display one
table's data while its own chrome (`#current`, active sidebar
highlighting, `document.title`) claims a different table is showing, with
nothing to indicate the mismatch.

**Fix (not yet applied):** give `loadData()`/`fetchTableData()` the same
shape of guard `showCommonValues` already has — capture the table name (or
a request token) at the *start* of the call, and have every later step
(the `finally`'s `setRowLoading`, and the point where the fetched `data`
is about to be rendered) check that it's still the *current* request
before acting; a stale response should be discarded outright, not
partially applied.

**Test coverage:** `tools/e2e-tests/tests/support/helpers.ts`'s `gotoApp`
now waits for the page's own initial default-table load to fully settle
before returning, specifically to close the second symptom's race for
every test — without it, a test's first `selectTable()` call could win
the *label* while losing the *data* to the app's own auto-loaded default
table. `waitForIdle` separately filters `.row-spinner`-targeted animations
out of its settle check, to avoid hanging on an unrelated stuck spinner
from the first symptom. No dedicated regression test added yet (both are
timing-dependent to trigger); worth adding once fixed, gated the same way
as issue #1 above.
