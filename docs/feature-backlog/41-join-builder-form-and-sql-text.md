# Join builder: form and SQL-like text

> **Status:** DONE · **Area:** frontend, spec, docs, e2e · **Ref:** implemented 2026-10-16 in `frontend/src` (`features/join-*`, `lib/join-*`), `spec/join-dsl.md` and the `join-*.spec.ts` Playwright suites

Frontend for story 40's join route. Read-only. The text a user types is
parsed in the browser into the structured `join` object; no SQL text
reaches the server.

Design boards: the "Ashurbanipal UI" canvas, round 5 (boards O–T) and
round 6 (boards U–V). Boards R (foreign key expand) and S (canvas builder)
are parked, §9.

## 1. The ask

From any table, a user opens one overlay, builds a join of up to 4 tables,
and browses the result in the normal grid. They can build it with a form
or by typing a restricted SQL-like text with autocomplete. A join can be
saved in the browser and shared by link.

## 2. Decisions so far

- **Two modes in one overlay: Form and SQL.** Both edit the same
  definition. The form shows the equivalent text, read-only (boards O, V).
- **Restricted grammar, not SQL.** §5.
- **Filter and sort stay with the existing controls.** `WHERE` and
  `ORDER BY` are not part of the text.
- **Qualified filter names** (`alias.column`) in the filter field (§6).
- **Saved joins are text in the browser.** The server stays stateless.
- **Saved joins sit after a divider at the end of the table chips**
  (board Q, option 1). Revisit if the row gets crowded.
- **Self-joins use SQL aliases.**
- **Not in this story:** canvas builder, foreign key expand shortcut (§9).

## 3. Depends on

- **Story 40** — the route `GET {mount}/api/tables/join` and its limits
  (4 tables, 3 pairs per `ON`, INNER and LEFT, equality, `has_more`, no
  total).
- Related: story 20 (shareable filter state), story 38 (auto-refresh).

## 4. Surfaces

- **Entry.** A `⋈ join` button in the meta row, next to refresh
  (`index.html:82`), opens the overlay with the current table as the start.
  A `+ new join` chip after the divider opens it empty.
- **Overlay.** Header: title, `Form | SQL` switch, close. Footer: Name,
  Cancel, Show result.
  - *Form* (board O): start-table dropdown (the table in view by default;
    changing it resets the pairs that used its columns), one row per join with type
    (INNER/LEFT), table, alias, and up to 3 `ON` pairs. Each column picker
    lists every column with its type; columns that cannot join to the other
    side are greyed with the reason (`enum ≠ uuid`, `jsonb: not
    joinable`). A foreign key match is suggested, not required. `+ add
    table` stops at 4 tables. A column checklist per table sets the
    `SELECT` list.
  - *SQL* (boards U, V): a mono text field with token colours, as the
    filter field has. Autocomplete after `JOIN` lists tables and offers a
    foreign key match as a complete `table alias ON … = …` snippet. After
    `ON x.col = alias.` it lists columns with the greyed rule. Columns that
    have an index are tagged (`/api/tables/structure`).
  - *Switching.* Form → SQL always works. SQL → Form works only when the
    text parses; otherwise `Form` is disabled with the line and message
    shown (board V).
- **Result** (board P): the normal grid with a band row above the headers,
  one band per table. Sort arrows work on any column. The meta row shows
  `orders ⟕ users ⟕ order_extra · N rows · M columns`, plus `edit join` and
  `copy link`. The pager has no total: `page 1 · more rows available` when
  `has_more`, `last page` otherwise.
- **Saved joins** (board Q, option 1): chips after the divider. The active
  join is the dark chip. An unsaved join shows a dashed chip with a `Save…`
  link.
- **Errors** (board T): type mismatch and the 4-table limit are stopped in
  the overlay. An empty INNER result offers `Switch to left join`. A 500
  from the 5 s limit shows "This join took longer than 5 seconds and was
  stopped", with Retry and Edit join. Any 400 shows the server's message in
  the overlay.

## 5. Grammar

New normative file `spec/join-dsl.md`, written like `spec/filter-dsl.md`,
with a valid/rejected test table in `spec/fixtures/join-parser-tests.json`.
Confirm a new spec file is acceptable under spec governance.

```
join       = [ SELECT columns ] FROM tableref { joinclause } [ ";" ]
columns    = "*" | colref { "," colref }        (alias.* allowed)
tableref   = ident [ [AS] alias ]
joinclause = [ INNER | LEFT [OUTER] ] JOIN tableref ON pair { AND pair }
pair       = colref "=" colref
colref     = alias "." ident
ident      = bare word | "double quoted" ("" escapes ")
```

- Keywords are case-insensitive. Table, column and alias names are
  case-sensitive, as in `spec/protocol.md:644-648`. A bare `JOIN` means
  INNER.
- A pair has one side from an earlier table and one from the table being
  joined, in either order. The parser rewrites it to the wire's `left` and
  `right`.
- A table that appears twice must have an alias on the second use. An alias
  may not repeat or equal another table's unaliased name.
- At most 4 tables and 3 pairs per `ON`. `SELECT` absent or `*` means all
  columns.
- **Rejected, with a message that names the part and its line:** `RIGHT`,
  `FULL`, `CROSS`, `NATURAL`, `USING`, `WHERE`, `GROUP`, `HAVING`, `ORDER`,
  `LIMIT`, `OFFSET`, `UNION`, `DISTINCT`, subqueries and parentheses,
  function calls, `OR`, any `ON` operator other than `=`, comments, and
  more than one statement. Messages for `WHERE` and `ORDER` point to the
  filter bar and header sort.
- Names are checked against the catalog the page already holds; an
  unknown column suggests the closest name.
- The parser makes no request. Type greying is a hint built from a
  type-class table that mirrors story 40 §5.1. An unknown type is allowed;
  the server is the authority and answers 400.

The definition (tables with aliases, joins, `ON` pairs, columns) is one
object. Text, the form and the wire request are three views of it. The
printer writes one canonical text, so text → definition → text is stable.

## 6. Filter and sort in a join view

- `spec/filter-dsl.md` and its tests gain `alias.column`. In a join view,
  an unqualified name means the first table. The parser resolves aliases
  to the join index that story 40 puts on each condition. Outside a join
  view, qualified names are rejected.
- Suggestions list `alias.column` for every table in the join.
- Sorting a column sends `sort` and `sort_join` (story 40 §4).
- "Filter by this value" on a cell inserts `alias.column = value`.

## 7. State and persistence

- The active join is part of the page state next to table and filter
  (`core/state.ts`, `core/store.ts`, `core/url.ts`), as text, so the URL
  reproduces it. `copy link` copies that URL.
- Saved joins: their own `localStorage` key, outside `UI_KEY`, grouped by
  source and schema (the tables differ per schema). Each entry holds name
  and text.
- Changing source or schema leaves the join view and shows that scope's
  saved joins.

## 8. Defaults taken while writing

Not discussed with the author; confirm in review.

- Structure and SQL-INSERT copy are hidden in a join view; JSON copy keeps
  working with the labels from the response.
- The column-visibility control works on the response labels.
- Refresh and auto-refresh (story 38) re-run the same join request.
- Foreign key links in a join view behave as today: they open the
  referenced table, outside the join view.
- Rename and delete of a saved join are needed but not drawn.

## 9. Out of scope

Canvas builder (board S) and foreign key expand shortcut (board R) — parked
follow-ups. `RIGHT`/`FULL` joins, non-equality `ON`, `WHERE` and `ORDER BY`
in the text, cross-schema joins, raw SQL, server-stored views, and a total
row count.

## 10. Check before building

- **Ports without the route.** The frontend file is shared by all five
  ports, and story 40 is PARTIAL until all five ship. Either hold this
  story until they do, or hide `⋈ join` when the route answers 404. Decide
  with `PORTING.md`'s vendoring rules in hand.
- **Demo.** `frontend/src/demo/demo-fixtures.ts` and `docs/demo/` have no
  backend. Decide whether the demo hides the button or gets a fixture join.
- **Column widths.** `features/column-widths.ts` keeps widths per table;
  decide the key for a join view.
- **Test backend.** See what the E2E suite runs against and whether it
  needs the new route or a mock.

## 11. What "done" means

Parser tests (the harness that runs `parser-tests.json`):

- Valid: the §5 examples; lowercase keywords; quoted names; `AS` and bare
  aliases; `LEFT OUTER JOIN`; bare `JOIN`; either side order in a pair;
  `SELECT *` and `alias.*`; a trailing `;`; a self-join with aliases.
- Rejected, each with its own message: every item in §5's rejected list;
  a self-join without an alias; a 5th table; a 4th pair; an unknown table
  or column.
- Round trip: text → definition → text is stable.
- Filter: `alias.column` resolves to the right `join` index; qualified
  names outside a join view are rejected.

Playwright (assert on DOM, text and requests, not screenshots):

- Form builds the board O join; the request carries the story 40 `join`
  object; the grid shows the table bands.
- SQL builds the same join; switching modes keeps the definition; invalid
  text disables Form and shows the message.
- Autocomplete after `JOIN` and after `ON x.col = alias.`; incompatible
  columns are greyed with the reason.
- Save adds a chip; it survives reload; `copy link` reopens the same join.
- Filter on a joined column and sort on a joined column send `join` and
  `sort_join`.
- `has_more` enables next; the pager never shows a total.
- 400 message, the timeout banner, and the empty INNER result with
  `Switch to left join`.
- The record dialog shows a joined row grouped by table.
- Per `CLAUDE.md`, run the full suite at default parallelism before calling
  it done.

Docs: `spec/join-dsl.md`, `spec/filter-dsl.md`, and the frontend guides
that cover new controls.

## Left open after building

- **Offline demo.** Decided 2026-10-30: the live demo (`docs/demo/live/`, PGlite) runs joins on Postgres; the synthetic `docs/demo` still has no `/tables/join`, and its error line points to the live demo.
- **Timeout text.** The limit is the host's `query_timeout_secs`, so the notice says "longer than the time limit", not "5 seconds" as board T does.
- **Saved chips and the 3-line cap.** Saved-join chips share the table chips' cap, so on a database with many tables they sit behind `+ N more` (the active join chip stays visible).
- **Enum label.** Postgres reports every enum (and citext) as `USER-DEFINED`; the hint calls it `enum`, and lets it pair with `text` in case it is citext. A column type with no known class is never greyed; the server answers 400.
- **Columns come from one row.** The form and the SQL suggestions read a table's columns from `/tables/data?limit=1`; the table listing has names only.
- **No SELECT-list suggestions.** The text field suggests tables, `alias.` and columns after `ON`, not in the `SELECT` list; the form's column checklist covers that.
