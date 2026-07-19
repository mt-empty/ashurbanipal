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
