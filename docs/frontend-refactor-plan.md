# `dbviewer.html` refactor plan

Status: applied — all phases (0–7) complete
Derived from: `frontend-style-guide.md` §4–§8 (the "what" and "why" live
there — this doc is just the "in what order"). Two items also touch
`ui-guidelines.md` R6 in how they're implemented, noted inline.

Ordered in phases because several items have a real dependency on an
earlier one — doing them out of order means redoing work. Within a phase,
items are independent and can land in any order (or split across separate
commits/PRs) unless noted. Check items off as they land; this file is the
execution record, `frontend-style-guide.md` stays the standing reference.

## Phase 0 — structural prep (do first; everything else gets a cleaner diff because of this)

- [x] Split `loadData()` into `fetchTableData()`, `renderHeader()`,
      `renderRows()` / `renderEmptyState()`, `updatePager()`. (style
      guide §3, §8) — Phase 3's keyboard-accessible cell and focus-loss
      fixes, Phase 7's `<template>` conversion, and Phase 8's View
      Transition wrap all land inside whatever this split produces, so
      doing it first means they land as clean edits instead of edits
      inside one 90-line function.
- [x] Hoist repeated CSS literals (`#8884` ×5, `.5rem`/`.75rem` gaps,
      etc.) to `:root` custom properties. (style guide §5, §8) — Phase 4's
      `light-dark()` fixes become one-line changes at the definition
      instead of N edits at each use site if this lands first.
- [x] Add `/* ==== */` CSS section banners to the base layout/table/nav
      rules, matching the dialog/popover blocks that already have them.
      (style guide §2, §8) — no dependency, but natural to batch with the
      custom-properties pass since both touch the same CSS region.

## Phase 1 — platform over hand-written JS

Independent of each other and of most other phases; the common thread is
each one deletes JS by using a browser feature already covered in style
guide §4.

- [x] `<form method="dialog">` for the payload dialog's close button —
      removes `$("payload-close").onclick`.
- [x] `closedBy="any"` on `#payload-dialog` — removes the manual
      backdrop-click `addEventListener`.
- [x] Wrap `#filter` + `#apply` in a `<form>` — removes the manual
      `keydown`/Enter-key `addEventListener`.
- [x] CSS Anchor Positioning for `#cell-pop` (`anchor-name` set via JS per
      click, `position-anchor` + `position-try-fallbacks: flip-block,
      flip-inline` in CSS) — removes the manual `getBoundingClientRect()`
      + `Math.max`/`Math.min` clamping in `showCellPop()`.

## Phase 2 — semantic HTML and accessibility

Two of these are real defects (marked); the rest are one-line attribute
additions to code paths that already exist. `td.onclick` and the
focus-loss fix both touch the row-rendering code Phase 0's split
produces — do Phase 0 first.

- [x] **[defect]** Expandable-cell keyboard access: replace the bare
      `td.onclick` with a real `<button>` as the click target (mirrors
      what the copy button already does correctly).
- [x] **[defect]** Focus loss on re-render: capture focus before
      `replaceChildren()` and restore it (or anchor to a stable element)
      after, instead of letting it fall through to `<body>`.
- [x] **[defect]** Sibling health dots: add a text alternative
      (`aria-label` or visually-hidden text — `"healthy"`/`"unhealthy"`)
      so status isn't color-only.
- [x] `role="alert"` on `#error` (currently `#status` gets
      `aria-live="polite"` right; `#error` gets neither).
- [x] `aria-sort` on `<th>`, replacing the `.sorted`/`.sorted.desc` class
      pair; update the CSS selectors to `th[aria-sort="ascending"]` /
      `th[aria-sort="descending"]` to match.
- [x] `aria-current="true"` on the active sidebar table button, alongside
      the existing `.active` class.
- [x] `aria-label="copy cell value"` on the per-cell copy button
      (matches the pattern `payload-close` already gets right).
- [x] `type="search"` + `enterkeyhint="search"` on `#filter`.
- [x] `<search>` landmark: `<div id="controls">` → `<search id="controls">`.
- [x] `<time datetime="...">` wrapping `timestamptz`/`date` cell values.
- [x] `field-sizing: content` on `#filter`.
- [x] `<script>` → `<script type="module">`; drop the now-redundant
      `"use strict";`.

## Phase 3 — color and theming

Depends on Phase 0's custom-properties hoist.

- [x] **[defect, minor]** `dialog::backdrop` under-dims dark-mode pages —
      fix via `light-dark(#0006, #0009)` on the custom property.
- [x] Same `light-dark()` treatment for the four opportunistic flat-color
      spots: `.dot.up`/`.dot.down`, `#error`, `li button.active`.
- [x] `color-mix()` for hover/active states currently hand-picked
      (`.copy:hover`, `li button.active`) — optional, only where it
      actually replaces a literal. Applied to `.copy:hover`
      (`color-mix(in srgb, currentColor 12%, transparent)` — a
      value-neutral swap, since `#8882` was already a neutral gray-alpha
      overlay). **Deliberately not applied to `li button.active`**: its
      `#08f2` is a distinct blue "this table is selected" signal, not a
      neutral hover tint — collapsing it to a `currentColor`-derived mix
      would make it visually indistinguishable from `li button:hover`'s
      neutral tint, losing real information. Kept on the `--active`
      custom property with `light-dark()` (previous item) instead, which
      preserves the color identity while still fixing dark-mode contrast.

## Phase 4 — state architecture

- [x] Mirror `state.table` / `sort` / `order` / `limit` / `offset` into
      the URL via `history.replaceState()` on every successful
      `loadData()`/`fetchTableData()` call, making views
      shareable/bookmarkable.
      **`filter` stays excluded** — extends `ui-guidelines.md` R6's
      existing `localStorage` boundary to the URL (a URL is *more*
      exposed than `localStorage`: browser history, access logs,
      `Referer` header), not a separate decision to make here.
      Also reads these same params back out of the URL on initial load
      (taking priority over `localStorage`), since a link is only
      actually "shareable" if opening it reproduces the view — this is
      implied by the style guide's own `?table=orders&sort=created_at&
      order=desc` example, not a separate feature.

## Phase 5 — multi-instance polish

All tied to `design.md`'s sibling-navigation goal; independent of each
other.

- [x] `document.title` reflects the current table
      (`` `${state.table} — Ashurbanipal` ``).
- [x] Inline `data:` URI SVG favicon (no external asset).
- [x] `main.scrollTo({ top: 0, behavior: "smooth" })` after a successful
      paginate/sort render.
- [x] Sibling `<a>` links get `target="_blank" rel="noopener"`.

## Phase 6 — bigger structural simplification

Depends on Phase 0's split — cleanest once `renderRows()` exists as its
own function.

- [x] Convert row/cell construction to a `<template>` + `content.cloneNode(true)`
      per cell, replacing the nested `document.createElement()` calls.
- [x] `<output>` instead of `<span>` for `#status` and `#page`.

## Phase 7 — progressive enhancement (do last, on purpose)

- [x] Wrap the `thead`/`tbody` replacement in
      `document.startViewTransition()` (feature-detected). Explicitly
      last: wrapping the render in a transition callback before Phase 0's
      split and Phase 2's focus-loss fix land would make both harder to
      do, not easier.

## Explicitly not in this pass

Logged so it's a deliberate omission, not a missed one — see
`frontend-style-guide.md` §4 and §7 for the reasoning behind each:

- **Container queries** for the `nav`/`main` layout — anticipatory, no
  current complaint about the fixed layout breaking in a real embed.
  Revisit if that changes.
- **Web Components / Shadow DOM** — rejected, not deferred: too much API
  surface for ~5 widgets, and Phase 6's `<template>` fix already removes
  more duplication on its own.
- **Client-side filter validation** — rejected: would duplicate the
  server-side parser's job in a second place that can drift from it,
  contradicting a deliberate project decision.
- **`@scope`** — no active cascade-leakage problem to solve.
- **`requestIdleCallback`/`scheduler.postTask()`** — no measured
  performance problem; `ui-guidelines.md` R7 already bounds page size.
- **`<datalist>` column autocomplete** — a new feature, not a
  modernization of existing code; noted in the style guide but out of
  scope for a refactor pass.
