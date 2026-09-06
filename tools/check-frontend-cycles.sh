#!/bin/sh
set -eu

# Fails if frontend/src/ has any import cycle in the value-import graph
# (`import type` edges excluded — erased at build, can't cause an
# evaluation-order cycle). Cycles route leaf view modules back through the
# composition root; the fix is an import-free seam (reload.ts) or moving a
# shared helper to a leaf (format.ts), never a back-edge. See
# docs/frontend-style-guide.md §1.
#
#   check-frontend-cycles.sh    # verify, exit 1 on any cycle

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

node -e '
const fs = require("node:fs");
const path = require("node:path");
const dir = path.join(process.argv[1], "frontend", "src");

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
const mod = (f) => f.replace(/\.ts$/, "");
const graph = new Map(files.map((f) => [mod(f), new Set()]));

// `import ... from "./x.js"` and side-effect `import "./x.js"`, minus
// `import type ...` (whole-statement type imports).
const importRe = /^\s*import\s+(?!type\s)(?:[^;]*?\sfrom\s+)?["]\.\/([\w.-]+)\.js["]/gm;

for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), "utf8");
  let m;
  while ((m = importRe.exec(src)) !== null) {
    const target = m[1];
    if (graph.has(target)) graph.get(mod(f)).add(target);
  }
}

// Tarjan SCC.
let idx = 0;
const index = new Map();
const low = new Map();
const onStack = new Set();
const stack = [];
const sccs = [];

function strongconnect(v) {
  index.set(v, idx);
  low.set(v, idx);
  idx++;
  stack.push(v);
  onStack.add(v);
  for (const w of graph.get(v)) {
    if (!index.has(w)) {
      strongconnect(w);
      low.set(v, Math.min(low.get(v), low.get(w)));
    } else if (onStack.has(w)) {
      low.set(v, Math.min(low.get(v), index.get(w)));
    }
  }
  if (low.get(v) === index.get(v)) {
    const comp = [];
    let w;
    do {
      w = stack.pop();
      onStack.delete(w);
      comp.push(w);
    } while (w !== v);
    sccs.push(comp);
  }
}

for (const v of graph.keys()) if (!index.has(v)) strongconnect(v);

const cycles = sccs.filter(
  (c) => c.length > 1 || graph.get(c[0]).has(c[0]),
);
if (cycles.length === 0) {
  console.log("frontend/src: no import cycles");
  process.exit(0);
}
for (const c of cycles) {
  console.error("import cycle: " + c.sort().join(" <-> "));
}
console.error(
  "\nBreak it with an import-free seam or a leaf helper module, not a back-edge (docs/frontend-style-guide.md §1).",
);
process.exit(1);
' "$root"
