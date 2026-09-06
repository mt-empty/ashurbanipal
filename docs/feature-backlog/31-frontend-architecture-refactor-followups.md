# Frontend architecture refactor — deferred follow-ups

Status: captured 2026-09-06. The nine-phase `frontend/src/` refactor (commits
`47d10a7`..`7d86976`) landed the import-cycle break, the Biome adoption, the
`state.ts` split, the drift guard, the DSL-parser unit tests, and the
guidelines pass. This doc holds the items that were consciously left out of
that series — either because they are their own kind of change (a `spec/`
governance decision, a design split, a directory move) or because a phase's
premise turned out narrower than planned. Each is independent.

The two consolidated review documents this refactor executed against were
scratch notes and have been removed; their action list is fully accounted for
(done, or deferred here with a reason).

---

## 1. `types.ts` ↔ `spec/openapi.yaml`: full wire-type check, or codegen

Phase 5 shipped `tools/check-frontend-api-reference.sh`, which holds the filter
**operator list** and **condition cap** to `spec/openapi.yaml` (and, in
passing, `FilterOp` to the OpenAPI `op` enum). The originally-planned
`check-frontend-wire-types.sh` — asserting the `Column` / `Row` / `TableData`
/ `FilterCondition` / `CommonValue` / `Sibling` field names and requiredness
against the OpenAPI component schemas — was dropped: regex-comparing TS
interfaces (`Column` is now a three-member discriminated union) to YAML
schemas produces false positives and gets disabled within a month.

The real fix is **codegen**: generate `types.ts` from `openapi.yaml` at build
time, or write the check on a real OpenAPI + TS parser rather than a grep.
`api()` still casts `resp.json()` with no runtime validation — the one
normative wire surface with no guard at all.

## 2. `row-diff.ts` unit tests

Deferred from Phase 6. `rowKey()` is pure but trivial; the part worth testing
is `diffNewRows()`'s PK-diff (the reason `refresh-highlight.spec.ts` exists),
and that is entangled with `scopeKey()`, which reads `state`. Making it
`node --test`-able cleanly means moving `scopeKey` into `store.ts` so
`row-diff.ts` becomes a true leaf that imports nothing — a Phase-3-shaped
restructure not worth doing inside a test phase. Do that move first, then port
the PK-diff cases (same-scope, scope-changed, no-PK table).

## 3. `json-tree.ts` unit tests

Out of scope for Phase 6 by design, not by test-infrastructure gap.
`renderJsonTree` returns an `HTMLElement` built from 10+ `document.createElement`
calls — it is a DOM renderer. Unit-testing it needs either a DOM-shim
dependency (which Phase 6 deliberately avoided — plain `node --test`, no new
deps) or splitting it into a pure fold/shape function plus a thin renderer.
**That split is the task**, with its own review; `cell-preview.spec.ts` covers
it until then.

## 4. `tsconfig` `noUncheckedIndexedAccess`

Its own PR. Phase 4's `Column` discriminated union and the index-access guards
did some of the same nullability work incidentally, but turning the flag on
will surface real sites that rely on the current (flag-off) default — the cell
and row builders in `sidebar.ts` / `filter-ui.ts` / `grid.ts`, and the demo
fixtures. Land it after 1–3 so the type surface is settled.

## 5. A normative home for `max_json_bytes`

`spec/protocol.md` §5.4.2 describes only the Rust port's 8192-byte filter-AST
bound, as an example — not a cross-port MUST — and `spec/openapi.yaml` puts no
byte cap on the `filter` param. So Phase 5's guard checks `api-reference.ts`'s
`max_json_bytes` only for *internal* consistency (the `limits` object vs its
own prose). Giving it a real home means a `spec/` change: a MUST in
`protocol.md` and a `maxLength` (or documented bound) in `openapi.yaml`, which
every port then has to honour. If done, extend
`check-frontend-api-reference.sh` to assert against the spec value instead of
the self-check.

## 6. `demo-shim.ts` re-implementing the wire contract

`frontend/src/demo/demo-shim.ts` re-implements schema resolution, all ten
filter operators, `LIKE`→regex, typed sort, and pagination — a slice of
`spec/protocol.md` that conformance CI never exercises, shipped on the public
GitHub Pages demo. Phase 7 relocated it under `src/demo/` and fenced it off
(the `check-frontend-cycles.sh` boundary rule stops app code importing it),
but whether a second, unverified implementation of the wire contract should
exist at all is a `PORTING.md` governance question for the port owners, not a
frontend change. Options if it stays: run the conformance filter/sort table
against `demo-shim` too, or thin it to a canned-response fixture.

## 7. Restructure `frontend/src/` to a standard layout — DONE

Landed: `frontend/src/` is grouped into four role-based layers —
`bootstrap/` (main, controller, reload, table-focus), `core/` (api, dom,
types, state, store, url, row-diff), `features/` (grid, filter-ui, sidebar +
resize + bounds, nav, record-view, siblings, api-reference, theme), and
`lib/` (filter-dsl, json-tree, format). `demo/` is unchanged. Role-based was
chosen over feature-based so the shared renderers (`lib/format.ts`,
`lib/json-tree.ts`) have one home rather than a `shared/` catch-all.
`row-diff.ts` sits in `core/` with the state cluster (it imports `store.ts`,
so it is not yet a true leaf — see item 2). No CI rule enforces layer
direction yet; the cycle + demo-boundary checks are unchanged.

## 8. Revisit `tools/check-frontend-cycles.sh`

It is a hand-rolled Tarjan SCC over a regex-parsed import graph, embedded as a
`node -e` string inside a `sh` script, now also carrying the `src/demo/`
import-boundary check. It works and is dependency-free, but the regex has
already needed two fixes (re-export edges, `362328a`; `../` and nested paths,
Phase 7), and the single-quote `node -e '...'` embedding is fragile — an
apostrophe in a comment breaks the shell parse (hit twice during this
refactor).

Replacements to weigh: `madge --circular`, `dpdm`, `eslint-plugin-import`'s
`import/no-cycle` (if ESLint is ever added alongside Biome), or Biome's own
cycle rule once it ships. Any replacement must keep all three current
properties: `import type` edges excluded, re-export (`export … from`) edges
included, and the `src/` → `src/demo/` boundary assertion.

## 9. Spring / Gradle test flake under `mise run check`

`mise run check` runs `spring:build` and `spring:test` under mise's task
parallelism; they share one Kotlin incremental-compile cache and one Gradle
daemon, and under load that cache corrupts ("Could not close incremental
caches … `class-fq-name-to-source.tab`", "Detected multiple Kotlin daemon
sessions"), cascading into spurious `SQLSyntaxErrorException` / `EOFException`
failures in the MySQL/MariaDB tests. A clean serial
`./gradlew clean test --no-daemon` passes all 59 Spring tests.

This predates the refactor (whose only Spring change is a `build.gradle.kts`
sha256 pin). Fix candidates: make `spring:build` and `spring:test` mutually
exclusive in `mise.toml`, disable the Kotlin daemon / incremental compilation
for those tasks, or give each its own build dir. Low priority — CI runs the
Spring job in isolation, so only local `mise run check` hits it.
