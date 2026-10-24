import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page, TestInfo } from "@playwright/test";

const RAW_DIR = fileURLToPath(new URL("../../coverage-results/raw", import.meta.url));

// The innermost V8 block range decides an offset's count, so ranges are
// applied outermost first. A line counts as run when its first non-blank
// character ran.
function coveredLines(source: string, functions: { ranges: { startOffset: number; endOffset: number; count: number }[] }[]) {
  const count = new Int32Array(source.length).fill(-1);
  const ranges = functions
    .flatMap((f) => f.ranges)
    .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const r of ranges) count.fill(r.count, r.startOffset, Math.min(r.endOffset, source.length));
  const covered: number[] = [];
  let offset = 0;
  source.split("\n").forEach((text, i) => {
    const first = text.search(/\S/);
    if (first >= 0 && count[offset + first] > 0) covered.push(i);
    offset += text.length + 1;
  });
  return covered;
}

/** Records which lines of the page's bundled module script the test ran, for coverage/report.mjs. */
export async function recordCoverage(page: Page, info: TestInfo, run: () => Promise<void>) {
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await run();
  // A reload runs the bundle again as a new script, so entries are merged.
  const entries = (await page.coverage.stopJSCoverage()).filter((e) => e.source?.includes("// src/core/api.ts"));
  const lines = new Set<number>();
  for (const e of entries) for (const l of coveredLines(e.source ?? "", e.functions)) lines.add(l);
  mkdirSync(RAW_DIR, { recursive: true });
  if (entries[0] && !existsSync(`${RAW_DIR}/source.js`)) writeFileSync(`${RAW_DIR}/source.js`, entries[0].source ?? "");
  const id = `${info.titlePath.join(" ").replace(/[^\w.-]+/g, "_").slice(0, 180)}_${info.repeatEachIndex}`;
  writeFileSync(
    `${RAW_DIR}/${id}.json`,
    JSON.stringify({ file: info.file.split("/").pop(), covered: [...lines] }),
  );
}
