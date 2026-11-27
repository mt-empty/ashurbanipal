# Cursor paging for tables with a tie-break key

> **Status:** OPEN · **Area:** spec, ports, conformance, frontend

Page a table by "the rows after this row" instead of "skip n rows", for
every table that has a tie-break key. Tables without one keep offset
paging. This is the fix for
[[33-spec-hardening-review-findings]] B2.

## 1. The ask

Offset paging has two problems:

- **Deep pages are slow.** `OFFSET n` reads and discards n rows on
  Postgres and MySQL, so a deep page can hit the query timeout
  (`spec/protocol.md` §6).
- **Pages shift while data changes.** A row inserted or deleted before
  the current page moves every later row by one, so the next page repeats
  or skips a row.

A cursor holds the last row's sort value and tie-break key. The next page
asks for rows after that point, so it uses the index and does not shift.

## 2. Why it fits the UI

The pager already offers only Previous and Next, a "page N" label and an
estimated total (`updatePager` in `frontend/src/features/grid.ts`). There
is no page jump, so cursors change nothing the user sees. "Page N" comes
to mean "the Nth page you stepped through", which stays true while the
data changes.

## 3. Scope

- **Wire:** an optional `after=<opaque cursor>` on `GET /tables/data`,
  and a `next_cursor` in the response when the table has a tie-break key.
  A new optional parameter keeps v1 (§7). `offset` stays for tables with
  no tie-break key and for old clients.
- **Previous page:** the frontend keeps a stack of the cursors it came
  through. No reverse cursor on the wire.
- **Shared links:** the URL carries the cursor in place of `offset`, so a
  link opens "after this row", not "rows 101–150 as they are now".
- **Not in scope:** joins (§5.11). They can follow once tables work.

## 4. Open questions

- **NULLs in the sort column.** A row-value comparison such as
  `(status, id) > (?, ?)` is never true when `status` is NULL, and each
  engine places NULLs differently (§5.4). The predicate must be built per
  engine, with the NULL case written out.
- **Descending sort** flips every comparison in the predicate.
- **Stale cursors.** A cursor whose table, sort or filter no longer
  matches the request is a 400, never a silent restart from page 1.
- **[[05-multi-column-sort]]**: if it lands, the cursor must carry every
  sort column's value.
