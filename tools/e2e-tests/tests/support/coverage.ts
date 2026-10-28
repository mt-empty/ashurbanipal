import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import mcrOptions from "../../coverage/mcr.config.mjs";

const BUNDLE = fileURLToPath(new URL("../../coverage-results/bundle.js", import.meta.url));

// coverage/build-map.mjs writes the bundle and its map before the run; read once per worker.
let bundle: { js: string; map: { mappings: string } } | undefined;
function sideBuiltBundle() {
  bundle ??= { js: readFileSync(BUNDLE, "utf8"), map: JSON.parse(readFileSync(`${BUNDLE}.map`, "utf8")) };
  return bundle;
}

// The served script is the bundle after leading blank lines, so the map shifts down by that many lines.
function withSourceMap<T extends { source?: string }>(entry: T) {
  const { js, map } = sideBuiltBundle();
  const at = entry.source?.indexOf(js) ?? -1;
  const prefix = at > 0 ? (entry.source ?? "").slice(0, at) : "";
  if (at < 0 || !/^\s*$/.test(prefix) || (prefix && !prefix.endsWith("\n"))) {
    throw new Error(
      "the served script is not the side-built bundle: run frontend:rebuild, then coverage/build-map.mjs",
    );
  }
  return { ...entry, sourceMap: { ...map, mappings: ";".repeat(prefix.split("\n").length - 1) + map.mappings } };
}

/** Adds the V8 coverage of the page script for the test that `run` runs, for coverage/report.mjs. */
export async function recordCoverage(page: Page, run: () => Promise<void>) {
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await run();
  // Chromium sometimes also reports a partial copy of the page script (a few functions, no whole-script
  // range); the reporter counts every line such a copy leaves out as run, so only whole-script entries go in.
  const entries = (await page.coverage.stopJSCoverage()).filter(
    (e) =>
      e.source?.includes("// src/core/api.ts") &&
      e.functions[0]?.ranges[0]?.startOffset === 0 &&
      e.functions[0].ranges[0].endOffset === e.source.length,
  );
  const { default: MCR } = await import("monocart-coverage-reports");
  await MCR(mcrOptions).add(entries.map(withSourceMap));
}
