// Bundles frontend/src/demo/demo-shim.ts into docs/demo/index.html — a
// GitHub Pages-hostable copy of dbviewer.html wired to synthetic data.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const dir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const result = await esbuild.build({
  entryPoints: [`${dir}src/demo/demo-shim.ts`],
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
// Installed first in <head> so it runs before dbviewer.html's deferred
// type="module" script.
// Function replacer, not a string one — a string replacement would have
// its own literal `$\`` sequences (in shimScript) misread as a $-pattern.
const html = dbviewer.replace(marker, () => `${marker}\n<script>\n${shimScript}\n</script>`);

mkdirSync(`${repoRoot}docs/demo`, { recursive: true });
writeFileSync(`${repoRoot}docs/demo/index.html`, html);
