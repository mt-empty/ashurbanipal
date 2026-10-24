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

`aria-busy` clearing only proves the fetch resolved and the re-render ran
inside `document.startViewTransition()`. The fade that follows can still
leave a clicked element unstable or route the click to the transition's
snapshot overlay. `waitForIdle` (`support/helpers.ts`) also waits for
`document.getAnimations()` to empty out — use it (or extend it) rather
than adding a `waitForTimeout`-shaped workaround for a similar gap.

Every spec imports `test` and `expect` from `support/fixtures.ts`, not
`@playwright/test`. Its `page` fixture makes view-transition fades zero
length, which cut about 30% of suite time: no app code waits on a fade,
so only the wait shrinks. `view-switch.spec.ts` sets
`test.use({ realFades: true })` so the real fade, and `waitForIdle`'s wait
on it, stay exercised.

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

## 4. (Historical) Screenshot baselines were dropped for flakiness

The suite has no visual-regression assertions — they were removed
project-wide (commit `157fc12`). Kept here as the reason
why: a baseline was once captured mid-race (before the `loadData`
staleness guard existed) and never actually looked at after generating
it, so it silently baked in a broken render. `--update-snapshots`
produces a file that *matches itself* by construction; it says nothing
about whether what it captured was correct. If screenshot tests are ever
reintroduced, a human must eyeball each new baseline before it lands.

## 5. Run the suite in tiers

The suite runs every spec on Chromium, Firefox and WebKit, about 700 tests
in all, so run the smallest tier that answers the question:

| Tier | Command | When |
| --- | --- | --- |
| One spec | `mise run frontend:test-e2e-spec tests/<name>.spec.ts [-g title]` | while iterating |
| Whole suite, Chromium + Firefox | `mise run frontend:test-e2e-quick` | once the change looks finished |
| Whole suite, all three browsers | `mise run frontend:test-e2e` | once, at the end of the work |

The final three-browser run, at Playwright's default parallelism, is what
makes a frontend change done. The worst races here (stale-response
overwrites, stuck spinners) only surfaced under real concurrency, never in
a serial pass, and the faster tiers skip WebKit, so a Safari-only bug
first shows up there. It is never a per-edit check, and neither is `mise
run check` or the `frontend` umbrella task, which both include it.

The suite serves axum's vendored copy of the page
(`implementations/rust/axum/frontend/dbviewer.html`), not
`frontend/dbviewer.html`. The two faster tiers rebuild and sync it first;
before the full run, run `frontend:build` and then `frontend:sync-ports`,
or it tests the old page.

The faster tiers set `E2E_BROWSERS=chromium,firefox`, which
`playwright.config.ts` uses to pick both the browser projects and the
demo servers it starts. Use it rather than `--project` to narrow a run:
Playwright starts every configured server whichever projects `--project`
selects.
