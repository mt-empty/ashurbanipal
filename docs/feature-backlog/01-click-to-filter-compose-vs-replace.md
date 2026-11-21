# Click-to-filter: compose into existing filter vs. replace it

> **Status:** OPEN · **Area:** frontend

## 1. The ask

Every click-to-filter action replaces `#filter` wholly. They all call
`applyFilter()` (`frontend/src/features/filter-ui.ts`):

- the cell's `=` button and the null cell's `IS NULL` button
  (`features/grid.ts`);
- the record view's `=` button (`features/record-view.ts`);
- a value in the common-values dropdown (`features/filter-ui.ts`).

With a filter applied (`status = active`), a click on another cell's `=`
button should add to it, not start over:

- A column **not yet in the filter** is added with `AND`:
  `status = active AND region = us`.
- A column **already in the filter** with `=` or `IN` gets the new value
  added: `status = active` → `status IN (active, closed)`. A blind `AND`
  would give the always-false `status = active AND status = closed`.

The button knows which case applies before the click, so its tooltip can
say what the click will do.

## 2. Constraints that apply to every approach

- **FK-cell navigation and the referenced-by drill-in stay replace-only.**
  They switch tables, and a filter's columns don't carry over
  (`navigateWithSeededFilter()`, `features/view-history.ts`).
- **The applied filter is already parsed.** Submitting parses the text,
  and the store keeps the AST (`getAppliedFilterAst()`,
  `core/store.ts`). Compose can read which columns the filter uses, and
  whether it has a top-level `OR`, from that AST. It needs no separate
  tracking model, and a hand-edited filter is no different from a composed
  one.
- **No parentheses, and `AND` binds tighter than `OR`**
  (`spec/filter-dsl.md` §1). Appending `OR x` is always safe. Appending
  `AND x` is safe only with no top-level `OR`; otherwise it binds to the
  last term. Then an AND-compose must repeat the condition in every `OR`
  branch or fall back.
- **`IN` keeps a same-column group one condition** (`spec/filter-dsl.md`
  §2). `region = us AND status IN (active, closed)` needs no `OR`. Only
  `IS NULL` can't join an `IN` list, so a null plus a value on one column
  needs `OR` again.
- **Limits.** A filter holds at most 10 conditions (an `IN` counts as one)
  (`spec/protocol.md` §5.4.2) and 1024 bytes of DSL text (a frontend cap,
  `FILTER_MAX_DSL_BYTES` in `lib/filter-dsl.ts`; the spec has none). `eqClause()` already hides the `=` button when the
  clause alone is too long. A composed filter reaches the limits sooner,
  so compose needs a fallback there.

## 3. Approach A — Automatic detection

The click infers what to do from the applied AST:

- column not in the filter → `AND` (fallback, §2);
- column in the filter with `=` or `IN` → add the value to the list;
- column in the filter with another operator (`>`, `LIKE`, …) → no
  obvious meaning; see §5.

**Trade-off:** a click stays a click, nothing new to learn. The
same-column, other-operator case has no clear answer.

## 4. Approach B — Modifier keys

The user states intent with the key held during the click:

- **Plain click → replace.** Today's behaviour stays the default.
- **Ctrl+click → AND-append.** Needs the fallback (§2).
- **Shift+click → OR-append.** Always safe at the end of any filter.
- **Ctrl+Shift+click → undecided.** Leading candidate: exclude
  (`AND column != value`), safe whenever `AND` is.

Costs:

- **Convention collision.** Ctrl/Cmd+click means "open in a new tab".
  These are `<button>`s, so nothing breaks, but `docs/ui-guidelines.md`
  heuristic #4 leans against reusing the chord. Alt+click is the
  alternative.
- **Documented heuristics.** It overrides #7 (power-user accelerators,
  low weight for v1). The chords can't be found without a hint, and a
  tooltip that lists them is the tooltips-as-documentation that #10 rules
  out.
- **Keyboard.** Confirm that Enter/Space on a focused button with a
  modifier held carries `ctrlKey`/`shiftKey` into the `click` event in
  every target browser, or offer a non-mouse path (for example a small
  menu).

The baseline both are weighed against is today's replace-only click.

## 5. Open questions

- Same-column click when that column has a non-equality condition
  (`price > 100`): `AND` it, replace that condition, or replace the whole
  filter?
- Fallback when `AND` isn't safe or a limit is hit: replace, a no-op with
  a message, or repeat the condition in every `OR` branch?
- A click on a value already in the filter: no-op?
- Do the common-values dropdown and the value-count popover
  ([[62-count-rows-per-value]]) compose too, or stay replace-only?
- Compose by appending to the user's text, or by rewriting the filter from
  its AST? Adding a value to an `IN` list needs a rewrite, which loses the
  user's spacing and case. `lib/filter-dsl.ts` has clause builders
  (`filterClause()`, `filterClauses()`) but no AST-to-text serializer.
- `frontend-style-guide.md` §3 keeps click-to-filter from "parsing or
  judging arbitrary user-typed text". Reading the applied AST parses
  nothing new, but it does judge the typed filter. Does §3 need a line
  that allows it?
- Tooltip: computed when the cell renders, or on hover?
- Is any of this worth its cost over replace-only?
