# Column reorder and resize

> **Status:** OPEN · **Area:** frontend

**What it is:** drag-to-reorder columns and drag-to-resize column width —
the two remaining items from the grid-customization family (column
show/hide already shipped, `docs/design.md` §3.1).

**Tidbits:**
- Highest effort-to-payoff ratio of anything in this backlog; lowest
  priority here, last if at all.
- **Resize** has no native browser primitive — would be fully hand-rolled: a
  drag handle per `<th>` driven by Pointer Events, paired with
  `<colgroup><col>` and `table-layout: fixed` for predictable resize math
  (the table is currently `border-collapse: separate; width: max-content`,
  no `table-layout` set). `frontend/src/features/column-widths.ts` already
  keeps grow-only per-column widths; a user-set width would have to
  override it.
- **Reorder** has a native primitive (HTML Drag and Drop API). Also worth
  knowing: `Node.moveBefore()` (Chrome 133+; check other browsers before
  relying on it) moves an attached node without a remove+reinsert, so
  focus and an open popover survive the move.
  `frontend/src/bootstrap/table-focus.ts` restores focus after a full
  re-render; a column move would need the same guarantee.
- Both need a keyboard path, not drag alone
  (`docs/frontend-style-guide.md` §5).
- A saved order or width would be per-table state, like hidden columns
  (`docs/design.md` §3.1, UI state persistence).
