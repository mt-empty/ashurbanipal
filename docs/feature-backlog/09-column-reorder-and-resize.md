# Column reorder and resize

**What it is:** drag-to-reorder columns and drag-to-resize column width —
the two remaining items from the grid-customization family (column
show/hide already shipped).

**Tidbits:**
- Highest effort-to-payoff ratio of anything in this backlog; lowest
  priority here, last if at all.
- **Resize** has no native browser primitive — would be fully hand-rolled: a
  drag handle per `<th>` driven by Pointer Events, paired with
  `<colgroup><col>` and `table-layout: fixed` for predictable resize math
  (the table is currently `border-collapse: separate`, no `table-layout`
  set).
- **Reorder** does have a native primitive (HTML Drag and Drop API), plus a
  newer one worth knowing about: `Node.moveBefore()` (Chrome 133+, not yet
  cross-browser) atomically relocates an attached node without a
  remove+reinsert cycle, so in-node state (focus, an open popover) survives
  the move — directly relevant since `dbviewer.html` already has a
  hand-rolled focus-preservation shim (`captureTableFocus`/
  `restoreTableFocus`) built for a different case (full re-render) that a
  column drag wouldn't reuse but would parallel.
