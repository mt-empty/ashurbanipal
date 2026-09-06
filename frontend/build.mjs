// Bundles frontend/src/ into the single generated frontend/dbviewer.html —
// see CLAUDE.md and docs/frontend-style-guide.md for why this stays one
// file even though it's now built from many.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const dir = fileURLToPath(new URL(".", import.meta.url));

const result = await esbuild.build({
  entryPoints: [`${dir}src/main.ts`],
  // Pins esbuild's inline path comments to this script's own directory
  // rather than process.cwd() (esbuild's default) — otherwise `node
  // build.mjs` from the repo root vs. from frontend/ (what the mise task
  // does) produces byte-different output, which is exactly what
  // frontend:build-check exists to catch.
  absWorkingDir: dir.replace(/\/$/, ""),
  bundle: true,
  write: false,
  format: "esm",
  target: "es2022",
  minify: false,
  legalComments: "inline",
});
const script = result.outputFiles[0].text.trimEnd();

const style = readFileSync(`${dir}src/styles.css`, "utf8").trimEnd();
const template = readFileSync(`${dir}src/index.html`, "utf8");

// Requires exactly one occurrence of `marker` — not just "at least one" —
// so a stray duplicate placeholder fails loudly instead of only the first
// copy getting filled in.
function splice(text, marker, value) {
  const count = text.split(marker).length - 1;
  if (count !== 1) {
    throw new Error(`expected exactly one ${marker} placeholder in src/index.html, found ${count}`);
  }
  return text.replace(marker, () => value);
}

// Pre-paint sidebar bounds: index.html's standalone <script> runs before the
// module bundle and can't import at runtime, so build.mjs imports the shared
// leaf and injects its values into that script.
const { SIDEBAR_W_KEY, SIDEBAR_MIN_W, SIDEBAR_MAX_W } = await import(`${dir}src/sidebar-bounds.ts`);
const sidebarBounds =
  `var ASHURBANIPAL_SIDEBAR_W_KEY = ${JSON.stringify(SIDEBAR_W_KEY)}, ` +
  `ASHURBANIPAL_SIDEBAR_MIN = ${SIDEBAR_MIN_W}, ` +
  `ASHURBANIPAL_SIDEBAR_MAX = ${SIDEBAR_MAX_W};`;

let html = splice(template, "/*ASHURBANIPAL_STYLE*/", style);
html = splice(html, "/*ASHURBANIPAL_SCRIPT*/", script);
html = splice(html, "/*ASHURBANIPAL_SIDEBAR_BOUNDS*/", sidebarBounds);
// Guards against the marker text reappearing post-substitution (e.g. the
// bundled script or CSS happening to contain a literal placeholder
// string), which would otherwise silently ship broken markup.
for (const marker of ["/*ASHURBANIPAL_STYLE*/", "/*ASHURBANIPAL_SCRIPT*/", "/*ASHURBANIPAL_SIDEBAR_BOUNDS*/"]) {
  if (html.includes(marker)) {
    throw new Error(`a placeholder marker survived substitution (${marker}) — check content for a literal match`);
  }
}

writeFileSync(`${dir}dbviewer.html`, html);
