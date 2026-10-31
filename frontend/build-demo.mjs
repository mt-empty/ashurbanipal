// Builds the GitHub Pages demos from frontend/src/demo/, both dbviewer.html
// with a script in front of it that answers /api/*:
//   docs/demo/index.html  synthetic — a build-time snapshot of the seeded
//                         sources (committed; frontend:build-demo-check)
//   docs/demo/live/       with --live — real Postgres in the browser: the page,
//                         its PGlite worker, and PGlite's files (never
//                         committed; built at deploy time by pages.yml)
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import * as esbuild from "esbuild";
import { importDemoEntry } from "./demo-node-entry.mjs";

const dir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pglite = `${dir}node_modules/@electric-sql/pglite/dist`;

const pageScriptOptions = {
  absWorkingDir: dir.replace(/\/$/, ""),
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  minify: false,
  legalComments: "inline",
};

const dbviewer = readFileSync(`${dir}dbviewer.html`, "utf8");
const marker = "<head>";
const count = dbviewer.split(marker).length - 1;
if (count !== 1) {
  throw new Error(`expected exactly one ${marker} in dbviewer.html, found ${count}`);
}
// Installed first in <head> so it runs before dbviewer.html's deferred
// type="module" script.
// Function replacer, not a string one — a string replacement would have
// its own literal `$\`` sequences (in the script) misread as a $-pattern.
const withScript = (script) => dbviewer.replace(marker, () => `${marker}\n<script>\n${script.trimEnd()}\n</script>`);

// Building the snapshot starts PGlite once per source, a few seconds that
// frontend:watch would otherwise pay on every save. Keyed on everything it reads.
async function cachedSnapshot() {
  const hash = createHash("sha256").update(readFileSync(`${pglite}/../package.json`));
  for (const root of [`${dir}src/demo`, `${repoRoot}implementations/node-express/src`]) {
    for (const file of readdirSync(root, { recursive: true }).sort()) {
      const path = `${root}/${file}`;
      if (statSync(path).isFile()) hash.update(path).update(readFileSync(path));
    }
  }
  const cache = `${dir}node_modules/.cache/ashurbanipal-demo/snapshot-${hash.digest("hex").slice(0, 16)}.json`;
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
  const { buildSnapshot } = await importDemoEntry("snapshot");
  const snapshot = await buildSnapshot();
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(cache, JSON.stringify(snapshot));
  return snapshot;
}

const snapshot = await cachedSnapshot();
const synthetic = await esbuild.build({
  ...pageScriptOptions,
  entryPoints: [`${dir}src/demo/synthetic/shim.ts`],
  plugins: [
    {
      name: "demo-snapshot",
      setup(build) {
        build.onResolve({ filter: /^virtual:demo-snapshot$/ }, (args) => ({ path: args.path, namespace: "demo" }));
        build.onLoad({ filter: /.*/, namespace: "demo" }, () => ({ contents: JSON.stringify(snapshot), loader: "json" }));
      },
    },
  ],
});
mkdirSync(`${repoRoot}docs/demo`, { recursive: true });
writeFileSync(`${repoRoot}docs/demo/index.html`, withScript(synthetic.outputFiles[0].text));

if (process.argv.includes("--live")) {
  const out = `${repoRoot}docs/demo/live`;
  mkdirSync(out, { recursive: true });
  const shim = await esbuild.build({ ...pageScriptOptions, entryPoints: [`${dir}src/demo/live/shim.ts`] });
  writeFileSync(`${out}/index.html`, withScript(shim.outputFiles[0].text));
  await esbuild.build({
    entryPoints: [`${dir}src/demo/live/worker.ts`],
    absWorkingDir: dir.replace(/\/$/, ""),
    outfile: `${out}/pglite-worker.js`,
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: true,
    loader: { ".sql": "text" },
    // Emscripten's Node-only branch; never reached in a browser.
    external: ["node:*"],
    inject: [`${dir}src/demo/live/buffer-shim.ts`],
    logLevel: "warning",
  });
  copyFileSync(`${pglite}/pglite.wasm`, `${out}/pglite.wasm`);
  copyFileSync(`${pglite}/initdb.wasm`, `${out}/initdb.wasm`);
  writeFileSync(`${out}/pglite.data.gz`, gzipSync(readFileSync(`${pglite}/pglite.data`), { level: 9 }));
}
