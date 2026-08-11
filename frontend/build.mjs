// Bundles frontend/src/ into the single generated frontend/dbviewer.html —
// see CLAUDE.md and docs/frontend-style-guide.md for why this stays one
// file even though it's now built from many.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const dir = fileURLToPath(new URL(".", import.meta.url));

const result = await esbuild.build({
  entryPoints: [`${dir}src/main.ts`],
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

if (!template.includes("/*ASHURBANIPAL_STYLE*/") || !template.includes("/*ASHURBANIPAL_SCRIPT*/")) {
  throw new Error("src/index.html is missing an ASHURBANIPAL_STYLE or ASHURBANIPAL_SCRIPT placeholder");
}
const html = template
  .replace("/*ASHURBANIPAL_STYLE*/", () => style)
  .replace("/*ASHURBANIPAL_SCRIPT*/", () => script);

writeFileSync(`${dir}dbviewer.html`, html);
