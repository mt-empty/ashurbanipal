# Frontend style guide — maintaining `dbviewer.html`

Status: agreed
Scope: `src/frontend/dbviewer.html`. Governs code *shape* — layout,
structure, naming — as it grows. Complements `ui-guidelines.md` (which
governs *behavior*: what the UI must/must-not do) and the `CLAUDE.md`
invariant that the frontend is one hand-edited file, no build step, no
framework.

The tenets below are already reflected in the current file, not aspirations
for it — treat deviation from any of them in a new change as something a
review should flag.

## 1. File layout (fixed order, top to bottom)

1. `<!doctype>` + a top-of-file comment: what this file is, one line
   pointing at `design.md` §3.1.
2. `<head>`: meta tags, title, then one `<style>` block.
3. `<body>`: structural markup only. No inline `style=` attributes, no
   inline `onclick=`-style attributes — every behavior wire-up happens in
   `<script>`, so there's exactly one place to look for "what does this
   element do."
4. `<script type="module">` at the end of `<body>`, internally ordered:
   a. Constants and state (`API`, `UI_KEY`, the `state` object, its
      load/persist functions).
   b. Generic helpers with no feature-specific knowledge (`$`, `api()`,
      `setStatus()`).
   c. One block per feature, each under a `// ==== Feature name ====`
      banner, containing that feature's render logic *and* its event
      wiring together (locality of behavior).
   d. Bootstrap calls at the very bottom (`loadTables()`, `loadSiblings()`,
      the polling `setInterval`) — nothing else after them.

The payoff: a reviewer with "the bug is in pagination" can jump straight to
the pagination banner instead of reading the whole file top to bottom.

## 2. CSS

- Every rule lives under a `/* ==== */` banner matching the JS section it
  styles.
- Selector convention: `#id` for one-off structural elements, `.class` for
  anything reusable or purely presentational.
- Relative units (`rem`, `%`, `vh`/`vw`) over hard pixel values.
- Repeated colors/spacing are `:root` custom properties (`--border`,
  `--gap`, `--active`, etc.), not literals copy-pasted at each use site —
  makes every future color/spacing change a one-line edit at the
  definition.
- Colors that need to differ by theme use `light-dark()`, keyed off the
  `color-scheme: light dark` already declared on `:root`. Hover/active
  tints derive from `color-mix(in srgb, currentColor N%, transparent)`
  rather than a disconnected magic hex value, wherever that's a genuine fit
  (not a mechanical search-and-replace).

## 3. JavaScript

- **One consistent event-binding style: `.onX =`.** Two legitimate reasons
  to reach for `addEventListener` instead, neither of which applies to most
  wiring in this file: needing a second listener on the same element/event,
  or a non-standardized event whose IDL property doesn't exist on every
  engine (e.g. `onsearch` — Chromium and legacy WebKit expose it, Firefox
  never implemented it, so `.onsearch =` silently no-ops there instead of
  erroring; `$("filter").addEventListener("search", ...)` is the fix and
  works identically everywhere). Don't reach for `addEventListener` without
  one of these two reasons, and note which one inline when you do.
- **Any function that fetches and then mutates shared state must guard
  against out-of-order responses with a per-call token.** Capture a
  monotonic counter at the start of the call (`const token = ++xRequestToken`)
  and check `token !== xRequestToken` before acting on the result, bailing
  out silently if a newer call has since superseded it. This is not
  optional for a new fetch site that touches anything more than one local
  variable — a slower earlier request resolving after a faster later one
  is a real, observed failure mode here (stuck loading spinners, and a
  table's chrome/label disagreeing with the rows actually rendered), not a
  hypothetical. `cvRequestToken` (`showCommonValues`), `loadDataToken`
  (`loadData`), and `siblingsRequestToken` (`loadSiblings`) are the three
  existing instances of this pattern — copy their shape for the next one
  rather than reinventing it.
- **Functions do one thing.** Don't let a function fetch, re-render
  multiple DOM regions, *and* update pager state in one body — split
  fetch/render-header/render-body/update-pager into separate functions even
  if a top-level flow calls them in sequence.
- **No editorializing comments.** A comment earns its place only by
  explaining a non-obvious *why* (a browser quirk, a security invariant, a
  workaround) — never a *what* a well-named function or variable already
  says.
- **Size discipline.** If this file crosses roughly 500 lines, that's the
  signal to question scope before reaching for more structure, not to add
  more of it.

## 4. Prefer the platform over hand-written JS

Before adding a dependency or hand-rolling a widget, check whether a native
HTML/CSS/browser API already does the job. House patterns already in use,
as reference points for the next feature:

- `<dialog>` (`showModal()`) + `closedBy="any"` for anything modal — free
  backdrop, Esc-to-close, focus trap, light-dismiss.
- `<form method="dialog">` to close a dialog, and a plain `<form>` submit
  (not keydown-sniffing) for Enter-to-apply on the filter input.
- CSS Anchor Positioning (`anchor-name` / `position-anchor` /
  `position-try-fallbacks`) for the cell-preview popover, instead of manual
  `getBoundingClientRect()` + clamping math.
- Semantic elements over generic containers: `<search>` for the filter
  controls, `<time datetime="...">` for timestamp cells, `<output>` for
  computed status/page text.
- `<template>` + `content.cloneNode(true)` for repeated DOM (table
  rows/cells), instead of nested `document.createElement()` calls.
- `document.startViewTransition()` (feature-detected) around the table
  re-render, for a free cross-fade instead of an instant swap.

Every one of these must degrade gracefully on an unsupported browser —
same bar as `ui-guidelines.md` R3 sets for CDN loss: a missing nicety, not
a broken page.

## 5. Accessibility baseline

- Every async status has a live-region announcement: `aria-live="polite"`
  for routine status, `role="alert"` for errors.
- Every state conveyed by color also has a non-color equivalent:
  `aria-sort` on sortable headers, `aria-current="true"` on the active
  sidebar table, `aria-label` on icon-only buttons, text alternatives on
  the sibling health dots (never color-only status).
- Every interactive affordance is keyboard-reachable — a real `<button>` as
  the click target, not a bare `onclick` on a `<div>`/`<td>`.
- Focus survives re-renders. Table redraws (`replaceChildren()`) must
  capture and restore focus (or move it somewhere stable), never let it
  silently fall through to `<body>`.

## 6. State and URLs

- `localStorage` and the URL (`history.replaceState()`) persist UI *shape*
  only — table, sort, order, limit, offset. Never filter values (they can
  carry data) or row data — this boundary applies to every persistence
  mechanism, not just `localStorage` (`ui-guidelines.md` R6).
- Stale or malformed persisted state (an unknown table, unparseable JSON)
  resets silently to the default view. It never wedges the UI or errors.

## 7. What not to introduce

- No bundler, no JSX, no TypeScript-flavored comments, no UI framework.
- No inline event-handler attributes in HTML markup (`<button
  onclick="...">`).
- **Web Components / Shadow DOM** for repeated widgets (status dot, copy
  button) — too much API surface for roughly five distinct interactive
  pieces; revisit only if that count grows enough that copy-paste
  duplication becomes an actual, measured problem.
- **Client-side filter validation** — would duplicate the server-side
  parser's job (accepting or rejecting arbitrary filter text) in a second
  place that can drift from it. The filter DSL's parser is deliberately
  server-side-only; see `filter-dsl.md`. This doesn't cover
  `quoteFilterValue()`/`applyFilterClause()` (click-to-filter, FK cell
  navigation, the common-values dropdown) — those *compose* a clause from a
  column/value the server already gave us into valid syntax; they never
  parse or judge arbitrary user-typed text, so there's no accept/reject
  decision to drift. Their quoting output still has to agree with
  `filter-dsl.md` §2, though — see that document's §6 for the specific
  cases to check once the parser exists.
- **`@scope`** — the file already gets rule-scoping for free from its
  ID-selector discipline; no cascade-leakage problem to solve.
- **`requestIdleCallback` / `scheduler.postTask()`** — no measured
  performance problem; `ui-guidelines.md` R7 already bounds page size.
- **Container queries** for the `nav`/`main` layout — anticipatory; no
  current complaint about the fixed layout breaking in a real embed.
  Revisit if that changes.
