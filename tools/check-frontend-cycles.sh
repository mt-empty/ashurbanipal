#!/bin/sh
set -eu

# Two checks over frontend/src/:
#   1. no import cycle in the value-import graph (`import type` edges
#      excluded — erased at build, can't cause an evaluation-order cycle).
#      The fix is an import-free seam (reload.ts) or moving a shared helper
#      to a leaf (format.ts), never a back-edge.
#   2. no app module (anything not under src/demo/) imports src/demo/ — the
#      offline-demo backend is bundled only by build-demo.mjs.
# See docs/frontend-style-guide.md §1.
#
#   check-frontend-cycles.sh    # verify, exit 1 on a cycle or a boundary breach

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

node -e '
const fs = require("node:fs");
const path = require("node:path");
const SRC = path.join(process.argv[1], "frontend", "src");

function walk(d) {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}
const files = walk(SRC);
const key = (abs) => path.relative(SRC, abs).replace(/\.ts$/, "");
const graph = new Map(files.map((f) => [key(f), new Set()]));
const isDemo = (k) => k === "demo" || k.startsWith("demo/");

// Value-graph edges: `import ... from "./x.js"`, side-effect
// `import "./x.js"`, and re-export `export ... from "./x.js"` (a barrel
// re-export triggers evaluation of the re-exported module, same as a value
// import) — minus whole-statement `import type` / `export type`, erased at
// build. The specifier keeps its ./ or ../ and any slashes.
const edgeRe = /^\s*(?:import\s+(?!type\s)(?:[^;]*?\sfrom\s+)?|export\s+(?!type\s)[^;]*?\sfrom\s+)["](\.\.?\/[\w./-]+)\.js["]/gm;

const boundary = [];
for (const f of files) {
  const from = key(f);
  const src = fs.readFileSync(f, "utf8");
  let m;
  while ((m = edgeRe.exec(src)) !== null) {
    const to = path.relative(SRC, path.resolve(path.dirname(f), `${m[1]}.ts`)).replace(/\.ts$/, "");
    if (!graph.has(to)) continue;
    graph.get(from).add(to);
    if (isDemo(to) && !isDemo(from)) boundary.push(`${from} -> ${to}`);
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

const cycles = sccs.filter((c) => c.length > 1 || graph.get(c[0]).has(c[0]));
let failed = false;
for (const c of cycles) {
  failed = true;
  console.error("import cycle: " + c.sort().join(" <-> "));
}
if (cycles.length) {
  console.error("\nBreak it with an import-free seam or a leaf helper module, not a back-edge (docs/frontend-style-guide.md §1).");
}
for (const b of boundary) {
  failed = true;
  console.error("demo boundary: app module imports src/demo/ — " + b);
}
if (boundary.length) {
  console.error("\nsrc/demo/ is the offline-demo backend, bundled only by build-demo.mjs; app code must never import it.");
}
if (failed) process.exit(1);
console.log("frontend/src: no import cycles, no demo-boundary breach");
' "$root"
