# dbviewer.html feedback backlog

Status: draft, not scheduled — a running list of ideas raised while using the
filter DSL after it landed, plus everything already on record elsewhere in
the project as deferred/future work. None of these are agreed or sized yet;
this doc exists so they aren't lost between conversations. Each entry has
what was asked (or where it's already documented), and the constraints/impact
discovered by checking it against the existing code and the standing docs
(`ui-guidelines.md`, `frontend-style-guide.md`, `filter-dsl.md`, `design.md`).

---

## 1. Click-to-filter: compose into existing filter vs. replace it

**Status:** discussed in depth (2026-07-19); confirmed more complex than
originally scoped. Not designed, not scheduled — captured here so the
clarity gained isn't lost before it's picked up.

**Ask:** when a filter is already applied (e.g. `status = active`) and the
user clicks a different cell's "filter by this value" button, they'd expect
it to *add* to the filter, not discard it and start over. Refined during
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

**Impact / constraints:**
- `frontend-style-guide.md` §7 explicitly bans client-side filter *parsing*:
  "would duplicate the server-side parser's job... a second place that can
  drift from it." `applyFilterClause()` today only *composes* a fresh clause
  from a known column/value — it never reads back the existing filter text.
  Deciding "is column X already in the filter" by re-parsing the live
  `#filter` text would cross that line.
  - **Resolution direction:** don't re-parse text at all. Keep a small
    in-memory JS model (list of `{column, op, value}` grouped by column,
    plus how groups are joined) built up *only* from click-to-filter /
    common-values actions — since the client authors every composed clause
    itself, it always knows the structure without ever parsing arbitrary
    text. Any manual edit to the `#filter` textbox invalidates the tracked
    model (the client can no longer vouch for what's in the box), which
    should fall back to a safe default — most likely disabling compose and
    reverting to replace-only until the model is rebuilt from scratch.
- The DSL has **no parentheses/nesting** (deliberate, `filter-dsl.md` §1;
  see also the discussion captured for why — same category of decision as
  "one table at a time," not a parser limitation). This turns out to bite
  harder than originally thought once OR-grouping and AND-appending are
  both in play together, not just OR-appending alone:
  - Mixing an OR-group with other AND'd columns can't be serialized by
    naive string-append. `region = us` then OR-grouping `status` across two
    values must serialize as `region = us AND status = active OR region =
    us AND status = closed` (distributing the AND'd condition across every
    OR branch) — the naive `region = us AND status = active OR status =
    closed` parses under AND-binds-tighter-than-OR precedence as `(region =
    us AND status = active) OR status = closed`, silently dropping the
    region filter from the second branch.
  - Distribution is tractable (linear growth: branches × other AND'd
    conditions) as long as **at most one column has an active OR-group at
    a time**. A second simultaneous OR-group (two different columns each
    multi-valued) is a true combinatorial case — open question below.
- Clicking the *same* column with the *exact same* op/value as an existing
  condition (double-click, or re-clicking after a re-render) should
  presumably be a no-op rather than growing a redundant OR branch — not
  discussed in detail yet.
- FK-cell navigation already *replaces* the filter on purpose, because it
  also switches tables (a filter's columns don't carry over across tables —
  fixed as a bug, see `src/frontend/dbviewer.html`'s table-switch handler).
  Compose behavior must not apply there. Whether the common-values dropdown
  (`renderCommonValues`, same `applyFilterClause` helper) should compose
  under the same rule, or stay replace-only, hasn't been discussed either.

**Open questions:**
- What happens when a user tries to create a *second* simultaneous
  OR-group (multi-valuing a column while another column already has one)?
  Candidates floated but not decided: replace that second column's older
  value instead of growing a second group; or disable further OR-compose
  and fall back to full replace once one group already exists.
- Exact-duplicate click (same column/op/value already present) — no-op,
  or fall through to whatever the general same-column rule does?
- Tooltip mechanics: computed on hover vs. at render time, and whether it
  replaces the static `aria-label="filter by this value"` or supplements it.
- Given all of the above, is this worth the implementation complexity
  relative to the simpler "replace-only" status quo, or should replace-only
  just stay the answer?

---

## 2. Autocomplete for the filter input — **Done** (column names only)

**Ask:** some form of simple autocomplete while typing a filter clause.

**Impact / constraints:**
- Same §7 tension as above in the general case — autocompleting *inside* an
  already-typed compound expression (mid-clause, after `AND`/`OR`) requires
  understanding where the cursor sits in the grammar, which edges toward
  parsing.
- `docs/client-enhancements.md` §8 already evaluated `<datalist>` for
  suggesting *values* and rejected it: `datalist` matching is prefix-only,
  and `#filter` holds a whole DSL clause, not a bare value — no clean way to
  datalist-suggest just the trailing value token of a compound string.
- Column names are a different, narrower case: a closed, known list (already
  fetched via `/tables/data`'s `columns` field) with no compound-expression
  ambiguity if scoped to "suggest a column name when the input is empty or
  ends right after whitespace/AND/OR." That's a much smaller, `<datalist>`-shaped
  problem than value-autocomplete.

**Resolution:** `#filter` now has `list="filter-columns"` pointing at a
`<datalist>` populated on `oninput`/`onfocus` (`updateFilterSuggestions()`
in `dbviewer.html`, right after `applyFilterClause`). Two constraints made
this work as a *pure* `<datalist>` feature with no custom popover:
- Selecting a native datalist option always replaces the whole input value,
  not just a token — so each `<option>` is built as the *entire* resulting
  string (`textSoFar + columnName`), not the bare column name. That's what
  lets it work after `AND`/`OR` without wiping out what's already typed.
- Suggestions only rebuild exactly at a condition-start boundary (input
  empty/whitespace/`NOT `-only, or ending in `AND `/`OR `/`AND NOT `/`OR NOT
  ` — matching `filter-dsl.md` §2's `logic`/`NOT` grammar positions
  case-insensitively) and only when the cursor is at the end of the text.
  Past that boundary (typing a partial column name), the function
  deliberately does nothing and leaves the existing options in place — the
  browser's own prefix-matching against those already-built full-string
  options narrows the list for free, and once typing moves past a plausible
  column (into an operator/value) none of them match anymore, so the list
  empties itself with no extra tracking needed.
- The boundary check only ever inspects the tail of the raw string for
  those two shapes — it never judges the filter as a whole, so it doesn't
  cross the §7 line against duplicating the server-side parser's
  accept/reject job.

Scope decided as part of this: columns only, not operators or values (both
would reopen the compound-expression/parsing tension this specifically
avoided), and only when the cursor sits at the end of the input (mid-string
edits get no suggestions — a deliberate v1 limit, not an oversight).

---

## 3. A help affordance listing supported operators — **Done**

**Ask:** a "?" or similar indicator surfacing the filter DSL's operator set.

**Impact / constraints:**
- Directly tensions with `ui-guidelines.md` heuristic #10 ("Help and
  documentation"), which is explicitly rated **low weight, by design**: "No
  onboarding tour, no inline help text, no tooltips-as-documentation... a
  dev tool that needs a tutorial has a UI problem, not a docs problem. Don't
  build one to paper over confusing UI — fix the UI instead." That's an
  "agreed" doc taking a deliberate stance against this category of feature.
- A dedicated `?`/cheat-sheet affordance would still mean consciously
  overriding that documented position — not attempted here.

**Resolution:** two changes that surface the operator set without
adding a documentation affordance, so #10 stays intact:
- `#filter`'s placeholder (`src/frontend/dbviewer.html`) now spells out the
  operator set (`= != > < >= <= LIKE ILIKE`, plus `IS [NOT] NULL`) instead of
  the old opaque `column OP value`. It's the same category of hint as a date
  input showing `YYYY-MM-DD` — input-shape guidance, not a tutorial.
- `src/filter.rs`'s "expected operator" parse error now enumerates the valid
  operators instead of just naming the failure. Since heuristic #9 (full
  weight) already commits to surfacing the backend's actual rejection text
  verbatim (`dbviewer.html`'s `#error`), this makes every failed attempt
  teach the operator set in context — leverages an existing full-weight
  heuristic rather than adding a new low-weight one.

Still open: this only covers operator *syntax* discovery through use (typing
something wrong, or reading the placeholder). It doesn't cover keyword
chaining (`AND`/`OR`/`NOT`) precedence or the no-parens restriction — those
would still need `filter-dsl.md` itself, which isn't linked from the UI. A
`?` cheat-sheet remains the only way to make that fully discoverable in-app,
and that's still the open policy question above.

---

## 4. Sort icon UX — **Fixed** (`bd7608e`)

**Ask:** the sort ▲/▼ icons violate a UX principle — which one wasn't
identified yet.

**Resolution:** every `<th>` now always renders a dimmed ↑/↓ (full opacity
on the active column), instead of only the sorted column getting a glyph.
Addresses both candidates below: sortability is now visible before the
first click (recognition), and since a glyph is always reserved, header
widths no longer shift when a different column becomes active.

**My working diagnosis (unconfirmed):** `ui-guidelines.md` names heuristic
#6 ("recognition rather than recall," full weight) and cites "active sort
shown via ▲/▼" as its fulfillment mechanism — but that only marks whichever
column is *currently* sorted. Every `<th>` is clickable (`th.onclick` is
always wired, `cursor: pointer` is set globally on `th`), but nothing
signals "this column is sortable" before the user either hovers or already
has it active. The affordance's *result* is recognizable; the affordance
itself isn't, until you've already used it once.

A secondary, related candidate: the ▲/▼ glyph is appended via
`content: " ▲"` after the header text, so only the actively-sorted column's
`<th>` gets wider — clicking a different column visibly shifts every header's
width. That's more a stability/aesthetic concern (heuristic #8) than #6, and
could be present at the same time as the recognition issue.

**Needs confirmation from the person who raised it** before this becomes a
real design item — the fix differs depending on which principle is actually
in play (persistent subtle sort-affordance on all headers vs. reserving
fixed glyph width to prevent layout shift). Also worth reading alongside
item #9 below (multi-column sort) — if that ever gets built, the sort-icon
design needs to show ordinal position too, not just direction.

---

## 5. Per-table query/filter history

**Ask:** remember previous filters/queries per table.

**Impact / constraints:**
- Collides directly with an existing, deliberate rule: `ui-guidelines.md` R6
  and `frontend-style-guide.md` §6 both bar persisting filter values in
  `localStorage` or the URL, specifically *because* filters can carry data
  values (unlike table/sort/limit, which are just UI shape). "Filter/query
  history" is exactly the case that rule was written to block.
- Two ways to reconcile, not yet decided between:
  - **Session-only, in-memory** (a JS array, cleared on reload) — stays
    fully compliant with R6 since nothing touches persistent storage, but
    "history" disappears on every page refresh, which may or may not satisfy
    the actual ask.
  - **Consciously carve out an exception to R6** for this one feature (e.g.
    persist filter history but flag it clearly as a data-carrying exception,
    maybe with an explicit clear/opt-out) — bigger conversation, since R6 is
    phrased as a blanket rule "so each future feature doesn't re-litigate it
    case by case."
- Either way, this is a scope/policy decision before it's an implementation
  one.

---

## 6. Jump between dev / int / staging environments of the same app

**Ask:** a way to switch environments for the same service, not just between
different sibling services.

**Impact / constraints:**
- No existing config models this. `config.rs`'s `siblings` list
  (`design.md` §7) represents *other services* — each with its own
  independent `dbviewer_url`, `name`, `health_path` — not other environments
  of *this* service. There's no field anywhere for "this app's URL in
  staging" vs. "this app's URL in dev."
- Also brushes against the kill-switch design: `Config::is_enabled()`
  (`config.rs`) is checked once at router construction per environment, and
  production is unrepresentable by design (`PRODUCTION_ALIASES`, rejected at
  parse time). Any env-jump UI has to be careful not to imply or enable
  cross-environment access the backend wouldn't actually allow — e.g. a link
  to a staging instance is fine (it's just a URL, same shape as a sibling
  link), but the UI shouldn't create any impression that Ashurbanipal itself
  is brokering that access.
- Simplest framing: this might just be "siblings, but for the same app" —
  i.e. reuse the sibling list/health-check/link-out mechanism entirely,
  just with a naming convention (e.g. `name: "myapp (staging)"`) rather than
  a new config concept. Worth deciding whether that reuse is good enough or
  whether it deserves its own first-class config shape. See item #10 below
  (dynamic sibling discovery) — both point at the same underlying
  limitation: the sibling list is static, hand-maintained TOML.

---

## 7. Presenting long/big jsonb values

**Ask:** figure out a better way to show large/long jsonb cell values.

**Impact / constraints — three separable pain points:**

1. **Transport size.** `db.rs`'s `row_to_json` casts every column via
   `::text` with no size cap, so a large jsonb value is fully included in
   the `/tables/data` response for *every row on the page*, not fetched
   lazily only when a user clicks to view it. A page of 50 rows with a
   multi-KB/MB jsonb column each could mean a very large response before
   anyone opens anything.
2. **Popover / record-view / payload-dialog readability.** All three
   (`showCellPop`, `buildRecordEntries`, the payload dialog) currently do
   `JSON.stringify(JSON.parse(text), null, 2)` into a flat `<pre>` — no
   collapse/expand, no syntax color, and it's recomputed synchronously on
   every open (not cached), so a genuinely large blob can visibly block the
   main thread.
3. **In-cell truncation quality.** Today it's pure CSS ellipsis
   (`.cell-text { overflow: hidden; text-overflow: ellipsis }`), which cuts
   the raw text mid-token rather than showing something structure-aware like
   `{15 keys}` / `[42 items]`.

**Not a new problem — already logged as deferred, twice:** the top-of-file
comment in `dbviewer.html` ("TODO before v1 done: `@alenaksu/json-viewer`
for jsonb cells (CDN, degraded fallback), Prism highlighting") and
`design.md`/`CLAUDE.md`, which name `@alenaksu/json-viewer` as a planned
CDN-loaded tree-view enhancement, required to degrade gracefully if the CDN
is unreachable (same bar as `ui-guidelines.md` R3). Point 2 above is
substantially "go pick that up." Point 1 is a separate, backend-side
question this doc doesn't currently have an answer for (truncate server-side
+ a follow-up fetch for the full value? leave it and rely on point 2's
tree-view being cheap enough to not matter?). See item #8 below — a diff
viewer, if ever built, would share plumbing with this.

---

## Project-documented deferrals

Not raised in this conversation — found by scanning the rest of the project
(`design.md`, `cdn-research.md`, `client-enhancements.md`) for everything
already on record as deferred/future/out-of-scope-for-now, so it lives next
to the conversation-sourced items above instead of scattered across docs.

### 8. Diff viewer for comparing jsonb values between rows

**Where logged:** `design.md` §9, `cdn-research.md` §3.

**What it is:** the originally-scoped feature — a Monaco-based diff editor
for comparing `jsonb` values between two rows/cells. Deferred to a later
iteration; not built.

**Tidbits:**
- `@pierre/diffs` was evaluated and **ruled out outright**, not just
  deprioritized — its `package.json` declares `react`/`react-dom` as peer
  dependencies and depends on `shiki` for highlighting, which structurally
  conflicts with the single-file, framework-agnostic frontend. Dropped from
  consideration entirely rather than left open to revisit.
- **Monaco** (AMD-loaded via CDN `loader.js`) remains the plan: mature,
  MIT-licensed, framework-agnostic, built-in side-by-side diff mode. It does
  text/line diff on the pretty-printed value, not structural JSON diff — the
  known tradeoff is a heavy download (tens of MB unpacked, though only the
  used pieces are fetched/cached).
- `diff2html` + `jsdiff` is logged as a lighter-weight fallback *if* Monaco's
  payload size becomes a real complaint later — not the primary plan.
- Shares plumbing with item #7 above (both need "pretty-print, then do
  something more sophisticated than a flat popover" for jsonb) — worth
  sequencing together if either gets picked up.

### 9. Multi-column sort

**Where logged:** `design.md` §2 (non-goal), §9 (deferred).

**What it is:** v1 sorts by exactly one column (`state.sort`/`opts.sort` are
singular); multi-column sort is explicitly named as "a future addition,"
not built.

**Tidbits:** touches both layers — backend (`QueryOpts.sort: Option<String>`
would need to become an ordered list, and the SQL `order by` clause built in
`db.rs` would need multiple columns) and frontend (`state.sort`/`order`, the
header click handler, and the ▲/▼ rendering). Directly relevant to item #4
above: a multi-column design needs to show ordinal position per header
(`▲1`, `▲2`), not just direction, which changes that open question's answer.

### 10. Dynamic sibling discovery

**Where logged:** `design.md` §2 (non-goal), §9 (deferred).

**What it is:** siblings are a static, hand-maintained TOML list
(`name`/`dbviewer_url`/`health_path`); no service-registry or k8s-based
auto-discovery of sibling services.

**Tidbits:** the backend-config-side version of the same limitation item #6
above is about — both are "the sibling list can't currently represent
anything dynamic," just at different layers (config source vs. what a
sibling entry can mean).

### 11. Non-Postgres `DbSource` implementations

**Where logged:** `design.md` §2 (non-goal), §5, §9 (deferred).

**What it is:** v1 ships exactly one `DbSource` implementation
(`PgPoolSource`). The trait boundary exists specifically so a
`deadpool-postgres`/`tokio-postgres`/non-Postgres adapter could be added
later without touching route handlers.

**Tidbits:** purely backend/architectural, no frontend surface. Named in
`design.md` §5 as "intentionally the only piece of the crate designed for a
hypothetical future backend; everything else stays concrete to v1's scope" —
worth remembering as the one deliberate exception if a "why isn't everything
this flexible" question ever comes up.

### 12. Sibling health-check caching / background polling

**Where logged:** `design.md` §4 (`GET /siblings`), §9 (deferred, with a
concrete trigger).

**What it is:** `/siblings` currently does parallel per-request HTTP health
checks synchronously (no caching); the frontend polls it every ~15s. The
documented next step, *if* per-request checks turn out too chatty/slow with
many configured siblings, is a background-polled cache at the same 15s
cadence — not a vague someday, a named trigger condition.

**Tidbits:** worth revisiting if/when a real deployment's sibling count
grows large enough that every client's 15s poll fanning out into N parallel
HTTP requests server-side becomes measurable load.

### 13. Column reorder and resize

**Where logged:** `docs/client-enhancements.md` §4b (reorder), §4c (resize).

**What it is:** drag-to-reorder columns and drag-to-resize column width —
the two remaining items from that doc's grid-customization family (column
show/hide, §4a, already shipped).

**Tidbits:**
- Explicitly flagged there as "highest effort-to-payoff ratio; last if at
  all" and "lowest priority on this whole list."
- **Resize** has no native browser primitive (checked and confirmed absent
  as of that doc's research) — would be fully hand-rolled: a drag handle per
  `<th>` driven by Pointer Events, paired with `<colgroup><col>` and
  `table-layout: fixed` for predictable resize math (the table is currently
  `border-collapse: separate`, no `table-layout` set).
- **Reorder** does have a native primitive (HTML Drag and Drop API), plus a
  newer one worth knowing about: `Node.moveBefore()` (Chrome 133+, not yet
  cross-browser) atomically relocates an attached node without a
  remove+reinsert cycle, so in-node state (focus, an open popover) survives
  the move — directly relevant since this file already has a hand-rolled
  focus-preservation shim (`captureTableFocus`/`restoreTableFocus`) built for
  a different case (full re-render) that a column drag wouldn't reuse but
  would parallel.

---

### Lower-level deferrals (code-shape, not user-facing)

Two more exist purely at the implementation level, logged in
`frontend-style-guide.md` §7 / `docs/frontend-refactor-plan.md` — noted here
for completeness, not because they carry any user-visible impact:

- **Container queries** for the `nav`/`main` layout — anticipatory; no
  current complaint about the fixed layout breaking in a real embed. Revisit
  if that changes.
- **Web Components / Shadow DOM** for repeated widgets (status dot, copy
  button, etc.) — too much API surface for roughly five distinct interactive
  pieces today; revisit only if that count grows enough that copy-paste
  duplication becomes an actual, measured problem.

---

## 14. Sticky toolbar (`#toolbar`) vs. the filter syntax-highlight overlay (`#filter-highlight`) — two connected bugs, only one currently fixed

**Status:** in progress. `#toolbar` sticky-pinning (below) is shipped and
confirmed working. The overlay's z-index is currently *not* raised (reverted
on request, to be picked up separately) — so bug B below is back, on
purpose, until this is revisited.

**Background:** `#filter`'s real text is `color: transparent` (only the
caret shows); the actual colored, readable text is drawn by a separate
overlay element, `#filter-highlight`, positioned on top of it via CSS Anchor
Positioning (`position: fixed; position-anchor: --filter-anchor`). This
overlay is what makes the two bugs below linked instead of independent.

**Bug A — the overlay lost track of `#filter` across horizontal scroll.**
`main` (not the viewport) is the actual scroll container. While it was
possible to scroll `main` without `#filter` itself being pinned in any way,
the fixed-position overlay's anchor computation went stale during that
scroll — confirmed visually: the highlighted text rendered near the sidebar
instead of over the real (scrolled) input.

**Bug B — the overlay is invisible once `#toolbar` is sticky-pinned.**
Separately, `#toolbar` (search bar + error message, wrapping `#controls`)
was made `position: sticky; top: 0; left: 0` so it stays in place while
scrolling, both axes — matching the sticky table header. Doing that
correctly requires `#toolbar` to have both an opaque `background: canvas`
(so scrolled rows don't show through it) and an explicit `z-index: 2`
(so it wins stacking over the sticky `thead th`, `z-index: 1`, when the two
meet at the top edge on vertical scroll). `#filter-highlight` has no
z-index of its own (`auto`). Per normal CSS stacking rules, an explicit
z-index always paints above a sibling at `auto`, regardless of DOM order —
so `#toolbar`'s opaque background now paints over the overlay, hiding all
typed filter text. The underlying `#filter` input is unaffected
(fully functional, still selectable) — only the *visible* colored text
disappears, because that text was never really `#filter`'s own; it's the
now-hidden overlay's.

**Why they're connected, not two independent fixes:**
- Pinning `#toolbar` (bug B's cause) is *also* what fixes bug A: once
  `#toolbar` doesn't move on scroll, `#filter` is viewport-invariant, so
  there's nothing left for the fixed-position anchor to mis-track.
- But that same pinning is what breaks visibility (bug B), because it's
  what puts an opaque `z-index: 2` box in front of the overlay.
- So a real fix has to satisfy both at once: keep `#toolbar` sticky-pinned
  (fixes A, needed for the "search bar stays put like the header" ask) *and*
  raise `#filter-highlight`'s z-index above `#toolbar`'s (fixes B). Doing
  only the first (current state) leaves filter text invisible while typing.
  Doing only the second without the first would leave bug A's stale-anchor
  glitch in place.

**Fix for bug B, already proven and ready to reapply:** add
`z-index: 3` to `#filter-highlight`'s rule in `dbviewer.html` (one line,
already implemented and verified once earlier in this backlog's history,
then reverted specifically to decouple it from `#toolbar`'s CSS for
separate reconsideration — not because it didn't work).
