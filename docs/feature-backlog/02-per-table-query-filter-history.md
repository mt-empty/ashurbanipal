# Per-table query/filter history

> **Status:** OPEN · **Area:** frontend

**Ask:** remember a table's previous filters, so the user can pick one
again.

**What exists:**
- Each applied filter is its own browser-history entry, so Back and
  Forward step through past filters in the tab (`docs/ui-guidelines.md`
  R16). That history is one line across all tables, not a list per table.
- The applied filter lives in the URL only, never in `localStorage`
  (R6c).

**Decide first — this is a policy question before an implementation one:**
- **Session-only, in memory.** Fits R6 as written, but the list is gone
  after a reload.
- **Persisted in `localStorage`.** Needs R6c changed. R6c exists so that
  returning to a table never silently reapplies a filter; a list the user
  picks from reapplies nothing. R6b still applies: only filters the user
  typed qualify, not ones a click built from a row value (the `=` button,
  FK navigation). It needs a way to clear the list.

**Shape:** the filter field's suggestion list (`features/filter-ui.ts`,
`features/suggest-list.ts`) is the natural place to show past filters,
since the filter stays one plain text field
([[10-structured-filter-builder-ui]]).

**Open question:** does a join view keep its own list, keyed by the join?
