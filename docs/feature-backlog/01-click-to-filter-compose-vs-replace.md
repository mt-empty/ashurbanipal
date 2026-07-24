# Click-to-filter: compose into existing filter vs. replace it

Status: discussed in depth (2026-07-19); confirmed more complex than
originally scoped. Not designed, not scheduled — captured here so the
clarity gained isn't lost before it's picked up.

## 1. The ask

Today, every click-to-filter action (`applyFilterClause()` in
`src/frontend/dbviewer.html`) **replaces** `#filter` wholly — the per-cell
"filter by this value" button, the null-cell filter button, the
common-values dropdown, and FK-cell navigation all go through the same
helper and all discard whatever filter was there before.

When a filter is already applied (e.g. `status = active`) and the user
clicks a different cell's "filter by this value" button, they'd expect it
to *add* to the filter, not discard it and start over. Refined during
discussion into a concrete semantic:

- Clicking a column **not already in the filter** appends it with `AND`
  (`status = active` → `status = active AND region = us`).
- Clicking a column **already in the filter** (any operator/value) ORs the
  new condition with just that column's existing condition, leaving other
  AND'd columns untouched (`status = active` → click `status = closed` on
  another row → `(status = active OR status = closed)`, not a blind AND,
  which would produce the always-false `status = active AND status =
  closed`). This also resolves what the button's tooltip should say in the
  moment — "append AND" vs. "append OR" — since the button already knows
  which case it's in before the click happens.

## 2. Constraints that apply to every approach

- **Composition doesn't re-parse the box** (`frontend-style-guide.md` §3/§7).
  Composing a fresh clause from a *known* column/value (what
  `applyFilterClause()` does today) is fine. (The old blanket "no
  client-side parsing" rule was reversed — the submit-time grammar parser
  now lives in the frontend, `spec/filter-dsl.md` — but composition
  affordances still shouldn't need to read back and understand *arbitrary
  existing* filter text; any approach that needs to know "what's already
  in the box" should get that answer without depending on re-parsing.)
- **No parentheses/nesting in the DSL** (`spec/filter-dsl.md` §1), and `AND`
  binds tighter than `OR` (SQL convention). This is the source of every
  correctness hazard below.
- **Precedence asymmetry (the key fact that constrains every approach):**
  appending `OR x` to the *end* of any existing filter string is always
  safe — the entire preceding expression automatically becomes the left
  operand of that trailing `OR`, because `OR` is the lowest-precedence
  operator in the grammar. Appending `AND x` to the end is safe **only** if
  the filter has no top-level `OR` in it yet — otherwise `AND` reparents
  onto just the immediately preceding term, silently dropping earlier
  conditions from one branch:
  ```
  existing: region = us AND status = active
  append "OR price > 100" → region = us AND status = active OR price > 100
    parses as (region = us AND status = active) OR price > 100   ✅ correct

  existing: region = us OR status = active
  append "AND price > 100" → region = us OR status = active AND price > 100
    parses as region = us OR (status = active AND price > 100)   ❌ wrong —
    region = us is no longer required on that branch
  ```
  Every approach either has to avoid the unsafe case, detect it and fall
  back, or do real distribution work to route around it.
- **FK-cell navigation stays replace-only, unconditionally**, regardless of
  whatever gets built here — it also switches tables, and a filter's
  columns don't carry over across tables (already fixed as a bug, see
  `src/frontend/dbviewer.html`'s table-switch handler).
- **Common-values dropdown scope is undecided under every approach.** It
  uses the same `applyFilterClause()` helper as the per-cell buttons — does
  it get the same compose behavior, or stay replace-only? Not discussed in
  enough depth yet to answer regardless of which approach below is chosen.
- Mixing an OR-group with other AND'd columns can't be serialized by naive
  string-append — `region = us` then OR-grouping `status` across two
  values must serialize as `region = us AND status = active OR region = us
  AND status = closed` (distributing the AND'd condition across every OR
  branch), or it silently drops the region filter from one branch.
  Distribution is tractable (linear growth: branches × other AND'd
  conditions) as long as **at most one column has an active OR-group at a
  time**. A second simultaneous OR-group (two different columns each
  multi-valued) is a true combinatorial case — see open questions below.

## 3. Approach A — Automatic AND/OR detection

The original direction: the tool infers the join type from context, no
user action needed to choose it.

- **Mechanism required:** since "is column X already in the filter" can't
  be answered by re-parsing text, the tool needs a small in-memory JS
  model — a list of `{column, op, value}` grouped by column, plus how
  groups are joined — built up *only* from click-to-filter/common-values
  actions. The client authors every composed clause itself, so it always
  knows the structure without parsing anything. A manual edit to `#filter`
  invalidates the tracked model (the client can no longer vouch for what's
  in the box), which should fall back to a safe default — most likely
  disabling compose and reverting to replace-only until the model is
  rebuilt from scratch.
- **Tooltip:** the button already knows which case it's in before the
  click (new column vs. repeat column), so it can say "append AND" or
  "append OR" ahead of time with no extra state needed.
- **Trade-off:** no new interaction to learn (a click is still just a
  click), but the heuristic itself carries irreducible ambiguity (what does
  a click *mean* when the column already has a different condition?) and
  the tracking model is the heaviest of the approaches here.

## 4. Approach B — Explicit modifier-key control

A newer idea: instead of the tool guessing intent, the user states it via
the key held during the click. Removes the heuristic-ambiguity problem in
Approach A entirely, at the cost of a new interaction to discover and learn.

- **Plain click → replace.** Unchanged from today's behavior — the safe,
  zero-risk default stays the default. No regression for anyone who never
  learns the modifiers.
- **Ctrl+click → AND-append.** Narrows the result set.
- **Shift+click → OR-append.** Broadens the result set. Thanks to the
  precedence asymmetry in §2, appending `OR x` to the end of *any* existing
  filter is always safe — no distribution ever needed, no tracking needed
  beyond "what's the current filter string," because a trailing `OR`
  naturally brackets everything before it regardless of what it contains.
- **Ctrl+Shift+click → undecided.** Leading candidate: **AND-NOT /
  exclude** (`AND column != value`, or `AND NOT column = value`) — pairs
  naturally with plain Ctrl as "include this" vs. "exclude this," and is
  safe under the same condition plain AND is (blocked only once a top-level
  `OR` already exists in the filter). Alternatives not yet explored in
  depth: a per-column surgical replace (replace just that column's
  condition, leave others — would need the heavier per-column model from
  Approach A, so loses this approach's main advantage); something
  unrelated to boolean composition entirely (e.g. table-switch shortcut).
- **Mechanism required:** much lighter than Approach A — only a single
  boolean needs tracking ("does the current composed filter already
  contain a top-level `OR`?"), not a full column-grouped model, since
  trailing-OR is unconditionally safe and trailing-AND only needs that one
  bit to know whether it's safe. Once true, Ctrl+click either disables
  itself (falls back to replace, or is a no-op with a status message) or
  would need real distribution to stay enabled — not yet decided which.
  Still needs the same "manual edit to `#filter` invalidates tracking"
  fallback as Approach A, for the same reason.
- **Convention collision:** Ctrl+click (and Cmd+click on Mac, and
  middle-click) is a near-universal browser convention for "open in a new
  tab." These are `<button>`s, not `<a>`s, so nothing actually breaks, but
  `ui-guidelines.md` heuristic #4 ("prefer platform conventions over
  inventing new ones") leans against repurposing that specific chord for
  something unrelated. Worth considering swapping AND to a different
  modifier (e.g. Alt+click) and leaving Ctrl/Cmd free, or accepting the
  collision since no actual browser behavior is overridden.
- **Heuristic #7 tension:** `ui-guidelines.md` names keyboard accelerators
  for power users as "deliberately low weight for v1... revisit only if
  real usage shows friction." Building this means consciously overriding
  that documented stance.
- **Discoverability:** with no click-based signal of what's possible, this
  needs a tooltip on the button spelling out the combinations — not yet
  decided whether that's a static tooltip listing all the mappings, or
  something computed dynamically per hover state.
- **Accessibility:** modifier+click is mouse-centric. Needs confirmation
  that keyboard activation (Enter/Space on a focused button while a
  modifier is held) reliably carries `ctrlKey`/`shiftKey` through to the
  resulting synthetic `click` event across target browsers, or a non-mouse
  equivalent path needs designing (e.g. a small menu) so the feature isn't
  mouse-only.
- **Trade-off:** removes all heuristic ambiguity and needs the least
  tracking state of any compose-capable approach, but introduces a genuinely
  new, undiscoverable-without-a-hint interaction model, and directly
  overrides two documented low-weight heuristics rather than one.

## 5. Approach C — Replace-only (status quo)

Ship nothing; keep today's behavior. Zero implementation cost, zero new
correctness risk, but doesn't address the original ask at all. Useful as
the baseline the complexity of A and B should be weighed against.

## 6. Comparison

| | A: Automatic detection | B: Modifier keys | C: Replace-only |
|---|---|---|---|
| New interaction to learn | None (still just a click) | Yes — modifier chords, needs a tooltip to discover | None |
| Tracking state needed | Full column-grouped model | One boolean (top-level-OR-present) | None |
| Distribution ever needed | Yes, for mixed OR-group + AND columns | No — only the always-safe trailing-OR case is exposed by default; AND is gated instead | N/A |
| Ambiguity in what a click means | Yes — same-column repeat click has irreducible ambiguity | No — user states intent explicitly | N/A |
| Heuristics overridden | None new | #4 (convention collision) and #7 (power-user accelerators, low weight for v1) | None |
| Addresses the original ask | Yes | Yes | No |

## 7. Open questions (apply regardless of approach chosen)

- What happens when a user tries to create a *second* simultaneous
  OR-group (multi-valuing a column while another column already has one)?
  Candidates floated but not decided: replace that second column's older
  value instead of growing a second group; or disable further OR-compose
  and fall back to full replace once one group already exists.
- Exact-duplicate click (same column/op/value already present) — no-op,
  or fall through to whatever the general same-column rule does?
- Should the common-values dropdown compose the same way click-to-filter
  buttons do, or stay replace-only regardless?
- Tooltip mechanics: computed on hover vs. at render time, and whether it
  replaces the static `aria-label="filter by this value"` or supplements it.
- Given all of the above, is this worth the implementation complexity
  relative to the simpler "replace-only" status quo, or should replace-only
  just stay the answer?
