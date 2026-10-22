# Table auto-refresh with interval and countdown

> **Status:** OPEN · **Area:** frontend, docs

## 1. The ask

Add opt-in auto-refresh to the grid's existing refresh button:

- A frequency control: off, or a fixed interval, 5 s minimum.
- A progress bar that shows, live, how far through the current interval
  the next refresh is. It shares one bar with story 37's in-flight
  indicator.

`docs/ui-guidelines.md` R10 said refresh is manual only. That constraint
is removed. R10 otherwise stands: the refresh button and the new-row tint
remain the "what changed" affordance, and auto ticks use both.

No existing story covers this. Story 08 is about sibling health polling,
a different feature.

## 2. Current state

- `frontend/src/index.html:86` — `#refresh` button, disabled until the
  first load.
- `frontend/src/bootstrap/main.ts:65-…` — refresh click handler.
- `frontend/src/bootstrap/controller.ts:272-276` — the "nothing new"
  check mark. An auto tick does not trigger it (see "Tick feedback").
- `frontend/src/features/siblings.ts` — the existing 15 s timer. It is the
  only interval in the frontend today, and it is for siblings only.

## 3. Proposed behavior

- **Control.** A split button: `#refresh` plus a `▾` that opens a menu
  of `Off`, `5 s`, `10 s`, `15 s`, `30 s`, `1 min`. 1 min is the longest.
  While on, the button shows the interval (`refresh · 15 s`). Off on every
  page load. The choice is not persisted: no `localStorage`, no URL.
  The menu footer reads "Pauses while this tab is hidden. Turns off after
  30 minutes idle." Design: canvas board AF. The `⟳` glyph is replaced by
  the two-chasing-arrows SVG icon (board AK, option 2).
- **One progress bar.** One element at the top edge of the table panel,
  shared with story 37's in-flight bar. It carries no text. Design: boards
  AJ (option 1) and AM (panel 3). It has two states:
  - While a fetch is running (after story 37's delay), it shows the
    in-flight state: a darker moving segment, with the old rows dimmed.
    Under reduced motion it is a full-width striped bar.
  - Otherwise, while auto-refresh is on, it empties over the interval.
  - Hidden when auto-refresh is Off and no fetch is slow.
  The countdown restarts at full width when a fetch ends, whether the
  fetch was an auto tick, a manual refresh, or a sort or page click.
- **Skip, don't queue.** If a fetch is still in flight when a tick
  fires, skip that tick. Never stack requests. A slow query therefore
  slows the cadence instead of piling up. Because the countdown restarts
  when a fetch ends, this only applies to fetches the user starts.
- **Pause when hidden.** Pause the timer while `document.visibilityState`
  is `hidden`. On return, refresh at once if the interval has passed.
- **Stop on repeated failure.** After 5 consecutive failed auto-refreshes,
  turn auto-refresh off and show the existing `#error` banner with the
  last error: "Auto-refresh turned off after 5 failed refreshes. Last
  error: 503 Service Unavailable." No instruction to re-enable it, since
  the service is the problem; the refresh button still works. A broken
  connection must not keep retrying silently.
- **Stop when idle.** After 30 minutes with no pointer, key, scroll, or
  touch input on the page, turn auto-refresh off. Show the calm
  `#view-notice` note (not the `#error` alert, since nothing failed):
  "Auto-refresh turned off after 30 minutes without activity." The grid
  may change under the user during a tick. That is accepted: the user can stop it at once, so ticks do not
  skip for open dialogs or selections.
- **Row tint.** Auto ticks tint new rows the same way a manual refresh
  does (R10).
- **Tick feedback.** An auto tick does not flash the ✓ or set `#status`
  to "no changes". After each tick, the row meta shows a quiet "updated
  14:32:05". A tick that brings new rows also shows a "+2 new" chip that
  fades with the tint. Design: canvas board AL, option 4.
- **Loading.** Auto ticks show the in-flight state only after story 37's
  delay, so a fast tick never flashes.
- **Accessibility.** The bar is decorative (`aria-hidden`). The `▾`
  button has an `aria-label`. Auto ticks do not announce through
  `#status` each time. Only the "new rows" count and failures are announced.
- **Reduced motion.** The bar still moves, because it shows state, but
  it has no animation of its own. A stepped update is acceptable.

Keep state, sort, filter, and page unchanged across ticks, as a manual
refresh does now.

## 4. Touchpoints

- `frontend/src/index.html` — the `▾` menu button beside `#refresh`; the shared bar
  sits at the top of the table panel (story 37's element).
- `frontend/src/bootstrap/main.ts` — one timer owner for the grid. Clear
  it on table switch and on scope change, so an old timer cannot refresh
  the new view.
- `frontend/src/bootstrap/controller.ts` — the in-flight guard
  (`inFlightFetches`, `:47`) already exists; reuse it for the skip rule.
- `frontend/src/styles.css` — bar and select rules, using existing tokens.
- `docs/ui-guidelines.md` R10 — done: the "manual only" clause is removed.
- `docs/frontend-style-guide.md` — note the new timer owner, so it is not
  confused with the sibling poll.
- `tools/e2e-tests/tests/` — one spec, see §5.

No server, spec, or port change. Each tick is an ordinary `/tables/data`
request.

## 5. What "done" means

- Off by default, and Off again after every page load. No request fires
  without the user choosing an interval.
- With 5 s set, the grid refreshes about every 5 s. Asserted with a
  request count, not a fixed sleep (`waitForResponse`, per `CLAUDE.md`).
- A slow fetch that outlasts a tick causes that tick to be skipped. No
  overlapping requests.
- Switching table, sort, filter, or scope resets the timer to the new
  view.
- Hiding the tab pauses ticks. Showing it again refreshes when overdue.
- Five consecutive failures turn the interval off and show `#error`.
- The shared bar empties over the interval, resets on any refresh, and
  switches to the in-flight state during a slow fetch.
- 30 minutes without input turns the interval off and shows the
  `#view-notice` note.
- Auto ticks tint new rows.
- Full Playwright suite at default parallelism before the change is done.

## 6. Open questions

- **Sort memory.** R11 already remembers sort per table. Should sort also
  have a general default that applies to tables with no saved sort? Not
  decided here.
- **Server cost.** Each tick runs the full data query. Should the server
  return a cheap "changed since" signal first? Out of scope for v1 unless
  you want it in.
