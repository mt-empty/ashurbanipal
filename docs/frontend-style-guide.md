# Frontend style guide — building `dbviewer.html`

Status: agreed
Scope: `frontend/src/`, the TypeScript/CSS/HTML sources
`frontend/dbviewer.html` is generated from (`mise run frontend:build`).
Governs code *shape* — module boundaries, layout, naming — as it grows.
Complements `ui-guidelines.md` (which governs *behavior*: what the UI
must/must-not do) and the `CLAUDE.md` invariant that the *shipped*
`frontend/dbviewer.html` stays one generated, self-contained file — this
doc is about the sources that build it, not an exception to that
invariant.

The tenets below are the target shape for the sources. Most current code
follows them; where a tenet is ahead of the code, that gap is called out
inline, and new code still complies. A tenet's authority is that it is
right for the project as it stands, not that it happens to describe today's
code — so when the two disagree, fix the code or change the tenet
deliberately, don't let the guide drift to match an accident. Treat a new
deviation as something review flags.

## 1. Source layout (`frontend/src/`)

`src/` is grouped into four role-based layers plus `demo/`. Imports only
ever point *down* this list; `frontend:check-cycles` fails CI on any
value-import cycle, which a back-edge would create.

```
src/
  index.html   styles.css
  bootstrap/   main, controller, reload, table-focus
  features/    grid, filter-ui, sidebar (+ sidebar-resize, sidebar-bounds),
               nav, record-view, siblings, api-reference, theme
  core/        api, dom, types, state (+ store, url, row-diff)
  lib/         filter-dsl, json-tree, format
  demo/        demo-shim, demo-fixtures — offline demo backend only
```

- `bootstrap/` wires the app and owns render orchestration. `main.ts` is
  *wiring only*: side-effect imports, `registerLoadData(loadData)`, the
  toolbar/dialog event wiring, and the bootstrap calls at the bottom
  (`loadSources().then(loadSchemas).then(loadTables)`, `loadSiblings()`,
  the polling `setInterval`). `controller.ts` owns `loadData` /
  `fetchTableData`; it imports feature modules *downward* and they never
  import it (that would re-form a cycle) — they call `loadData` through
  `reload.ts`, an import-free seam `main.ts` wires at bootstrap.
- `features/` — one module per feature or chrome unit, each holding that
  feature's render logic *and* its event wiring together (locality of
  behavior). May import `core/` and `lib/`, never `bootstrap/` (except
  `loadData` via `reload.ts`).
- `core/` — shared infrastructure. `dom.ts` is generic feature-agnostic
  helpers (`$`, `setStatus`, `copyText`, `reportError`/`clearError`,
  `populateSelect`, `flashIcon`). The client state is behind one
  `./state.js` entry point re-exporting `store.ts` (the `state` object, its
  localStorage persistence, the named scope transitions), `url.ts` (URL
  params ⇄ state, read side — two readers that differ on purpose, see the
  header comment there), and `row-diff.ts` (the new-rows-since-refresh
  derivation). `store.ts` exposes named transitions (`switchSource` /
  `switchSchema` / `switchTable`) that run the resets and persistence each
  implies; feature modules call those rather than assigning scope fields ad
  hoc, and a site that deliberately diverges (grid.ts's FK navigation,
  which seeds a filter instead of clearing one) says why inline. A value a
  plain `let` export can't expose (the applied filter AST) stays behind a
  getter/setter pair.
- `lib/` — pure leaves: import only `core/types.ts`, or nothing.
- `index.html` — head meta/favicon/pre-paint theme bootstrap script and
  body structural markup only. No inline `style=` or `onclick=`-style
  attributes — every behavior wire-up happens in a module, so there's
  exactly one place to look for "what does this element do."
- `styles.css` — one file; see §2 for why it isn't split further.

When module A needs a function from an upstream module B, route it through
an import-free seam (`bootstrap/reload.ts`) or move the shared helper to a
leaf (`lib/format.ts`) — never add the back-edge. Nothing enforces the
layer *direction* yet (only the cycle and the `src/` → `src/demo/`
boundary); a direction assertion is a possible add to `check-cycles`.

The payoff: a reviewer with "the bug is in pagination" opens
`features/grid.ts` instead of searching one file for a banner, and a
misplaced import shows up as a wrong-looking path.

## 2. CSS

- Kept as one `frontend/src/styles.css` file, not split per feature: the
  `--json-*` (jsonb tree tokens) and `--type-*` (grid/record cell tokens)
  custom properties are deliberately shared across what would otherwise be
  separate files, so a value looks identical whether it's a top-level
  column or nested inside a jsonb blob — splitting them apart risks them
  drifting out of visual sync with nothing to catch it.
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

- **Event binding: `.onX =` only on an element this file exclusively owns
  and binds once.** That covers most wiring here — a toolbar button, a
  freshly-created cell — and stays the default for it: one slot, one
  assignment, one place to look. Reach for `addEventListener` when any of
  three things is true, and note which inline: (a) the target is
  `document` / `window` / `document.body` — a single shared IDL slot any
  other module can silently overwrite, so it is never `.onX =`; (b) a
  second listener is needed on the same element/event; (c) the event has
  no IDL property on every engine (e.g. `onsearch` — Chromium and legacy
  WebKit expose it, Firefox never did, so `.onsearch =` silently no-ops
  there; `$("filter").addEventListener("search", ...)` works everywhere).
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
  (`loadData`), `siblingsRequestToken` (`loadSiblings`), `loadTablesToken`
  (`loadTables`), and `loadSchemasToken` (`loadSchemas`) are the existing
  instances of this pattern — copy their shape for the next one rather
  than reinventing it.
- **Functions do one thing.** Don't let a function fetch, re-render
  multiple DOM regions, *and* update pager state in one body — split
  fetch/render-header/render-body/update-pager into separate functions even
  if a top-level flow calls them in sequence. An orchestrator is exempt
  *provided* it only sequences calls to single-purpose functions and holds
  no rendering logic of its own — `loadData` in `controller.ts` is the
  canonical example.
- **No editorializing comments.** A comment earns its place only by
  explaining a non-obvious *why* (a browser quirk, a security invariant, a
  workaround) — never a *what* a well-named function or variable already
  says.
- **Size discipline.** If a module crosses roughly 300 lines, that's the
  signal to question its scope and look for a real seam to split along
  (see §1's coupling notes), not to add more structure within it.
- **Types**: shared wire/domain shapes (`Column`, `TableData`,
  `FilterCondition`, etc.) live in `types.ts`; a type used by only one
  module stays local to it. Prefer a generic cast at the call site
  (`$<HTMLInputElement>("filter")`) over introducing a new exported type
  just to thread one DOM lookup's element type through.
- **The filter grammar parser (DSL text → AST) is canonical here** — the
  one implementation every deployment shares, not something ports
  reimplement (see `spec/filter-dsl.md`, `spec/protocol.md`'s filter
  representation section). This is a deliberate reversal of an earlier
  rule; see the struck-through entry in §7 for why. It stays a distinct
  concern from `quoteFilterValue()`/`applyFilterClause()` (click-to-filter,
  FK navigation, the common-values dropdown): those *compose* a clause from
  a column/value the server already gave us, never parsing or judging
  arbitrary user-typed text — keep that boundary when extending either.
- **Testing.** A module with no runtime imports and no DOM output — the DSL
  parser is the current example — gets a `node --test` unit in
  `frontend/test/` (`mise run frontend:test-unit`), driven by the same
  `spec/fixtures/` table the conformance runner uses where one exists.
  Anything that touches the DOM or observable behaviour stays in the
  Playwright suite (`docs/e2e-testing-guidelines.md`). Do not add a
  `window.*` test hook to reach otherwise-sealed module scope — extract the
  pure part instead.

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

- `localStorage` and the URL (`history.replaceState()`) persist the user's
  own view intent — table, sort, order, limit, offset — never values read
  back out of result rows (cell contents, PKs lifted from a row). The
  applied filter is the one exception to "both mechanisms": it is
  URL-only, never `localStorage`. Authorship is the line for what may ever
  be persisted at all: a filter the user typed persists; a value the UI
  copied from a fetched row does not (`ui-guidelines.md` R6).
- Stale or malformed persisted state (an unknown table, unparseable JSON,
  a filter that no longer parses) resets silently to the default view. It
  never wedges the UI or errors.

## 7. What not to introduce

- ~~No bundler, no TypeScript~~ — **reversed** (2026). `frontend/src/` is
  TypeScript, bundled with esbuild into the single generated
  `frontend/dbviewer.html` (§1; `CLAUDE.md`). The concern this originally
  guarded against — a build pipeline sitting between the source and the
  *shipped* artifact a port vendors — still fully applies to that shipped
  artifact, which is exactly why it stays one generated file with nothing
  external to fetch and no separate `.js`/`.css` route; it no longer
  applies to how the source authoring itself works. No JSX, no UI
  framework still stand.
- No inline event-handler attributes in HTML markup (`<button
  onclick="...">`).
- **Web Components / Shadow DOM** for repeated widgets (status dot, copy
  button) — too much API surface for roughly five distinct interactive
  pieces; revisit only if that count grows enough that copy-paste
  duplication becomes an actual, measured problem.
- ~~Client-side filter validation~~ — **reversed**, not a current rule. The
  grammar parser (DSL text → AST) now lives here, as the single canonical
  implementation shared by every deployment — see §3 and
  `spec/filter-dsl.md`.
  It was forbidden here originally to avoid two parser copies (frontend +
  backend) silently drifting apart; that risk is gone now that there's
  exactly one *parser* copy, so the rule no longer applies. Left as a
  struck-through entry rather than deleted so this doesn't read as an
  oversight next time someone re-derives "should parsing be client-side?"
  from first principles. The operator list and the filter limits are still
  restated — `api-reference.ts` (the in-app dialog) and `demo-shim.ts` (the
  offline demo backend, which reimplements filter/sort semantics) — now
  held to `spec/openapi.yaml` by `tools/check-frontend-api-reference.sh`
  (`mise run frontend:check-api-reference`).
- **`@scope`** — the file already gets rule-scoping for free from its
  ID-selector discipline; no cascade-leakage problem to solve.
- **`requestIdleCallback` / `scheduler.postTask()`** — no measured
  performance problem; `ui-guidelines.md` R7 already bounds page size.
- **Container queries** for the `nav`/`main` layout — anticipatory; no
  current complaint about the fixed layout breaking in a real embed.
  Revisit if that changes.
