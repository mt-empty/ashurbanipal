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
  check mark, which an auto tick also triggers.
- `frontend/src/features/siblings.ts` — the existing 15 s timer. It is the
  only interval in the frontend today, and it is for siblings only.

## 3. Proposed behavior

- **Control.** A small `<select>` next to `#refresh`: `Off`, `5 s`,
  `15 s`, `30 s`, `1 min`, `5 min`. Off on every page load. The choice is
  not persisted: no `localStorage`, no URL.
- **One progress bar.** Sits at the top edge of the table panel, where
  story 37 puts its in-flight bar. It has two states:
  - While a fetch is running (after story 37's delay), it shows the
    in-flight state.
  - Otherwise, while auto-refresh is on, it empties over the interval and
    resets on each refresh, manual or auto.
  - Hidden when auto-refresh is Off and no fetch is slow.
- **Skip, don't queue.** If a fetch is still in flight when a tick
  fires, skip that tick. Never stack requests. A slow query therefore
  slows the cadence instead of piling up.
- **Pause when hidden.** Pause the timer while `document.visibilityState`
  is `hidden`. On return, refresh at once if the interval has passed.
- **Stop on repeated failure.** After 3 consecutive failed auto-refreshes,
  turn auto-refresh off and show the existing `#error` banner. A broken
  connection must not keep retrying silently.
- **Row tint.** Auto ticks tint new rows the same way a manual refresh
  does (R10).
- **Loading.** Auto ticks show the in-flight state only after story 37's
  delay, so a fast tick never flashes.
- **Accessibility.** The bar is decorative (`aria-hidden`). The select
  has a label. Auto ticks do not announce through `#status` each time.
  Only the "new rows" count and failures are announced.
- **Reduced motion.** The bar still moves, because it shows state, but
  it has no animation of its own. A stepped update is acceptable.

Keep state, sort, filter, and page unchanged across ticks, as a manual
refresh does now.

## 4. Touchpoints

- `frontend/src/index.html` — select beside `#refresh`; the shared bar
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
- Three consecutive failures turn the interval off and show `#error`.
- The shared bar empties over the interval, resets on any refresh, and
  switches to the in-flight state during a slow fetch.
- Auto ticks tint new rows.
- Full Playwright suite at default parallelism before the change is done.

## 6. Open questions

- **Sort memory.** R11 already remembers sort per table. Should sort also
  have a general default that applies to tables with no saved sort? Not
  decided here.
- **Server cost.** Each tick runs the full data query. Should the server
  return a cheap "changed since" signal first? Out of scope for v1 unless
  you want it in.
