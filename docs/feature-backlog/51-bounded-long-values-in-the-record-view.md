# Bounded long values in the record view, and stable previous/next

> **Status:** OPEN · **Area:** frontend, e2e

**Ask:** a long JSON, `jsonb` or text value should not take over the record
dialog, and the previous/next buttons should stay where they are while the
user pages through rows. This is item 12 of the 2026-11-02 critique, widened
by the user on 2026-11-04: the same problem exists for plain text, and the
buttons move. Parked, with the other column-UX items, until picked up.

## 1. What exists today

- `renderJsonTree` (`frontend/src/lib/json-tree.ts`) builds every node
  expanded. The record view does it for each JSON column when the dialog
  opens (`frontend/src/features/record-view.ts` `fieldValue`), and the cell
  popover does it on each click. A 2,000-element array is thousands of DOM
  nodes.
- A text value is a `dd` with `white-space: pre-wrap` and no height limit
  (`frontend/src/styles.css`, `dialog dl dd`). The only bound is the whole
  `#record-body`, which scrolls at `--dialog-body-max-h` (80vh − 3rem), so one
  long field pushes every field below it out of view.
- The previous/next buttons sit in the dialog header (`index.html`,
  `.record-nav`). The dialog is a native modal `<dialog>`, centred in the
  viewport with a height set by its content. A short row followed by a long
  one changes the height, the centring moves the whole dialog, and the buttons
  jump under the pointer. The columns are `max-content`, so the width can
  change too.

## 2. Direction (from the user)

- **Collapse large JSON** (the original item 12): collapse below depth 2, and
  collapse any container with more than about 50 children, with a "… 1,950
  more" line.
- **Copy button: not needed.** The cell already offers copy, so none is added
  to the popover (dropped from the original item).
- **The same for long `jsonb` and text in the record view:** bound the height
  of a single value so it cannot take the dialog.
- **Previous/next must not move** between rows.

## 3. Open questions (settle before building)

- **How is a long value bounded?** A fixed `max-height` with its own scroll,
  a "show more" toggle, or a line clamp with the full value in the cell
  popover. A nested scroll area inside a scrolling dialog is awkward on touch.
- **What counts as long?** A line count, a character count, or a height. One
  rule for text and for the JSON tree, or two.
- **How are the buttons held still?** Options: a fixed dialog height, so only
  the content scrolls; pin the dialog to the top of the viewport so it grows
  downward; or move the buttons out of the dialog's flow (a footer bar that is
  always at the bottom). The first two also fix the width if a minimum is set.
- **Does the JSON tree remember what the user expanded** when they page to the
  next row, or reset to the default?
- **Rendering cost.** A collapsed container should not build its children
  until opened, or the DOM cost of a large array stays.

## 4. Touchpoints

- `frontend/src/lib/json-tree.ts` (collapse rule, lazy children), its unit
  tests.
- `frontend/src/features/record-view.ts`, `styles.css` (value bound, dialog
  size and position, `.record-nav`).
- `frontend/src/features/grid.ts` `showCellPop`, which shares the tree.
- A design canvas board for the bound and the button placement
  (`docs/ui-guidelines.md`).

## 5. What "done" means

- A record with a large JSON value and a long text value opens with each
  bounded, the other fields still visible, and the full value reachable.
- E2E: the previous and next buttons keep the same position (compare their
  bounding boxes) across rows of different heights, on all three browsers.
- A 2,000-element array opens without building thousands of nodes.
- Unit tests for the collapse rule; the full three-browser e2e suite passes.

## 6. Out of scope

- A copy button in the cell popover.
- The record-view tree rounding large integers on screen (story 31).
- Composite foreign keys and the referenced-by view (stories 49 and 50).
