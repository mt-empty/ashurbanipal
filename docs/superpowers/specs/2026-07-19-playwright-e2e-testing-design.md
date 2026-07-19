# Playwright E2E testing for dbviewer.html — Design Doc

Status: draft, pending review
Scope: a new, standalone Playwright test suite covering `src/frontend/dbviewer.html`'s
user-facing behavior end-to-end, to catch UI regressions before they ship.

## 1. Why

Recent history shows this class of bug repeating: toolbar layout jumps
(`f43b868`), sort-arrow width shifts, stale grids after failed loads,
filter-clear breakage, hidden-columns state bugs. `dbviewer.html` has no
automated coverage today beyond the backend's black-box HTTP tests
(`tests/black_box/`), which never render or interact with the page. This
suite closes that gap.

## 2. Toolchain & layout

- New standalone directory `tools/e2e-tests/` — own `package.json`/
  `package-lock.json`, **not** part of the Cargo workspace, mirroring how
  `tools/seed-gen` is kept out of the main crate's dependency tree.
- **TypeScript** + `@playwright/test` — the standard batteries-included
  runner: auto-waiting, `toHaveScreenshot()`, trace viewer, HTML report,
  all built in.
- **Chromium only.** This is an internal dev tool, not a public site — one
  consistent engine keeps screenshot baselines stable and avoids tripling
  run time for a cross-browser matrix nobody has asked for.
- New `mise.toml` tasks:
  - `mise run test-e2e` → `npx playwright test` (`dir = "tools/e2e-tests"`)
  - `mise run test-e2e-update-snapshots` → `npx playwright test --update-snapshots`
  - `mise run test-e2e-install` → `npx playwright install --with-deps chromium`
    (one-time browser binary download, kept separate from the above since
    it's a heavier, infrequent step)
- **Deliberately excluded from `mise run check`.** `check` today is pure
  Cargo (`fmt-check` + `lint` + `test`) and every contributor can run it
  with just the Rust toolchain. Folding in `test-e2e` would force every
  contributor to install Node + a Chromium binary just to run `cargo`-only
  checks. Revisit if/when this project wires up real CI and wants the E2E
  suite gating merges.

## 3. Test harness / server strategy

**One shared `webServer`** for the main suite: Playwright's config starts
`mise run demo` once at the start of the run, polls `/health` until ready,
and tears it down after all tests finish. All spec files and parallel
workers share this one server instance.

This deliberately departs from `tests/black_box/common.rs`'s
spawn-a-fresh-process-per-test pattern. That pattern exists there for a
reason that doesn't apply here: Ashurbanipal is read-only by architecture
invariant (§8 of `design.md` — `SELECT` only, no writes of any kind), so
there is no cross-test mutation to isolate against. Spawning ~50
individual server processes for zero isolation benefit would just be pure
overhead. A single shared instance is the standard Playwright pattern and
fits this app's actual risk profile.

**Exception: `siblings.spec.ts`.** Testing the sibling-health-status
feature needs *two* live instances. This one file spawns its own second
`demo` process directly (via Node's `child_process`, mirroring
`mise run demo-sibling`'s `PORT`/`SIBLING_PORT` env vars) in a
`test.beforeAll`/`afterAll` local fixture, on top of the shared primary
server. Contained to one file; nothing else needs it.

**Database**: both the shared server and the siblings fixture point at
the same devcontainer `DATABASE_URL`, seeded via
`.devcontainer/db/init/01-seed.sql` (10 tables, fixed-seed deterministic
generation — see §5). No test-specific fixtures or mocked responses; this
stays true black-box, consistent with the project's existing testing
philosophy.

## 4. Coverage

Full user-flow coverage: every documented interaction in `design.md` §3.1,
`ui-guidelines.md`, and the fixed-bug history in git log. Estimated
**~45-55 tests across 13 spec files**:

| Spec file | Covers | ~tests |
|---|---|---|
| `table-listing.spec.ts` | sidebar render, comment tooltips (present/absent), live search, table switch | 5 |
| `sorting.spec.ts` | asc/desc toggle, arrow state, **+screenshot**: header width stable across sort target | 5 |
| `filtering.spec.ts` | apply/clear, invalid filter → verbatim backend error, `IS [NOT] NULL`, column autocomplete boundary | 7 |
| `click-to-filter.spec.ts` | cell button composes+submits, null-cell button | 3 |
| `common-values.spec.ts` | populated dropdown, empty state (unique column), click applies filter | 3 |
| `fk-navigation.spec.ts` | FK cell switches table+filters, null FK cell has no affordance | 2 |
| `pagination.spec.ts` | next/prev, row count, limit clamping, at-scale paging against `reviews`/`audit_log` | 4 |
| `column-visibility.spec.ts` | hide/show, hidden-count indicator, per-table scoping, **+screenshot**: sidebar/toolbar chrome stable | 4 |
| `inspection-affordances.spec.ts` | payload dialog (Esc/backdrop), cell popover + light-dismiss (incl. `payments`' large nested jsonb), per-cell copy, record view + copy buttons | 7 |
| `persistence.spec.ts` | localStorage + URL round-trip, URL wins over storage, corrupted-state fallback (R5), filter never persisted | 5 |
| `siblings.spec.ts` | healthy/unhealthy dot, two-server fixture (§3) | 2 |
| `loading-and-errors.spec.ts` | **+screenshot**: loading indicator doesn't shift toolbar, stale grid never shown after failed load | 3 |
| `empty-table.spec.ts` | `saved_reports`: zero-row render, `/table-counts` reads 0 not -1, common-values returns empty not an error | 2 |

Table-to-test mapping (why the seed data matters here):

- `saved_reports` (0 rows) → the only empty-state coverage.
- `reviews` (13.6k rows) → pagination-at-scale; its nullable `order_id` FK
  → the null-FK-cell case.
- `support_tickets` → dual-FK-to-`users` case (`user_id` vs
  `assigned_admin_id` resolve independently); its guaranteed long
  multi-paragraph column → the truncation/popover test.
- `payments` → guaranteed large/nested-jsonb row → JSON popover test with
  real structure, not a flat 1-key object.
- `audit_log` (30k rows) → second, larger-scale pagination/approx-count
  data point; all-nullable FKs.

**Explicitly out of scope for v1:**
- Sticky-header scroll behavior — low automated-test value for a pure CSS
  `position: sticky`, no meaningful regression surface.
- CDN-loaded enhancements (`@alenaksu/json-viewer`, Prism) — not wired in
  yet per `CLAUDE.md`; nothing to test.
- Cross-browser matrix, mobile viewports — internal dev tool, Chromium
  only (§2).
- Column reorder/resize — not built (`dbviewer-feedback-backlog.md` §13).

## 5. Visual regression (screenshots)

Capped at **3 tests**, `toHaveScreenshot()`, baselines committed to
`tools/e2e-tests/tests/*.spec.ts-snapshots/` (Playwright's default path).
Each is a cropped `locator.screenshot()` region, not a full-page capture —
narrower surface area is less brittle than capturing everything and
masking the risky parts:

1. **Sort header row**, before vs. after clicking a different column —
   catches arrow-width-reservation regressions (`bd7608e`).
2. **Toolbar during an in-flight fetch** — catches the loading-indicator
   layout jump (`f43b868`).
3. **Sidebar with a column hidden** — catches the hidden-count indicator
   reflowing the table list.

Seed timestamps now anchor to a fixed literal (`2026-07-19`, see §6)
rather than wall-clock `now()`, so rendered date/time text is stable
across reseeds — screenshots don't need to dodge or mask timestamp cells
for that reason. All 3 regions are chosen to avoid data cells entirely
anyway (header chrome, toolbar chrome, sidebar chrome), so this holds
regardless.

## 6. Seed data (prerequisite, already landed)

`tools/seed-gen` was extended (commit `19e5e9c`) from 5 to 10 tables
specifically to support this suite:

- Added `reviews`, `support_tickets`, `payments`, `audit_log` (2-3
  single-column FKs each — never composite, per `design.md` §4's FK
  detection constraint), and `saved_reports` (empty).
- Fixed: all timestamps/dates in INSERT statements now anchor to a fixed
  literal instead of `now()`/`current_date`, so rendered values are
  stable regardless of when the devcontainer is (re)seeded.
- Fixed: `payments.gateway_response` and `support_tickets.description` now
  guarantee, for a deterministic subset of rows, a large/nested-jsonb
  value and a multi-paragraph text value respectively — closing the gap
  where no column reliably exercised cell-truncation or a non-trivial
  JSON popover.
- Determinism preserved: regenerating without source edits still produces
  byte-identical output (verified).

This suite depends on that seed being loaded — it is not re-verified here,
just referenced as a completed prerequisite.

## 7. Flakiness / error-handling conventions

- Rely on Playwright's built-in auto-waiting (`locator.click()`,
  `expect(...).toBeVisible()`, etc.) — no arbitrary `page.waitForTimeout()`
  sleeps.
- `trace: 'on-first-retry'` in config, so a flaky failure leaves a
  debuggable trace without paying trace-recording cost on every run.
- Retries: 0 locally, small retry count (e.g. 2) reserved for whenever
  this runs in an actual CI environment — not configured yet since no CI
  workflow exists in this repo today.
- Assertions never depend on exact rendered date/time text (still true
  even with fixed-anchor timestamps — avoid coupling tests to the literal
  date value, since that's an implementation detail of the seed).

## 8. Rollout

1. Scaffold `tools/e2e-tests/` (`package.json`, `playwright.config.ts`,
   `tsconfig.json`).
2. Add the `mise.toml` tasks (§2).
3. Implement spec files in the order listed in §4's table (roughly
   simplest/highest-value first: table-listing → sorting → filtering →
   ... → siblings last, since it needs the extra fixture).
4. Generate the 3 screenshot baselines (`test-e2e-update-snapshots`),
   commit them.
5. Manually verify the full suite green via `mise run test-e2e`.

Not covered here: wiring this into an actual CI pipeline (none exists in
this repo yet) — a follow-up once the suite itself is proven out locally.
