// Compares two start-up timing results cell by cell:
//   node perf/compare.mjs perf-results/startup-baseline-….json perf-results/startup-4.1-….json
import { readFileSync } from "node:fs";

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error("usage: node perf/compare.mjs <before.json> <after.json>");
  process.exit(2);
}

const load = (path) => JSON.parse(readFileSync(path, "utf8"));
const a = load(aPath);
const b = load(bPath);
const name = (r, path) => r.meta.label || path;

function median(samples, key) {
  const values = samples
    .map((s) => s[key])
    .filter((v) => typeof v === "number")
    .sort((x, y) => x - y);
  return values.length ? values[Math.ceil(values.length / 2) - 1] : undefined;
}

const key = (c) => `${c.scenario}|${c.network}|${c.server}`;
const before = new Map(a.cells.map((c) => [key(c), c]));
const networkOrder = b.meta.networks.map((n) => n.name);
const rows = b.cells
  .filter((c) => before.has(key(c)))
  .sort(
    (x, y) =>
      x.scenario.localeCompare(y.scenario) ||
      networkOrder.indexOf(x.network) - networkOrder.indexOf(y.network) ||
      x.server.localeCompare(y.server),
  );

const round = (v) => (v === undefined ? "–" : String(Math.round(v)));
const lines = [
  `Rows shown, median ms: ${name(a, aPath)} → ${name(b, bPath)}`,
  "",
  "| Scenario | Network | Server | Before | After | Change | API requests |",
  "|---|---|---|---|---|---|---|",
];
for (const c of rows) {
  const old = before.get(key(c));
  const x = median(old.samples, "rowsRenderedMs");
  const y = median(c.samples, "rowsRenderedMs");
  const change =
    x === undefined || y === undefined
      ? "–"
      : `${y - x >= 0 ? "+" : ""}${round(y - x)} (${round(((y - x) / x) * 100)}%)`;
  const requests = `${round(median(old.samples, "apiRequests"))} → ${round(median(c.samples, "apiRequests"))}`;
  lines.push(`| ${c.scenario} | ${c.network} | ${c.server} | ${round(x)} | ${round(y)} | ${change} | ${requests} |`);
}
console.log(lines.join("\n"));
