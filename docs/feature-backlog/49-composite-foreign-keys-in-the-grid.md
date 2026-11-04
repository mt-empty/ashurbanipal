# Composite foreign keys in the grid

> **Status:** OPEN · **Area:** frontend, docs

**Ask:** show a composite foreign key (two or more columns that together
reference one row elsewhere) in the grid and the record view, and let the
user follow it. Today it is invisible there. Parked by the user on
2026-11-02 with a note to rethink how it is presented before building it.

## 1. What exists today

- `spec/protocol.md` §5.4.1 omits a composite FK's columns from `key` and
  `references` entirely, because one `references` value cannot say which
  referencing column pairs with which referenced column
  (`docs/design.md`, the `GET /tables/data` section). The seed's `inventory_counts` (`warehouse_code`,
  `bin_code` → `inventory_locations`) shows the effect: no icon, no
  navigation.
- The data is already on the client. `/tables/structure` (§5.10) returns the
  full column pairs and `tableStructure()` caches them
  (`frontend/src/features/structure.ts`); `/tables/referenced-by` (§5.9) lists
  composite FKs with every pair, and `filterClauses`
  (`frontend/src/lib/filter-dsl.ts`) already builds multi-column drill-ins for
  it (`frontend/src/features/referenced-by.ts`).
- Single-column FKs: a solid underline on the cell, a 🔗 in the header, and a
  click that opens the target row (`frontend/src/features/grid.ts`,
  `frontend/src/lib/column-key.ts` `keyDescriptionOf`).

## 2. The first proposal (from the 2026-11-02 critique, item 7)

After a table loads, read its cached structure. Mark each composite-FK column
with the 🔗 and a note naming the other columns ("with `bin_code`"). On click,
navigate with the full pair taken from the row. Cost: one structure fetch per
table, already cached. The user did not accept this presentation; it is
recorded as a starting point, not a decision.

## 3. Open questions (settle in a design round before building)

- **One mark or one per column?** A composite key is one relationship, but the
  grid is column by column. Options: mark every member column; mark only the
  first and tint the rest; or add a row-level affordance.
- **What does a click do?** Follow from whichever column was clicked, with the
  whole pair taken from the row, or open a small chooser. A NULL in any member
  column means no row can be expressed (the §5.9 list already disables that
  entry).
- **Wire change or not?** Frontend-only keeps the spec as it is and costs one
  structure fetch per table. A §5.4.1 field that lists composite members
  (a separate named optional field, per story 23 §4) avoids the fetch and
  would also serve other clients, but it is a five-port protocol change.
- **Where else?** Header icon and tooltip, the record view's per-field chips,
  the filter box's column suggestions (`keyDescriptionOf`), and the join
  builder's foreign-key suggestion (`findForeignKey` knows only single-column
  keys).

## 4. Touchpoints

- `frontend/src/features/grid.ts`, `record-view.ts`, `column-parts.ts`,
  `lib/column-key.ts`, `features/table-meta.ts` (which already holds the
  per-table referrers and composite FKs), `styles.css`.
- A design canvas board first (`docs/ui-guidelines.md`): the mark and the
  click are a visual decision.
- E2E on `inventory_counts`, including a NULL member.

## 5. What "done" means

- A composite-FK column is recognisable as such in the grid and the record
  view, with a title naming the target and every pair.
- A click opens the target row; a NULL member says why it cannot.
- Unit tests for the column-key description, and the full three-browser e2e
  suite.

## 6. Out of scope

- Changing what §5.4.1 means for `key`/`references` on a single column.
- The referenced-by view itself: story 50.
