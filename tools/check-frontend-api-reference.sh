#!/bin/sh
set -eu

# The filter operator list and the filter limits are restated in several
# places that nothing else keeps aligned:
#   - spec/openapi.yaml       — FilterCondition.op enum, filter maxItems
#   - frontend/src/types.ts   — the FilterOp union
#   - frontend/src/api-reference.ts — the in-app API reference dialog
#   - frontend/src/filter-dsl.ts    — FILTER_MAX_CONDITIONS
#   - frontend/src/demo/demo-shim.ts     — VALID_OPS (offline demo backend)
# spec/openapi.yaml is the source of truth for the operator set and the
# condition cap. max_json_bytes has no normative home (spec/protocol.md
# §5.4.2 describes only the Rust port's bound), so it is checked only for
# internal consistency between api-reference.ts's limits object and its
# own prose. Verify-only: the restatements are few and the message points
# at the exact mismatch.
#
#   check-frontend-api-reference.sh    # verify, exit 1 on drift

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

node -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const problems = [];
const fail = (m) => problems.push(m);

const quoted = (s) => [...(s || "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);
const sortU = (a) => [...new Set(a)].sort();
const sameSet = (a, b) => {
  const x = sortU(a), y = sortU(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
const cap = (re, s) => (s.match(re) || [])[1];

const openapi = read("spec/openapi.yaml");
const types = read("frontend/src/types.ts");
const apiRef = read("frontend/src/api-reference.ts");
const dsl = read("frontend/src/filter-dsl.ts");
const demoShim = read("frontend/src/demo/demo-shim.ts");

// ---- operator set: spec is canonical, three frontend copies must match ----
const specOps = quoted(cap(/enum:\s*(\[[^\]]*"IS NOT NULL"[^\]]*\])/, openapi));
const typeOps = quoted(cap(/export type FilterOp\s*=\s*([^;]+);/, types));
const refOps = quoted(cap(/operators:\s*(\[[^\]]*\])/, apiRef));
const demoOps = quoted(cap(/VALID_OPS\s*=\s*new Set<FilterOp>\(\s*(\[[^\]]*\])/, demoShim));

if (specOps.length !== 10) fail("could not read the op enum from spec/openapi.yaml");
if (!sameSet(typeOps, specOps))
  fail(`types.ts FilterOp ${JSON.stringify(sortU(typeOps))} != spec/openapi.yaml op enum ${JSON.stringify(sortU(specOps))}`);
if (!sameSet(refOps, specOps))
  fail(`api-reference.ts operators ${JSON.stringify(sortU(refOps))} != spec/openapi.yaml op enum`);
if (!sameSet(demoOps, specOps))
  fail(`demo-shim.ts VALID_OPS ${JSON.stringify(sortU(demoOps))} != spec/openapi.yaml op enum`);

// ---- condition cap: spec maxItems is canonical ----
const specMax = Number(cap(/^\s*maxItems:\s*(\d+)/m, openapi));
const dslMax = Number(cap(/FILTER_MAX_CONDITIONS\s*=\s*(\d+)/, dsl));
const refMax = Number(cap(/max_conditions:\s*(\d+)/, apiRef));
if (!specMax) fail("could not read maxItems from spec/openapi.yaml");
if (dslMax !== specMax) fail(`filter-dsl.ts FILTER_MAX_CONDITIONS (${dslMax}) != spec/openapi.yaml maxItems (${specMax})`);
if (refMax !== specMax) fail(`api-reference.ts limits.max_conditions (${refMax}) != spec/openapi.yaml maxItems (${specMax})`);

// ---- api-reference.ts internal: limits object vs its own prose ----
const refBytes = Number(cap(/max_json_bytes:\s*(\d+)/, apiRef));
const prose = apiRef.match(/at most (\d+) conditions and (\d+) bytes/);
if (!prose) fail("could not find the conditions/bytes sentence in api-reference.ts");
else {
  if (Number(prose[1]) !== refMax)
    fail(`api-reference.ts prose says ${prose[1]} conditions, limits object says ${refMax}`);
  if (Number(prose[2]) !== refBytes)
    fail(`api-reference.ts prose says ${prose[2]} bytes, limits object says ${refBytes}`);
}

if (problems.length) {
  for (const p of problems) console.error("drift: " + p);
  console.error("\nAlign the restated operator list / filter limits (spec/openapi.yaml is canonical for the operator set and the condition cap).");
  process.exit(1);
}
console.log("frontend api-reference: operator list and filter limits in sync");
' "$root"
