# Frontend style guide — maintaining `dbviewer.html`

Status: agreed
Scope: `src/frontend/dbviewer.html`. Governs code *shape* — layout,
structure, naming — as it grows. Complements `ui-guidelines.md` (which
governs *behavior*: what the UI must/must-not do) and the `CLAUDE.md`
invariant that the frontend is one hand-edited file, no build step, no
framework.

## Why a project-specific doc instead of adopting one wholesale

Searched for an existing standard before writing this. Two kinds exist, and
neither fits alone:

- **Mainstream JS/CSS style guides** (Google's, Airbnb's) assume a module
  system — file-per-class, imports, a bundler. Most of their *formatting*
  and *naming* rules transfer fine to a single `<script>` block; their
  *file-organization* rules don't apply, because there's only one file by
  design.
- **Single-file/no-build HTML tools** are a real, named pattern — Simon
  Willison documents building ~150 of them (CDN dependencies loaded at
  runtime, `localStorage` for state, keep each tool to "a few hundred
  lines") — but that writeup optimizes for fast one-off generation, not
  long-lived review. It doesn't prescribe internal section structure,
  because most of those tools are never revisited by a second person.

This project is both: single-file *and* long-lived, code-reviewed, and
maintained by more than one person (including future sessions with no
memory of this one). That combination is what needs its own rules.

Sources consulted:
- [Google HTML/CSS Style Guide](https://google.github.io/styleguide/htmlcssguide.html) — formatting baseline (relative units, selector conventions).
- [Simon Willison — Useful patterns for building HTML tools](https://simonwillison.net/2025/Dec/10/html-tools/) — single-file/no-build conventions (CDN-as-enhancement, `localStorage` for state, size discipline). This project already independently converged on the same CDN/localStorage patterns via `design.md`/`ui-guidelines.md`, which is a good sign they're the right defaults for this shape of tool.
- [Airbnb JavaScript Style Guide](https://github.com/airbnb/javascript) — general function-size and naming conventions (module/import-specific rules excluded as not applicable).
- [Chrome for Developers — Introducing the CSS anchor positioning API](https://developer.chrome.com/blog/anchor-positioning-api) and [MDN — position-try-fallbacks](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/position-try-fallbacks) — syntax and browser-support basis for §4's anchor-positioning recommendation.
- [web.dev — `<dialog>` and popover: Baseline layered UI patterns](https://web.dev/articles/baseline-in-action-dialog-popover) and [MDN — HTMLDialogElement.closedBy](https://developer.mozilla.org/en-US/docs/Web/API/HTMLDialogElement/closedBy) — `<form method="dialog">` and `closedBy` support basis for §4.
- [MDN — ARIA: aria-sort attribute](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-sort), [MDN — `<time>` element](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/time), and [MDN — `field-sizing`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/field-sizing) — correctness and support basis for §5.
- [MDN — `<search>` element](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/search), [MDN — JavaScript modules](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules), and [MDN — `color-mix()`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/color_value/color-mix) — support basis for the second §5 sweep (landmark element, module-script semantics and the `file://` caveat, color derivation).
- [web.dev — Same-document view transitions are now Baseline Newly available](https://web.dev/blog/same-document-view-transitions-are-now-baseline-newly-available) — support basis for §6's View Transitions recommendation. Willison's article (already cited above) is also the direct source for §6's URL-state-persistence finding, not just the earlier CDN/localStorage patterns.

## 1. File layout (fixed order, top to bottom)

1. `<!doctype>` + a top-of-file comment: what this file is, one line
   pointing at `design.md` §3.1. Already present — keep it current as
   features get added.
2. `<head>`: meta tags, title, then one `<style>` block.
3. `<body>`: structural markup only. No inline `style=` attributes, no
   inline `onclick=`-style attributes — every behavior wire-up happens in
   `<script>`, so there's exactly one place to look for "what does this
   element do."
4. `<script>` at the end of `<body>`, internally ordered:
   a. Constants and state (`API`, `UI_KEY`, the `state` object, its
      load/persist functions).
   b. Generic helpers with no feature-specific knowledge (`$`, `api()`,
      `setStatus()`).
   c. One block per feature, each under a `// ==== Feature name ====`
      banner, containing that feature's render logic *and* its event
      wiring together (locality of behavior — a reviewer touching the
      copy-button feature shouldn't have to jump to a different part of
      the file to find where it's attached).
   d. Bootstrap calls at the very bottom (`loadTables()`, `loadSiblings()`,
      the polling `setInterval`) — nothing else after them.

The payoff: a reviewer with "the bug is in pagination" can jump straight to
the pagination banner instead of reading the whole file top to bottom.

## 2. CSS

- Every rule lives under the same `/* ==== */` banner convention as the JS
  section it styles — not just the "extra" features. Right now the
  dialog/popover rules have banners and the base layout/table/nav rules
  (top of `<style>`) don't; that's inconsistent and should be fixed rather
  than copied forward.
- Selector convention: `#id` for one-off structural elements, `.class` for
  anything reusable or purely presentational. Already followed in
  practice — stated explicitly here so it doesn't drift as the file grows.
- Relative units (`rem`, `%`, `vh`/`vw`) over hard pixel values, per
  Google's guide. Already the case throughout.

## 3. JavaScript

- **One consistent event-binding style.** Pick `.onX =` properties (the
  current majority) *or* `addEventListener` — not a mix without a stated
  reason. Two spots currently use `addEventListener` (the payload dialog's
  backdrop click, the filter box's Enter-key handler) while everything else
  uses `.onclick =`, with no comment explaining why those two are
  different. Standardize on `.onX =`, since nothing in this file ever
  needs a second listener on the same element/event — the one legitimate
  reason to prefer `addEventListener`.
- **Functions do one thing.** A function that fetches, re-renders three
  separate DOM regions, and updates pager state in a single body is a
  single point every future change has to re-read in full to touch any
  part of it. Split fetch / render-header / render-body / update-pager
  into separate functions, even if the top-level flow still calls them in
  sequence.
- **No editorializing comments.** Already the house rule (`CLAUDE.md`),
  restated here because it's easy to forget under UI work specifically: a
  comment earns its place only by explaining a non-obvious *why* (a browser
  quirk, a security invariant, a workaround) — never a *what* a
  well-named function or variable already says.
- **Size discipline.** If this file crosses roughly 500 lines, that's the
  signal to question scope before reaching for more structure — in line
  with Willison's few-hundred-line guidance for single-file tools. It's
  comfortably under that today; this is a tripwire, not a current problem.

## 4. Prefer the platform: modern HTML/CSS over hand-written JS

The single biggest lever for keeping this file small and reviewable isn't
stricter JS conventions — it's not writing JS the platform already does
for you. Checked each of these against current (mid-2026) baseline support
before listing it; none are speculative.

- **CSS Anchor Positioning for the cell-preview popover.** `showCellPop()`
  currently computes its position by hand — `getBoundingClientRect()` plus
  manual `Math.max`/`Math.min` viewport clamping. That's exactly what
  [Anchor Positioning](https://developer.chrome.com/blog/anchor-positioning-api)
  does natively: give the clicked cell an `anchor-name` (set via
  `element.style.anchorName`, since it's a different element every click),
  declare `position-anchor` + `position-try-fallbacks: flip-block,
  flip-inline` on `#cell-pop` in CSS, and the browser handles both
  placement *and* flipping away from the viewport edge — no clamping math
  left in JS at all. Support: Chrome/Edge 125+, Firefox 147+, Safari 26+
  (~83–91% of traffic as of mid-2026). **Accepted tradeoff:** on
  unsupported browsers the unrecognized CSS is simply ignored and the
  popover falls back to its default position — degraded placement, not a
  broken feature, which is the same bar `ui-guidelines.md` R3 already
  sets for CDN loss. JS still owns opening the popover and filling its
  content; only the positioning math goes away.
- **`<form method="dialog">` for the payload dialog's close button.**
  Replaces `$("payload-close").onclick = () => $("payload-dialog").close()`
  with a plain `<button type="submit">` inside a form whose `method` is
  `dialog` — submitting it closes the dialog with zero JS. Fully baseline,
  no tradeoff.
- **`closedBy="any"` on `<dialog>` for click-outside dismiss.** Replaces
  the manual `addEventListener("click", ...)` backdrop-detection on
  `#payload-dialog`. Not yet baseline (Safari is catching up via Interop
  2026), but safe to adopt now regardless: if unsupported, the dialog just
  keeps requiring Esc or the close button — both already work everywhere,
  independent of this attribute — so the failure mode is "one convenience
  missing on older Safari," not breakage.
- **Wrap `#filter` + `#apply` in a `<form>`.** Replaces the manual
  `$("filter").addEventListener("keydown", e => { if (e.key === "Enter")
  ... })` with native form-submit-on-Enter — the browser already does this
  for a single-text-input form. The submit handler still needs one line of
  JS (`e.preventDefault()` + trigger the fetch), but the keycode-sniffing
  goes away, and it resolves the event-binding inconsistency §3 already
  flags, for free.

Together, these remove *both* `addEventListener` call sites §3 flags as
inconsistent — not by converting them to `.onX =`, but by making the
browser handle what they were working around. Prefer that outcome over a
style-only fix whenever a platform feature actually replaces the need for
the handler, not just its syntax.

- **`light-dark()`** (Baseline Newly Available, May 2026) pairs with the
  `color-scheme: light dark` already declared on `:root` — no setup
  needed, it'd work the moment it's used. Syntax: `property:
  light-dark(<light-value>, <dark-value>)`, resolved per the nearest
  ancestor's `color-scheme`.

  Most of the file's coloring doesn't need this — the alpha-blended
  grays (`#8884`, `#8886`, etc.) already self-adjust reasonably against
  either a light or dark canvas, because they're transparency over
  whatever's underneath rather than a fixed color. But a handful of
  *opaque*, fixed colors never get reconsidered per mode, and one of
  them is a real (if minor) defect, not just a missed nicety:
  - `dialog::backdrop { background: #0006; }` — 40% black dims a light
    page correctly, but on an already-dark page it barely darkens
    anything, so the modal loses the visual separation it's supposed to
    create. `light-dark(#0006, #0009)` fixes this specifically.
  - `.dot.up`/`.dot.down` (`#2a2`/`#d33`), `#error { color: #d33; }`,
    `li button.active { background: #08f2; }` — flat colors picked once,
    never revisited for dark-mode contrast. Lower stakes than the
    backdrop (still legible either way), but the same fix shape.

  Net: worth adopting for the backdrop case specifically; the other four
  are opportunistic — fine to fix in the same pass since they're the same
  one-line change each, not worth a separate pass on their own.

- **Container queries** (baseline since 2023): `container-type:
  inline-size` on an ancestor, then `@container (condition) { ... }` on
  descendants, instead of `@media`.

  The reason this is a `@container` case specifically, not just generic
  "add responsive design" — `@media` measures the *browser viewport*,
  which is the wrong signal for Ashurbanipal. It's mounted inside a host
  page (`design.md`'s core goal) at whatever width the host gives it: a
  panel, an iframe, a narrow admin sidebar. The page can be full-viewport
  width while Ashurbanipal itself only occupies a 400px column of it.
  `@container` measures the element's own box, which is the signal that's
  actually correct for an embedded widget — this is a `design.md`-goals
  reason, not a general CSS-modernity one.

  Today's layout has zero adaptation at any size:
  `body { display: grid; grid-template-columns: 220px 1fr; height: 100vh; }`.
  Shape it'd enable: `container-type: inline-size` on `body`, then
  something like `@container (width < 500px) { body {
  grid-template-columns: 1fr; } nav { ...collapse... } }` so a narrow
  embed doesn't force the 220px nav to eat most of the available width.

  No one has reported the fixed layout actually breaking in a real embed
  yet, so this stays anticipatory rather than urgent — but it's the
  correct primitive to reach for *when* that happens, not `@media`.

## 5. Table, form, and status semantics

Distinct from §4: these aren't cases of JS standing in for a CSS/HTML
feature that didn't exist — they're places the file uses a generic element
(`<td>`, a bare color, a CSS class) where a more specific one already
carries the right meaning for free, mostly for assistive-tech users the
manual testing in this project (curl + eyeballing) structurally can't
catch. Two are real defects, not enhancements — flagged as such rather
than lumped in with the "nice to have" items.

- **`aria-sort` instead of a `.sorted`/`.sorted.desc` class pair.** MDN:
  the attribute goes on the header cell itself, with values `ascending` /
  `descending` / `none` / `other`, and only one header carries a
  non-`none` value at a time — which is exactly the invariant
  `loadData()`'s sort logic already maintains by construction (one
  `state.sort` at a time). This replaces the class toggle with the
  attribute AT actually understands, and `th.sorted::after` /
  `th.sorted.desc::after` becomes `th[aria-sort="ascending"]::after` /
  `th[aria-sort="descending"]::after` — same visual result, no class
  bookkeeping duplicated in two places (JS state *and* a CSS class name)
  for one fact.
- **`aria-current="true"` on the active table's sidebar button.** Right
  now "which table is selected" is a `.active` CSS class only —
  sighted-mouse-user information, invisible to a screen reader. Adding
  `aria-current="true"` alongside the existing class (CSS still needs its
  own hook for the visual highlight) costs one line in the same
  `classList.toggle` call site and makes the selection state actually
  announced. Lighter-weight than converting the sidebar to a full
  `listbox`/`option` ARIA pattern, which isn't warranted here.
- **Sibling health dots convey status by color alone — a real defect,
  not an enhancement.** `.dot.up`/`.dot.down` is green-vs-red with no text
  alternative; a color-blind or screen-reader user gets nothing. This
  predates and is independent of anything "modern" — it's a baseline
  accessibility bug (color-only status, the textbook WCAG 1.4.1 case) that
  happens to have a one-line fix: an `aria-label` (`"healthy"` /
  `"unhealthy"`) or visually-hidden text next to the dot.
- **The expandable `<td>` has no keyboard path — also a real defect.**
  `td.onclick = ...` opens the cell-preview popover for mouse users only;
  there's no `tabindex`, no keydown handling, so keyboard-only users can't
  reach it at all. The fix isn't "add `tabindex` and a keydown listener"
  (a patch that re-invents what a button already does) — it's using an
  actual `<button>` as the click target inside the cell (matching what the
  copy button already does correctly one element over), which gets
  focusability, `Enter`/`Space` activation, and correct semantics for
  free. Direct application of `ui-guidelines.md` R2 ("native elements
  before libraries") to this project's own accessibility gap, not just to
  library-avoidance.
- **The copy button's label isn't reliably announced.** `title="copy
  cell"` alone is inconsistent across screen readers; `aria-label="copy
  cell value"` is the correct fix, and the file already knows this pattern
  — `payload-close` uses `aria-label="close"` correctly one element over.
  This is purely an internal-consistency gap, not a new concept to
  introduce.
- **`type="search"` + `enterkeyhint="search"` on `#filter`.**
  Long-baseline, zero-risk: gets a native clear-button affordance and a
  mobile keyboard whose Enter key is labeled "search" instead of
  "go"/"done", purely by changing two attributes on an element that
  already exists. Pairs naturally with a `<datalist>` of the current
  table's column names for autocomplete — genuinely native (no JS
  framework, satisfies R2) and directly serves the error-prevention
  heuristic `ui-guidelines.md` §1 already gives full weight (Nielsen #5 —
  not to be confused with rule R5, which is about persisted-state
  recovery, a different concern) — but autocomplete is a new *feature*,
  not a modernization of existing code, so it's noted here rather than
  promoted to §8.
- **`<search>` landmark around `#controls`.** Baseline Widely Available as
  of April 2026. Wrapping the filter input + apply button in `<search>`
  instead of a generic `<div>` gives it an implicit ARIA `search` landmark
  role for free — a screen-reader user can jump straight to it, same as
  `<nav>` already does for the sidebar. One element swap
  (`<div id="controls">` → `<search id="controls">`), no behavior change.
- **`<time datetime="...">` for `timestamptz`/`date` cell values.** Purely
  semantic — wrap the existing displayed text in `<time
  datetime="{raw ISO value}">` rather than a bare `<span>`. No visible
  change, no new behavior; it's the correct element for machine-readable
  date/time content per MDN, and it's free groundwork if relative-time
  display (`Intl.RelativeTimeFormat`) or hover-for-absolute-time ever gets
  added later.
- **`field-sizing: content` on `#filter`.** Lets the input grow with
  longer filter queries instead of staying a fixed width — genuinely
  useful given the DSL supports chained `AND`/`OR` conditions that can run
  long. This is Baseline Newly Available as of June 2026 (Firefox 152 was
  the last engine to land it) — a few weeks old at the time of writing,
  not years. Recommending it anyway: this project already treats
  enhancement-vs-dependency as the right lens (`ui-guidelines.md` R3,
  written for CDN loss but the same logic applies to CSS property
  support) — an unsupported `field-sizing` value is simply ignored by
  older engines and the input keeps its ordinary fixed width, so there's
  no broken state to worry about, only "this specific nicety doesn't
  apply yet everywhere." That's exactly the risk profile this doc has
  already decided is worth taking (see `closedBy="any"` in §4). No reason
  to hold back on recency alone when the failure mode is this graceful.
- **CSS custom properties — currently unused, and the real prerequisite
  for doing `light-dark()`/`color-mix()` properly.** The file has zero
  `--custom-properties` today; colors and spacing are repeated literals
  (`#8884` appears five separate times, `.5rem`/`.75rem` gaps repeated
  throughout). Before adding more per-rule `light-dark()` calls per §4,
  the one-time move that pays for itself immediately is hoisting the
  repeated values to `:root` custom properties once — `--border: #8884;`,
  `--gap: .5rem;`, etc. — then every `light-dark()` fix from §4 is a
  single-line change at the definition instead of N separate edits at
  each use site. Sequencing note for §8: do this *before*, not after, the
  `light-dark()` backdrop fix, since it changes where that fix lands.
- **`color-mix()`** (Baseline Widely Available since May 2023, ~89%+
  support) pairs with the custom-properties point above: hover/active
  states like `.copy:hover { background: #8882; }` or `li button.active {
  background: #08f2; }` are hand-picked alpha values with no relationship
  to each other. `color-mix(in srgb, currentColor 12%, transparent)`
  derives a hover tint from the surrounding text color instead of a
  disconnected magic hex value — same visual idea, one fewer arbitrary
  constant to maintain. Lower priority than the custom-properties move
  itself; only worth doing where it actually replaces a literal, not as a
  search-and-replace exercise.
- **`<script type="module">` instead of the manual `"use strict";`
  line.** Module scripts are strict-mode by default, deferred by default,
  and get their own top-level scope — the `"use strict"` string becomes
  redundant, not a functional change (the script already runs at the end
  of `<body>`, so the automatic deferral changes nothing observable
  today). One real caveat, checked and ruled out: module scripts can't be
  loaded from a bare `file://` URL, which is exactly why Simon Willison's
  copy-paste-and-open-locally HTML tools (see the intro above) can't use this — but
  Ashurbanipal is never opened as a static file, only ever served by the
  Rust backend's own route, so that caveat doesn't apply here. Worth
  doing for correctness/intent-signaling, not because anything is broken.
- **`:has()`** (Baseline since December 2023) — checked for a genuine use
  in this file and didn't find a strong one. Noted for completeness rather
  than forced into a recommendation; the honest answer is this file
  doesn't currently have the kind of parent-depends-on-child styling
  problem `:has()` solves. Revisit if one shows up.

## 6. Further sweep: interaction correctness, state architecture, and multi-instance polish

§4/§5 were "existing JS or a generic element where a platform feature
already fits." This pass looks past individual elements at how the pieces
interact — and turns up two real defects nothing so far has caught,
because they only show up from *use*, not from reading any single line in
isolation.

- **Focus is silently lost on every re-render — a real defect, not a nicety.**
  `thead.replaceChildren(tr)` and `tbody.replaceChildren(...)` in
  `loadData()` unconditionally tear down and rebuild those subtrees. If
  focus was anywhere inside them — a keyboard user tabbed to a copy
  button, or (once §5's fix lands) the new cell-expand button — it's now
  attached to a detached node, and focus silently falls back to
  `<body>`. This isn't an edge case: it happens on *every* sort click,
  page change, and filter apply, for any keyboard user. Fix doesn't need
  a library: capture what was focused before the replace and restore
  focus to its equivalent in the new render, or at minimum move focus
  somewhere stable and sensible (the `<table>` itself, or `#current`)
  instead of letting it fall through to `<body>` by accident.
- **`#error` isn't announced to screen readers — `#status` does this
  right, `#error` doesn't.** `#status` already has `aria-live="polite"`;
  `#error` has neither that nor `role="alert"`. An error is exactly the
  case that needs an *assertive* announcement (the user needs to know
  now — a rejected filter, a failed fetch), not a polite one, so
  `role="alert"` (which implies `aria-live="assertive"`) is the correct,
  one-attribute fix. Same shape as the copy button's missing
  `aria-label` in §5: the file already has the right pattern one element
  over, just didn't apply it consistently to this one.
- **Shareable/bookmarkable state via the URL, not just `localStorage`.**
  This is literally in the source already cited for this doc — Willison's
  article recommends "URL-based persistence... for bookmarkable, shareable
  tool configurations" — and this project only implemented the
  `localStorage` half of that advice. Today, `?table=orders&sort=
  created_at&order=desc` isn't reconstructable from any URL Ashurbanipal
  produces; "hey, check the orders table sorted by date" can't be a link,
  only a set of verbal instructions. Fix: mirror `state.table` / `sort` /
  `order` / `limit` / `offset` into the URL via `history.replaceState()`
  on every `loadData()` call.

  **`filter` stays excluded — extending the boundary `ui-guidelines.md`
  R6 already draws for `localStorage`, not re-deciding it per storage
  mechanism.** R6 keeps filters out of `localStorage` because they can
  carry data values; a URL is *more* exposed than `localStorage`, not
  less — URLs get written to browser history, proxy and server access
  logs, and the `Referer` header on any outbound link. The same boundary
  should hold for every future persistence mechanism, not just
  `localStorage` specifically: state R6 already excludes stays excluded
  everywhere, as a standing rule, so this doesn't need re-litigating the
  next time a third mechanism shows up.
- **Pagination and sort don't reset scroll position.** `main { overflow:
  auto }`, and nothing in `loadData()` resets scroll after a successful
  render. Scroll down a long result table, click "next," and the new
  page renders at whatever scroll offset the *old* page happened to be
  at — which can land the viewport mid-table or past the end of the new
  data. `main.scrollTo({ top: 0, behavior: "smooth" })` after render is a
  one-line, long-baseline fix.
- **`document.title` never changes.** It's always "Ashurbanipal," even
  though the sibling-navigation feature exists specifically so people hop
  between instances (`design.md`'s own stated goal) — exactly the
  workflow where several browser tabs of this same tool, pointed at
  different services, become indistinguishable. `document.title =
  \`${state.table} — Ashurbanipal\`` on table change is a one-line fix for
  a problem this project's own design goals create.
- **No favicon.** Same underlying gap as the title issue — an inline
  `data:` URI SVG favicon (no external asset, keeps the single-file
  constraint intact) gives multiple open instances a visual anchor in a
  tab strip beyond text alone.
- **Sibling links navigate away in the current tab — reconsider
  `target="_blank"` + `rel="noopener"`.** `design.md`'s stated goal is
  "quick navigation across a multi-service architecture," but a same-tab
  `<a href>` click means abandoning the table you were looking at
  entirely just to check a sibling, recoverable only via browser Back.
  Opening sibling links in a new tab preserves the current session;
  `rel="noopener"` is the standard, required companion for any
  `target="_blank"` link to a URL this page doesn't fully control
  (otherwise the opened page gets a live handle back via
  `window.opener`).
- **`<template>` for row/cell construction — the single biggest
  JS-simplification opportunity in the file.** The row-rendering loop
  (the `renderRows()` split-target from §3/§8) builds every `<td>`, the
  copy `<button>`, and the cell-text `<span>` through nested
  `document.createElement()` calls — the least declarative, hardest-to-
  visually-parse code in the file. A `<template>` holding the static
  shape of one cell, cloned per cell via `content.cloneNode(true)`,
  separates "what a cell looks like" (HTML, readable at a glance) from
  "which cells exist and what's in them" (JS, a plain loop with no
  DOM-construction verbs cluttering it). Baseline forever — not a
  recency question at all, just a feature that's been sitting unused
  relative to how much it would clean up the file's messiest function.
- **`<output>` instead of `<span>` for `#status`/`#page`.** Both
  represent the result of a computation (loading state, current page
  number), not arbitrary inline text — `<output>` is the element that
  actually means that, baseline forever, zero behavior change from
  swapping the tag.

One progressive enhancement, checked and genuinely safe despite being
recent — same spirit as `field-sizing` in §5:

- **View Transitions API for the table re-render.** Same-document view
  transitions reached Baseline Newly Available in October 2025 — Chrome/
  Edge 111+, Safari 18+, Firefox 144+ — and the API is *designed* to
  degrade to an instant swap when unsupported (feature-detect with
  `document.startViewTransition ? ... : ...`; it's simply absent on
  older engines, not an error). Wrapping the `thead`/`tbody` replacement
  in `document.startViewTransition(() => { ...existing render... })`
  would soften the currently-instant swap on every sort/page/filter
  change into a cross-fade, at effectively zero code cost, and meets the
  same "enhancement, not dependency" bar `ui-guidelines.md` R3 already
  sets. Sequencing note: do this *after* the focus-loss fix above and the
  §3/§8 function split, not before — wrapping a 90-line function in a transition
  callback makes it harder to split apart later, not easier.

## 7. What not to introduce

- No bundler, no JSX, no TypeScript-flavored comments, no UI framework —
  restating the `CLAUDE.md` invariant because every rule above is designed
  around it holding.
- No inline event-handler attributes in HTML markup (`<button
  onclick="...">`) — see §1.3.
- **Web Components / Shadow DOM for repeated widgets** (status dot, copy
  button). Considered and rejected: the file has roughly five distinct
  interactive pieces total. Wrapping them as custom elements means
  adopting a whole API surface (`customElements.define`, lifecycle
  callbacks, shadow-DOM style encapsulation) to remove less duplication
  than the `<template>` fix above already removes on its own. Revisit
  only if the widget count grows enough that copy-paste duplication
  becomes the actual, measured problem — not preemptively.
- **Client-side filter validation** (`:user-invalid`, a JS-side DSL
  pre-check). Considered and rejected for a stronger reason than the
  others: it would directly contradict a deliberate project decision, not
  just add unneeded code. The filter grammar was explicitly scoped as
  "server side is responsible for sanitization, no need to complicate
  things" — client-side validation duplicates the parser's job in a
  second place that can silently drift from the real one.
- **`@scope`.** The file already gets rule-scoping for free from its
  ID-selector discipline (§2); `@scope` solves cascade leakage across
  component boundaries, which isn't a problem this file currently has.
- **`requestIdleCallback` / `scheduler.postTask()`** for deferring the
  overflow-detection `requestAnimationFrame` loop. No evidence this is
  slow, and `ui-guidelines.md` R7 (bounded rendering) already caps page
  size at a level where it likely isn't — would be optimizing an
  unmeasured, probably nonexistent problem.

## 8. Concrete refactor targets in the current file

Logged here so the guide isn't purely aspirational — these are the actual
violations found while writing it, as of this commit:

- `loadData()` is one ~90-line function mixing: error/active-state reset,
  building the fetch params, the fetch itself, header render, body render
  (rows vs. the empty-state branch), post-layout overflow marking, and
  pager update. Split target: `fetchTableData()`, `renderHeader()`,
  `renderRows()` / `renderEmptyState()`, `updatePager()`.
- Event-binding inconsistency: the two `addEventListener` call sites (the
  payload dialog's backdrop click, the filter box's Enter key) should be
  eliminated per §4 — `closedBy="any"` and wrapping the filter in a
  `<form>`, respectively — not just converted to `.onX =`.
- The manual positioning math in `showCellPop()` (`getBoundingClientRect()`
  + `Math.max`/`Math.min` clamping) should move to CSS Anchor Positioning
  per §4.
- The payload dialog's close button (`$("payload-close").onclick`) should
  become a `<form method="dialog">` submit button per §4.
- **Do this one first, before any other CSS item below:** hoist the
  repeated literals (`#8884` ×5, the `.5rem`/`.75rem` gaps, etc.) to
  `:root` custom properties per §5. Every other CSS fix in this list
  becomes a smaller, cleaner diff once it exists — do it before, not
  after.
- `dialog::backdrop { background: #0006; }` under-dims dark-mode pages —
  a real (minor) legibility defect, not just a missed enhancement. Fix
  with `light-dark(#0006, #0009)` per §4 (as a custom property, per the
  point above); worth doing the other four flat-color spots
  (`.dot.up`/`.dot.down`, `#error`, `li button.active`) in the same pass
  since it's the same one-line change each.
- CSS section banners: add `/* ==== */` headers to the base layout/table/nav
  rules to match the dialog/popover blocks that already have them.
- Two genuine accessibility defects, per §5, not stylistic preferences:
  the sibling health dots convey up/down by color alone (no text
  alternative), and the expandable-cell `<td>` has no keyboard path at
  all (mouse-only). Both predate this doc and aren't "modernization" so
  much as bugs that a modern-HTML fix happens to resolve cleanly.
- `aria-sort`, `aria-current`, and the copy button's `aria-label` (§5) are
  all one-line additions to code paths that already exist — no new
  render logic, just attributes the existing DOM-construction code isn't
  setting yet.
- Attribute/element swaps with no behavior change, batchable in one pass:
  `type="search"` + `enterkeyhint="search"` on `#filter`, `<div
  id="controls">` → `<search id="controls">`, `field-sizing: content` on
  `#filter`, and `<script>` → `<script type="module">` (drop the now-
  redundant `"use strict";`).
- Two more real defects, per §6, on top of the two in §5 — none of these
  four are stylistic preferences: focus is silently dropped to `<body>`
  on every table re-render (no library needed to fix — capture and
  restore, or anchor focus somewhere stable), and `#error` isn't
  announced to screen readers (`role="alert"`, matching the
  `aria-live="polite"` `#status` already gets right one element over).
- State-persistence gap: `state.table`/`sort`/`order`/`limit`/`offset`
  should mirror into the URL via `history.replaceState()` per §6, making
  views shareable/bookmarkable — `filter` stays out, extending
  `ui-guidelines.md` R6's boundary rather than re-deciding it.
- Multi-instance polish, all one-line, all tied to `design.md`'s own
  sibling-navigation goal: `document.title` should reflect the current
  table, an inline `data:` SVG favicon should exist, `main.scrollTo({top:
  0})` should run after a paginate/sort re-render, and sibling `<a>`
  links should get `target="_blank" rel="noopener"` so checking a sibling
  doesn't abandon the current view.
- `renderRows()` (the split-target from earlier in this list) should be
  built from a `<template>` + `cloneNode(true)` per §6, not nested
  `document.createElement()` calls — the single largest legibility win
  available in the file. `#status`/`#page` should be `<output>`, not
  `<span>`.
- Once the above settles, `document.startViewTransition()` around the
  `thead`/`tbody` replacement (§6) is a good last step — explicitly
  sequenced last because it wraps the function everything else here is
  busy splitting apart.
