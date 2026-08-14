// Bundles frontend/src/demo-shim.ts into docs/demo/index.html — a
// GitHub Pages-hostable copy of frontend/dbviewer.html wired to synthetic
// in-browser data (frontend/src/demo-fixtures.ts) instead of a live
// backend. See mise.toml's frontend:build-demo task. Requires
// dbviewer.html to already be built (`mise run frontend:build`).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const dir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const result = await esbuild.build({
  entryPoints: [`${dir}src/demo-shim.ts`],
  absWorkingDir: dir.replace(/\/$/, ""),
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  minify: false,
  legalComments: "inline",
});
const shimScript = result.outputFiles[0].text.trimEnd();

const dbviewer = readFileSync(`${dir}dbviewer.html`, "utf8");
const marker = "<head>";
const count = dbviewer.split(marker).length - 1;
if (count !== 1) {
  throw new Error(`expected exactly one ${marker} in dbviewer.html, found ${count}`);
}
// Installed as the first thing in <head> — a classic script runs
// synchronously during parsing, before dbviewer.html's own
// type="module" script (deferred by spec), so window.fetch is already
// patched by the time the app makes its first API call.
// A function replacer, not a string one: String.replace interprets `$`
// patterns (e.g. $`) in a *string* replacement, and the shim's own source
// contains literal `$\`` sequences (template-literal regex building) that
// would otherwise get swapped for arbitrary surrounding document text.
const html = dbviewer.replace(marker, () => `${marker}\n<script>\n${shimScript}\n</script>`);

mkdirSync(`${repoRoot}docs/demo`, { recursive: true });
writeFileSync(`${repoRoot}docs/demo/index.html`, html);
