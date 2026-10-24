// Builds the page script with an external source map, beside the shipped page
// rather than in it, so the coverage report can name frontend/src lines.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { pageBundleOptions } from "../../../frontend/bundle-options.mjs";

const FRONTEND = fileURLToPath(new URL("../../../frontend", import.meta.url));
const OUT = fileURLToPath(new URL("../coverage-results", import.meta.url));
const esbuild = createRequire(`${FRONTEND}/package.json`)("esbuild");

const result = await esbuild.build({ ...pageBundleOptions, sourcemap: "external", outfile: "bundle.js" });
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/bundle.js`, result.outputFiles.find((f) => f.path.endsWith(".js")).text.trimEnd());
writeFileSync(`${OUT}/bundle.js.map`, result.outputFiles.find((f) => f.path.endsWith(".map")).text);
