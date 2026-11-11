# Highlight cells that changed since the last refresh

> **Status:** OPEN · **Area:** frontend, docs, e2e

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

- `frontend/src/core/store.ts` (`diffNewRows`) already keeps the previous
  same-scope payload in `lastPayload`.
- Build a `Map` from each previous row's `rowKey`
  (`frontend/src/lib/row-diff.ts`) to that row.
- For each current row whose key is in the map, compare each column with
  `===`. Record the columns that differ: `Map<rowKey, Set<column>>`.
- Compare only columns present in both fetches. A column added or dropped
  between fetches is not a change.
- `renderRows` (`frontend/src/features/grid.ts`) adds a class to those
  cells. The CSS fades it like `.row-new`, with a new colour token beside
  `--row-new-bg`, and a static tint under `prefers-reduced-motion` (R15).

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

## 4. Status and chip

- `#row-new-chip` and the `#status` text gain the changed-cell count, for
  example `2 new · 3 changed` (R9). Count rows with a change, or cells?
  See §7.
- The refresh button title changes from "briefly highlight rows added
  since the last look" to cover both.

## 5. Touchpoints

- `frontend/src/lib/row-diff.ts` — a `collectChangedCells` beside
  `collectNewRowKeys`, sharing the key and the gates; unit tests next to
  the existing ones.
- `frontend/src/core/store.ts` (`diffNewRows`),
  `frontend/src/bootstrap/controller.ts`, `frontend/src/features/grid.ts`
  (`renderRows`), `frontend/src/features/auto-refresh.ts` (chip),
  `frontend/src/styles.css`, `frontend/src/index.html` (button title).
- `docs/ui-guidelines.md` R10 — widen "new-row tint" to "new-row and
  changed-cell tint", keeping the PK-only identity rule.
- Check the design canvas boards before building (the refresh and chip
  boards); add one if none covers a changed cell.

## 6. What "done" means

- Unit tests: changed cell found; unchanged row skipped; PK-less table and
  scope change produce nothing; `null` to `''` counts as a change.
- An e2e spec: update a seed row through the test's own DB connection,
  click refresh, and assert the tint lands on exactly that cell; repeat
  with auto-refresh.
- The full three-browser e2e suite passes.

## 7. Open questions

- **Count rows or cells** in the chip? Rows matches "2 new" better; cells
  is more exact.
- **A cell's tint inside a new row.** A new row has no previous value, so
  it gets only the row tint. Confirm that is the wanted look.
- **Very long values.** Comparing a multi-MB `jsonb` string is linear but
  fast. No cap planned; revisit only if a slow refresh is measured.

## 8. Out of scope

- Showing the old value (a tooltip or a diff). Story 04 owns row diffs.
- Rows deleted since the last fetch.
