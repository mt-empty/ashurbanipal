# Referenced-by view improvements

> **Status:** OPEN · **Area:** frontend, spec, docs

**Ask:** make "what references this row" easier to find, read and use. No
design is chosen yet, so this story starts with a design round and lists
what is known to be rough.

## 1. What exists today

- Incoming foreign keys come from `/tables/referenced-by`
  (`spec/protocol.md` §5.9): structural, the same for every row of a table,
  memoised per `(source, schema, table)`
  (`frontend/src/features/referenced-by.ts`).
- Two entry points show it: a PK cell opens a popover, and the record view
  has a section. Each entry is a button, `→ orders (user_id)`, that switches
  to the referencing table with `from = row[to]` seeded as a filter. An
  entry is disabled, with a title, when a pair's value in this row is NULL.
- A PK cell is a link (dotted underline, against the solid underline of FK
  cells) only when the table has referrers or the lookup failed. Its title
  gives the count ("referenced by 3 tables"). A PK that is also an FK, and a
  table with no PK, reach the list through the record view only
  (`frontend/src/features/grid.ts`, `styles.css` `.pk-cell`).

## 2. Known rough edges

- **No sign of which referrers hold rows for this record.**
  [[36-referenced-by-row-presence-indicator]] builds the flag if this
  story's design round wants it. It is the largest open piece of this view.
- **A flat list of structural entries.** Entries show a table and its
  columns, not the constraint name (§5.9 sends it), the schema (for
  cross-schema referrers it is in the label only), or how many columns pair
  up. Composite entries read the same as single ones.
- **Two surfaces, one renderer.** The popover and the record-view section
  differ only in container. Whether both are needed, and where the view
  should live (a panel, the record view, the header), is open.
- **Two drawings of a multi-column key.** A composite FK in the grid reads
  "part of foreign key (a, b) → t(x, y)" (`compositeLabel`,
  `frontend/src/lib/column-key.ts`); a composite referrer reads
  `→ t (a, b)`. The two should agree.

## 3. Open questions

- What is the view for: choosing a referrer to open, or seeing at a glance
  how connected a row is? The answer decides between a list, counts and a
  per-row summary.
- Group by referencing table (several constraints from one table), by
  schema, or keep the flat list?
- Which of story 36's flag, a count, or neither belongs in the list? This
  story decides; story 36 builds.
  The cost of a count is a full aggregate per entry (`spec/protocol.md` §5.9
  reports no row counts, on purpose).
- Does the PK-cell link stay, change, or move to the header?

## 4. Touchpoints

- `frontend/src/features/referenced-by.ts`, `grid.ts`, `record-view.ts`,
  `lib/column-key.ts`, `features/table-meta.ts`, `styles.css`.
- A design canvas board before any code (`docs/ui-guidelines.md`).
- Any wire change is a protocol addition through all five ports and
  conformance: presence in story 36, counts in [[61-count-matching-rows]].

## 5. What "done" means

- Decided in a design round and recorded here; then the list reads clearly
  for single and composite entries, and the three-browser e2e suite passes.

## 6. Out of scope

- Building the presence route: [[36-referenced-by-row-presence-indicator]];
  counts: [[61-count-matching-rows]].
- Composite FKs in the grid: [[49-composite-foreign-keys-in-the-grid]].
- A graph or ER view of the schema: [[27-er-relationship-diagram]].
