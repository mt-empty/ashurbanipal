# E2E testing guidelines — `tools/e2e-tests`

Status: agreed
Scope: Playwright specs and helpers under `tools/e2e-tests/tests`.
Complements `frontend-style-guide.md` and `ui-guidelines.md` — this doc is
about test *reliability*, not app behavior.

Every rule below traces back to a real flakiness incident found while
building this suite, not a hypothetical.

## 1. Wait on a concrete signal, never a guessed duration

`page.waitForTimeout(n)` was used once, to let a deliberately-delayed
response "have time" to land before an assertion — it guessed 1300ms,
which is both slower than necessary on a fast run and not actually
guaranteed to be enough under contention. Replaced with
`page.waitForResponse(...)`, armed *before* the action that triggers the
response, so the wait is tied to the real event the assertions depend on
rather than a duration that happened to work once. Don't reintroduce
`waitForTimeout` for anything the app itself signals — a response landing,
an element attribute changing, `aria-busy` clearing.

## 2. A finished fetch is not a finished render

`aria-busy` clearing only proves `fetchTableData()`'s network call
resolved — `dbviewer.html` wraps every re-render in
`document.startViewTransition()`, which keeps animating for a short window
after that, and an action fired mid-animation can hit an unstable bounding
box or get intercepted by the transition's snapshot overlay. `waitForIdle`
(`support/helpers.ts`) waits for `document.getAnimations()` to empty out,
not just for the fetch to resolve — use it (or extend it) rather than
adding a second `waitForTimeout`-shaped workaround for a similar gap.

## 3. Don't assume a page's own automatic state has settled before you act

`gotoApp` waits for the app's own automatic initial-table load to finish
before returning, not just for navigation to complete. Without that wait,
a test's first `selectTable()` click could race the page's own default-
table fetch — whichever response lands last wins the render, which used
to be able to leave `#current` labeled correctly while the grid showed the
other table's rows (a real app bug, since fixed via `loadDataToken`; see
`frontend-style-guide.md` §3's request-token rule). The general lesson
outlives that specific bug: any page with its own async bootstrapping
needs a helper that waits for it, not an assumption that `goto()` was
enough.

## 4. A visual-regression baseline must be visually verified once, by a human, before it's trusted

A screenshot baseline was captured mid-race (before the loadData staleness
guard existed) and never actually looked at after generating it — so it
silently baked in a broken render. `--update-snapshots` produces a file
that *matches itself* by construction; it says nothing about whether what
it captured was correct. Look at a new or regenerated baseline before
committing it, don't just trust that the diff tool will catch it on some
later run.
