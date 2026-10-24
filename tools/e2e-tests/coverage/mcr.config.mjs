// Shared by the coverage fixture, which adds each test's V8 data, and report.mjs, which merges them.
import { fileURLToPath } from "node:url";

export default {
  name: "Ashurbanipal e2e coverage (Chromium)",
  outputDir: fileURLToPath(new URL("../coverage-results/report", import.meta.url)),
  // One family of reports, so the terminal table and the HTML report agree on what a covered line is.
  reports: ["v8", "console-details"],
  // esbuild names sources relative to frontend/.
  sourcePath: (p) => (p.startsWith("src/") ? `frontend/${p}` : p),
};
