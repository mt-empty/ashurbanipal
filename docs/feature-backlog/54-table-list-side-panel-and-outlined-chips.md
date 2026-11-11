# Table list: a collapsible side panel, and outlined chips

> **Status:** OPEN · **Area:** frontend, docs, e2e · **Ref:** design canvas Rounds 18-19, chosen 2026-11-11

Show the table list in a side panel that can be hidden. When it is hidden,
the chips come back above the filter, in a new outlined style.

## 1. The ask

The table chips (`frontend/src/features/table-chips.ts`) work, but:

- **Hard to scan.** Chips differ in width, so names and counts do not line
  up. The count is small and faded with opacity (`.count` in
  `styles.css`).
- **Hidden tables.** Past three lines the list collapses behind
  "+ N more". Expanding it pushes the filter and grid down.
- **Order breaks.** To stay visible, the active table can jump out of
  alphabetical order behind a divider (`pulled`).
- **Joins compete.** Saved joins share the same three lines as tables.

## 2. Design

The boards are on the design canvas
(https://claude.ai/artifact/Tgvg8sC9udMhbyocWppmy9), Rounds 18 and 19:

| Board | Shows |
|---|---|
| BH | Panel open, light |
| BI | Panel hidden: chips back on top |
| BK style 3 | The chip style |
| BL, BM | BH and BI in dark |
| BN | Edge states |

Not chosen: BJ (collapse to a thin rail) and BK 5 (a "+ N more" list
that opens over the page).

### 2.1 Side panel (BH, BL)

- A column left of the filter and grid, below the top bar. One table per
  line: name on the left, count right-aligned with tabular figures.
- A **Tables · N** heading with a hide button. Below the tables, a
  **Joins · N** heading with the saved joins, then the unsaved join in view
  and **Save…**, then **+ new join**: the same items and order as today's
  join chips.
- The active table or join gets today's active colours (`--chip-active-bg`
  / `--chip-active-fg`).
- The panel scrolls on its own, so a long list never moves the grid.
- The back and forward arrows move beside the table name in the meta line.

### 2.2 Hidden: chips on top (BI, BM)

- The panel goes away and the chip row returns above the filter. A show
  button starts the row.
- Chips use style 3: a 1 px outline and a 6 px radius, with the count in
  its own cell behind a divider. The count uses `--text-muted` at full
  strength, not opacity. The active chip has a heavier outline and a bold
  name instead of a dark fill.
- Saved joins follow a divider, as today.
- Keep today's three-line cap and in-place expand (BN g): "+ N more",
  then "show fewer", the active table kept visible, and the expanded flag
  remembered in `ashurbanipal_tables_expanded`.

### 2.3 Edge states (BN)

- **a. Loading:** the spinner takes the count's place in a row or chip, so
  nothing moves (R9).
- **b. Long names:** the name is cut with an ellipsis and the count always
  stays. The `title` holds the name and the table comment (R8).
- **c. No estimate:** `?` as today. Once story 53 reports the engine, a
  SQLite source shows no count at all, and the chip drops its count cell.
  Build the count cell as optional from the start.
- **d. Joins:** a saved join in view is marked like the active table. An
  unsaved join in view has a dashed edge with **Save…** after it.
- **e. Keyboard:** Tab reaches the hide or show button, then each table and
  join in order. The focus ring matches the rest of the app.
- **f. Narrow window:** the panel starts hidden below a width to settle
  during the build (about 900 px is a proposal, not a decision), so the
  grid keeps its room.

## 3. Behaviour that must not change

- Tables and saved joins other than the one in view stay `<a href>` links
  in both the panel and the chips (R13). Buttons stay buttons.
- Mouse-rest prefetch (`prefetchOnRest`) works on panel rows as on chips.
- A source, schema or history switch still drops the last scope's list
  (the `loadTablesToken` and `chipsListScopeInView` guards).
- Sticky headers, the grid lock and the load bar still line up when the
  panel opens or closes.

## 4. Remembered state

- The panel's open or hidden state is a display preference, like the
  theme: its own `localStorage` key (`ashurbanipal_tables_panel`), outside
  the URL mirror. Add it to the key list in `docs/design.md`.
- No migration of stored state: a missing or bad value means the default,
  open, unless the window is narrow (R5).

## 5. Touchpoints

- `frontend/src/index.html`, `styles.css`, `features/table-chips.ts` (the
  panel and the chips share one list model), `features/join-saved.ts`
  (its chips feed both), `features/sticky-header.ts`, `features/grid-lock.ts`
- `docs/design.md` (stored keys), `docs/ui-guidelines.md` (only if a rule's
  wording names chips alone)
- e2e: about 86 selectors in 18 specs use `#tables`, `#tables-more` or
  `[data-table]`. Keep `[data-table]` on both rows and chips, so most of
  them need no change. Add specs for hide and show, the remembered state,
  the narrow-window default and keyboard reach.
- Regenerate `frontend/dbviewer.html` and the ports' copies (`mise run
  frontend:build`, `frontend:sync-ports`) and the demo.

## 6. What "done" means

- Screenshots match BH, BI, BL, BM and each BN case in light and dark.
- Every BN case works, apart from c's no-count case, which waits on story
  53.
- The full three-browser e2e suite passes.

## 7. Out of scope

- A table search or filter box (decided 2026-10-15: wait for complaints).
- The engine field itself: [[53-source-engine-field]].
- Grouping tables by name prefix.
