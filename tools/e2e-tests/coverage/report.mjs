// Summarises coverage-results/raw (written by coverage/hook.ts) per frontend/src
// module and per spec, and writes the same text to coverage-results/summary.txt.
// Line coverage shows code ran, not that a test checked what it did.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RAW = fileURLToPath(new URL("../coverage-results/raw", import.meta.url));
const SUMMARY = fileURLToPath(new URL("../coverage-results/summary.txt", import.meta.url));

const source = readFileSync(`${RAW}/source.js`, "utf8").split("\n");
const tests = readdirSync(RAW)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(`${RAW}/${f}`, "utf8")));

// The bundle is unminified and esbuild starts each module with a `// src/<path>.ts` comment.
const runnable = new Map();
let module = "(prelude)";
source.forEach((text, i) => {
  const marker = text.match(/^\/\/ (src\/\S+\.ts)$/);
  if (marker) module = marker[1];
  const s = text.trim();
  if (!s || /^(\/\/|\/\*|\*|import |export \{)/.test(s) || /^[\s{}()[\];,]*$/.test(s)) return;
  if (!runnable.has(module)) runnable.set(module, new Set());
  runnable.get(module).add(i);
});

const hits = new Map();
for (const t of tests) for (const l of t.covered) hits.set(l, (hits.get(l) ?? 0) + 1);
// Lines every test runs are start-up code; reaching them says nothing about a module's tests.
const startup = new Set([...hits].filter(([, n]) => n === tests.length).map(([l]) => l));

const out = [];
const ranges = (lines) => {
  const rs = [];
  for (const l of lines) {
    const last = rs.at(-1);
    if (last && l === last[1] + 1) last[1] = l;
    else rs.push([l, l]);
  }
  return rs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(" ");
};

let total = 0;
let covered = 0;
const rows = [...runnable].map(([m, lines]) => {
  const run = [...lines].filter((l) => hits.has(l));
  total += lines.size;
  covered += run.length;
  return {
    m,
    n: lines.size,
    pct: (100 * run.length) / lines.size,
    reach: tests.filter((t) => t.covered.some((l) => lines.has(l) && !startup.has(l))).length,
    missed: ranges([...lines].filter((l) => !hits.has(l)).map((l) => l + 1)),
  };
});
out.push(`${tests.length} tests, ${startup.size} start-up lines run by all of them`);
out.push(`overall ${covered}/${total} runnable lines = ${((100 * covered) / total).toFixed(1)}%`, "");
out.push("module | runnable lines | run % | tests past start-up | lines never run (in the vendored dbviewer.html script)");
for (const r of rows.sort((a, b) => a.pct - b.pct || a.reach - b.reach))
  out.push(`${r.m} | ${r.n} | ${r.pct.toFixed(1)} | ${r.reach} | ${r.missed}`);

const bySpec = new Map();
for (const t of tests) {
  if (!bySpec.has(t.file)) bySpec.set(t.file, new Set());
  for (const l of t.covered) bySpec.get(t.file).add(l);
}
out.push("", "spec | tests | lines run | lines no other spec runs | tests running a line no other test runs");
for (const [f, lines] of [...bySpec].sort()) {
  const others = new Set([...bySpec].filter(([g]) => g !== f).flatMap(([, s]) => [...s]));
  const own = tests.filter((t) => t.file === f);
  out.push(
    `${f} | ${own.length} | ${lines.size} | ${[...lines].filter((l) => !others.has(l)).length} | ${own.filter((t) => t.covered.some((l) => hits.get(l) === 1)).length}`,
  );
}
const text = `${out.join("\n")}\n`;
writeFileSync(SUMMARY, text);
process.stdout.write(text);
