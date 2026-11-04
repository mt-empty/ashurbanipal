# Referenced-by view improvements

> **Status:** OPEN · **Area:** frontend, spec, docs

**Ask:** make "what references this row" easier to find, read and use.
Parked by the user on 2026-11-02 ("references could also be improved") with
no design chosen yet, so this story starts with a design round and lists what
is known to be rough.

## 1. What exists today

- Incoming foreign keys come from `/tables/referenced-by`
  (`spec/protocol.md` §5.9, story 14): structural, the same for every row of
  a table, memoised per `(source, schema, table)`
  (`frontend/src/features/referenced-by.ts`).
- Two entry points show it: clicking a primary-key cell opens a popover, and
  the record view has a section. Each entry is a button, `→ orders
  (user_id)`, that switches to the referencing table with `from = row[to]`
  seeded as a filter. An entry is disabled, with a title, when a pair's value
  in this row is NULL.
- Every PK cell is underlined and clickable (dotted, against the solid
  underline of FK cells), whether or not anything references the table
  (`frontend/src/features/grid.ts`, `styles.css` `.pk-cell`).

## 2. Known rough edges (2026-11-02 critique, item 8, and the user's notes)

- **A promise that can be empty.** A PK cell on a table nothing references
  opens "nothing references this table". The underline says otherwise.
  Fetching the list once per table when it renders (already cached) would let
  the underline appear only when there is a referrer, with the count in the
  title ("referenced by 3 tables").
- **No sign of which referrers hold rows for this record.** Story 36 covers
  it (an `EXISTS` per entry on a new route). It is the largest open piece of
  this view.
- **A flat list of structural entries.** Entries show a table and its
  columns, not the constraint, the schema (for cross-schema referrers it is
  in the label only), or how many columns pair up. Composite entries read the
  same as single ones.
- **Two surfaces, one renderer.** The popover and the record-view section
  differ only in container; whether both are needed, and where the view should
  live (a panel, the record view, the header), is open.
- **Composite FKs** shown in the grid are story 49; the two should agree on
  how a multi-column relationship is drawn.

## 3. Open questions

- What is the view for: choosing a referrer to open, or seeing at a glance
  how connected a row is? The answer decides between a list, counts and a
  per-row summary.
- Group by referencing table (several constraints from one table), by
  schema, or keep the flat list?
- Which of story 36's indicator, a count, or neither belongs in the list?
  The cost of a count is a full aggregate per entry (`spec/protocol.md` §5.9
  reports no row counts on the base route, on purpose).
- Does the PK-cell underline stay, change, or move to the header?

## 4. Touchpoints

- `frontend/src/features/referenced-by.ts`, `grid.ts`, `record-view.ts`,
  `lib/column-key.ts`, `features/table-meta.ts`, `styles.css`.
- A design canvas board before any code (`docs/ui-guidelines.md`).
- Any wire change (presence, counts) is a protocol addition through all five
  ports and conformance, as story 36 describes; a frontend-only first step
  (underline only when there is a referrer, a title with the count) needs
  none.

## 5. What "done" means

- Decided in a design round and recorded here; then: a PK cell promises only
  what it can deliver, the list reads clearly for single and composite
  entries, and the three-browser e2e suite passes.

## 6. Out of scope

- Row-presence and counts: story 36.
- Composite FKs in the grid: story 49.
- A graph or ER view of the schema: story 27.
