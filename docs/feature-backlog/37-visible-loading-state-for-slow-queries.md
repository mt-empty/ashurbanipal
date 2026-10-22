# Visible loading state for slow queries

> **Status:** DONE · **Area:** frontend, e2e · **Ref:** implemented 2026-10-22 with story 38 (`features/load-bar.ts`, `loading-bar.spec.ts`); the elapsed-time text and Cancel were left out

## 1. The ask

Sorting, paging, filtering, and any other fetch that runs long show no
visible sign that work is in progress. Found against a dev database with
hundreds of thousands of rows: a sort click leaves the grid unchanged
for seconds, and nothing on screen says the query is running.

## 2. What exists today

The loading signals are real but none is visible where the user acts.

- `frontend/src/bootstrap/controller.ts:131-134` — the first in-flight
  fetch sets `#status` to `loading…` and `aria-busy` on the table.
- `frontend/src/index.html:81` — `#status` is an `sr-only` live region.
  Screen readers hear it; sighted users do not.
- `frontend/src/styles.css:265` — `.sr-only` hides it visually.
- `frontend/src/styles.css` — no rule reads `aria-busy`, so the table
  gives no visual cue.
- `frontend/src/styles.css:118-125` — the only visible cue is the
  per-row spinner in the sidebar (`setRowLoading`,
  `controller.ts:135`). It sits on the table list, far from the sort
  headers and pager the user just clicked.

So `docs/ui-guidelines.md` R9 (line 144) is only true for assistive
tech. Its "loading is a visible state" claim does not hold for the grid.

## 3. Proposed behavior

- **Grid indicator.** While a `/tables/data` fetch runs, show a
  non-blocking indicator on the grid itself: a thin progress bar on the
  top edge of the table panel, plus the stale rows dimmed in place.
  Recommended over a full overlay, because the old rows stay readable
  and nothing shifts.
- **Shared with story 38.** This bar also carries auto-refresh's
  countdown. One bar, two states: in-flight and countdown.
- **Delay before showing.** Show the indicator only after about 250 ms
  of wait. Fast fetches then never flash. The threshold is a single
  constant, not a per-view setting.
- **Elapsed time.** After about 3 s, the indicator shows the elapsed
  time (`Still running… 12 s`) so the user knows the wait is real.
- **Screen readers.** Keep the existing `#status` live region. Post
  `loading…` only after the same delay, so fast fetches stay silent.
- **Reduced motion.** Under `prefers-reduced-motion`, drop the bar's
  animation and keep the static dim plus text.
- **Errors.** A failed slow fetch still goes to `#error`, and the
  indicator clears on settle either way.
- **No layout change.** The indicator takes no space in the flow,
  matching the pattern in `styles.css:118-125`.

Sort and page clicks stay enabled during a load. The existing
`loadDataToken` guard already drops stale responses.

## 4. Touchpoints

- `frontend/src/bootstrap/controller.ts` — start a delay timer in
  `fetchViewData()` (`:107-145`); clear it in the `finally`. Reuse the
  reference count already at `:47`, so overlapping fetches share one
  indicator.
- `frontend/src/index.html` — a container for the indicator inside the
  table panel.
- `frontend/src/styles.css` — indicator, dimmed-row, and reduced-motion
  rules. Use the existing `--border-strong` token.
- `docs/ui-guidelines.md` R9 — correct the claim that `aria-busy` covers
  loading for sighted users, once the indicator exists.
- `tools/e2e-tests/` — one spec, see §5.

No server, spec, or port change. The server already answers `/tables/data`
in one request.

## 5. What "done" means

- A fetch that answers in under 250 ms shows no indicator and no
  `loading…` text.
- A fetch held for 2 s shows the indicator, dimmed stale rows, and
  `aria-busy="true"` on the table. All three clear when the response
  lands.
- The elapsed-time text appears after about 3 s and goes away on settle.
- Two overlapping fetches (sort, then page) keep the indicator on until
  the last one settles.
- A failed slow fetch shows `#error` and clears the indicator.
- Playwright (in `tools/e2e-tests/tests/`) asserts DOM state and
  attributes. It holds the response with `page.route` and waits on
  `waitForResponse`, not `waitForTimeout`. Per `CLAUDE.md`, run the full
  suite at default parallelism before calling the change done.

## 6. Open questions

- **Cancel.** A user on a 300k-row sort may want to stop waiting. A
  client `AbortController` stops the wait but not the database query.
  Stopping the query needs a server-side cancel, which the protocol
  does not have. Add a Cancel button now (client-side only), or wait for
  a server-side cancel design?
- **Threshold values.** 250 ms and 3 s are starting points. Confirm
  against a real slow database before fixing them.
- **Sort headers.** Should the clicked header show its own spinner, or
  is the grid-level indicator enough?
