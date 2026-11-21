# Frontend architecture refactor — deferred follow-ups

> **Status:** OPEN · **Area:** frontend

Frontend clean-ups left out of the `frontend/src/` refactor. Each item is
independent. Item IDs stay stable, so gaps in the numbering are expected.

## 1. `types.ts` ↔ `spec/openapi.yaml`: full wire-type check, or codegen

`tools/check-frontend-api-reference.sh` holds only the filter operator
list and the condition cap to `spec/openapi.yaml`. Nothing checks the
other wire types in `frontend/src/core/types.ts` (`Column`, `Row`,
`ViewData`, `StructureResponse`, …) against the OpenAPI schemas. A regex
compare is not worth it: `Column` is a three-member union, and such a
check gives false positives.

`api()` in `frontend/src/core/api.ts` returns `resp.json()` cast to `T`
with no runtime check. The schemathesis run (`conformance:schema-test`)
holds the servers to the schemas, but the frontend's side is unguarded.

Fix: generate `types.ts` from `openapi.yaml` at build time, or build the
check on a real OpenAPI and TypeScript parser.

## 4. `tsconfig` `noUncheckedIndexedAccess`

Its own PR. With the flag on, `tsc` reports 176 errors today, most in the
join parser and builder (`lib/join-dsl.ts`, `features/join-sql.ts`,
`lib/join-tokens.ts`, `lib/join-draft.ts`) and in
`demo/synthetic/serve.ts`. Land it after item 1 if codegen changes the
type surface.

## 8. Replace `tools/check-frontend-cycles.sh`

It is a hand-written Tarjan SCC over a regex-parsed import graph, run as a
`node -e '…'` string inside a `sh` script. It also checks that app code
never imports `src/demo/`. The regex is fragile, and an apostrophe in the
embedded JavaScript breaks the shell quoting.

Biome 2.6, the frontend's linter (`frontend/package.json`), now has
`suspicious/noImportCycles`, which skips `import type` edges by default
(`ignoreTypes`). Check first whether it fits. Other options: `madge
--circular` or `dpdm`. Any replacement must keep all three current
properties:

- `import type` edges excluded;
- re-export (`export … from`) edges included;
- the `src/` → `src/demo/` boundary check (Biome's `noRestrictedImports`
  may cover it, or keep it as a small script).

## 10. The JSON tree rounds large integers

Both JSON trees build from `JSON.parse(raw)`: the record view
(`frontend/src/features/record-view.ts`) and the cell popover
(`showCellPop` in `features/grid.ts`). So an integer above 2^53 shows
rounded: `9007199254740993` displays as `9007199254740992`
(`frontend/test/json-tree.test.ts`). Copy already keeps every digit
(`reindentJson`, `lib/json-text.ts`). Fix it once: a small
source-preserving parser in `frontend/src/lib/` that keeps each number's
text and feeds `foldJson` for both callers.
