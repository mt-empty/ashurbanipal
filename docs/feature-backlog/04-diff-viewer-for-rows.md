# Diff viewer for comparing two rows

> **Status:** OPEN · **Area:** frontend

## 1. The ask

Compare two rows of the same view, column by column, and see at a glance
what differs. Scalar columns can be eyeballed side by side; `jsonb` / `json`
values are the real reason for the feature, because two large documents are
only comparable once pretty-printed and diffed line by line.

## 2. Constraints

- **Everything ships inside `dbviewer.html`.** The frontend is one
  self-contained file with no CDN dependency (`docs/design.md` §3.1).
  `docs/ui-guidelines.md` R3 would allow a CDN script as an enhancement,
  but a strict host CSP blocks external scripts (`PORTING.md` "CSP and
  inline scripts"), offline hosts can't reach a CDN, and R3 needs a
  working fallback anyway. That is the same reason the JSON tree ended up
  hand-rolled instead of `@alenaksu/json-viewer` (`docs/design.md` §3.1):
  the fallback is most of the work.
- **So the diff logic is in the bundle:** hand-rolled, or an npm package
  that esbuild inlines at build time. The second would be the frontend's
  first runtime dependency (`frontend/package.json` has only dev
  dependencies today) and brings licence/`NOTICE` handling into every
  port's vendored copy — a governance call, like story 27's layout library.
- **No server change.** Both rows are already in the client's data.

Rejected: Monaco's diff editor (tens of MB plus web workers, CDN-only in
practice) and `@pierre/diffs` (pulls in `shiki`, needs an import map or
`esm.sh`). Neither fits a single inlined file or a strict CSP.

## 3. Shape

- **Pick two rows.** A "compare" action in the record view
  (`frontend/src/features/record-view.ts`) marks row A; the same action on
  a second row opens the comparison. Marking is in memory only, never
  persisted (`docs/ui-guidelines.md` R6).
- **Comparison dialog.** The record view's `<dialog>` chrome: one line per
  column — name, value A, value B — with differing columns marked and a
  "hide equal columns" toggle. Primary-key columns first.
- **Scalars** compare by their wire text, the same text copy uses. No
  type-aware equality.
- **JSON values** are pretty-printed (`JSON.stringify(value, null, 2)`, as
  the record view's copy does) and line-diffed; added/removed lines are
  marked with the existing theme tokens.
- **Size cap.** Above a line limit, show "values differ" and both raw
  values instead of a diff, so a multi-MB `jsonb` can't freeze the tab.

## 4. Diff algorithm

Default: a hand-rolled Myers line diff (O(ND), about 100 lines) as a pure
module in `frontend/src/lib/`, unit-tested in `frontend/test/`. Fallback,
only if hand-rolling proves fragile: bundle `diff` (jsdiff, BSD-3-Clause)
through esbuild, with the governance call above.

## 5. Touchpoints

- `frontend/src/lib/` — pure row compare + line diff, with unit tests.
- `frontend/src/features/record-view.ts` — the compare action.
- `frontend/src/index.html`, `frontend/src/styles.css` — dialog and diff
  styling, both themes.
- `docs/design.md` §2/§9 — already point here.
- `tools/e2e-tests/tests/` — one spec.

## 6. What "done" means

- Comparing two rows lists every column and marks the differing ones;
  "hide equal columns" hides the rest.
- Two `jsonb` values differing in one key show one changed line.
- Opening a comparison sends no request, and nothing loads from outside
  the page.
- Over the size cap, the dialog shows both raw values without a diff.
- Playwright asserts DOM state and text, not screenshots, and the full
  suite passes at default parallelism.

## 7. References

Prior art for the diff rendering, not dependencies (see §2 for why):

- Monaco diff editor — https://microsoft.github.io/monaco-editor/
- `@pierre/diffs` — https://github.com/pierrecomputer/pierre
- https://diffs.com/

## 8. Open questions

- Same view only, or keep row A marked across table/page switches to
  compare rows from different pages or tables?
- `json` (unlike `jsonb`) keeps the stored key order, so two equal
  objects can differ only in order. Sort keys before diffing?
- The size cap's value.
