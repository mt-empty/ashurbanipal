# Highlight cells that changed since the last refresh

> **Status:** DONE · **Area:** frontend, docs, e2e · **Ref:** design canvas round 20 (BO, BP b, BQ), chosen 2026-11-19; `lib/row-diff.ts` `collectRowChanges`, `refresh-highlight.spec.ts`

On refresh, tint each cell whose value differs from the same row's value
in the previous fetch, the way new rows are tinted today.

## 1. The ask

The main reason to open Ashurbanipal is "I ran my feature. Did the row
change?" Refresh and auto-refresh (story 38) already tint rows that are
new since the last fetch (`docs/ui-guidelines.md` R10). A row that was
edited gets no mark, so the user has to remember the old value and compare
by eye.

## 2. How it works

No hashing. The previous page is already in memory, and every value is a
string or `null` (`frontend/src/core/types.ts`, `Row`), so a direct
comparison is as cheap as a hash and says which cell changed.

- `frontend/src/core/store.ts` (`diffRows`) keeps the previous
  same-scope payload in `lastPayload`.
- Build a `Map` from each previous row's `rowKey`
  (`frontend/src/lib/row-diff.ts`) to that row.
- For each current row whose key is in the map, compare each column with
  `===`. Record the columns that differ: `Map<rowKey, Set<column>>`.
- Compare only columns present in both fetches. A column added or dropped
  between fetches is not a change.
- `renderRows` (`frontend/src/features/grid.ts`) adds a class to those
  cells. The CSS fades it like `.row-new`, with a new colour token beside
  `--row-new-bg` (`--cell-changed-bg`, blue), and a static tint under
  `prefers-reduced-motion` (R15). The class is dropped when the fade ends
  or the column is hidden, because showing a hidden column restarts its
  cells' CSS animations.

Cost: at most one page of rows × columns string comparisons per refresh.
Memory is unchanged.

## 3. Rules (same gates as the new-row tint)

- Only on a user refresh or an auto-refresh tick, never on a page, sort,
  or filter change. `rowDiffKey()` already decides "same scope".
- A table with no primary key gets no tint. A join view gets no tint,
  because it has no row identity.
- A row that moved to another page cannot be compared, and that is fine.
- The previous payload stays in memory only, never persisted (R6).
- Re-sorting reorders rows but keeps their keys, so the comparison is
  unaffected.

## 4. Status and chips

- A second chip, `#row-changed-chip`, sits after `#row-new-chip` in the
  changed-cell tint: `+2 new` `3 changed`. It counts rows with a change,
  not cells. Both hide after 3 s, with the fades.
- A change only in hidden columns has no cell to tint, so the chip says
  `1 changed in a hidden column` (or `in hidden columns`).
- `#status` joins the two: `2 new · 3 changed` (R9). "no changes" shows
  only when nothing is new or changed.
- The refresh button title covers both tints.

## 5. Touchpoints

- `frontend/src/lib/row-diff.ts` — `collectRowChanges` returns new rows
  and changed cells from one pass,
  sharing the key and the gates; `changedRowsText` words the chip.
- `frontend/src/core/store.ts` (`diffRows`),
  `frontend/src/bootstrap/controller.ts`, `frontend/src/features/grid.ts`
  (`renderRows`), `frontend/src/features/auto-refresh.ts` (chip),
  `frontend/src/styles.css`, `frontend/src/index.html` (button title).
- `docs/ui-guidelines.md` R10 — widen "new-row tint" to "new-row and
  changed-cell tint", keeping the PK-only identity rule.
- Design canvas round 20: BO (layout), BP (tint options; b chosen), BQ
  (edge cases).

## 6. What "done" means

- Unit tests: changed cell found; unchanged row skipped; PK-less table and
  scope change produce nothing; `null` to `''` counts as a change.
- e2e specs (`refresh-highlight.spec.ts`, `auto-refresh.spec.ts`): the
  tint lands on exactly the changed cell, on refresh and on a tick; new
  and changed together; a hidden column; the class drops after the fade;
  no PK. They mock `/tables/data` like the existing new-row tests, rather
  than editing a seed row.
- The full three-browser e2e suite passes.

## 7. Decisions (2026-11-19)

- **The chip counts rows.** It matches `+2 new`; the tint shows the cells.
- **A new row gets only the row tint.** It has no previous value.
- **Blue, not amber** (canvas BP b): blue and green stay apart under the
  common colour blindness types.
- **Very long values.** Compared in full, no cap; revisit only if a slow
  refresh is measured.

## 8. Out of scope

- Showing the old value (a tooltip or a diff). Story 04 owns row diffs.
- Rows deleted since the last fetch.
