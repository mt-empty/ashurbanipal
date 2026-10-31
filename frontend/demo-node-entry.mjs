// Runs one of frontend/src/demo/build/*.ts under Node: bundles it (the demo
// imports node-express sources by their .js names, which Node's own type
// stripping can't resolve) and imports the result.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const dir = fileURLToPath(new URL(".", import.meta.url));

export async function importDemoEntry(name) {
  const result = await esbuild.build({
    entryPoints: [`${dir}src/demo/build/${name}.ts`],
    absWorkingDir: dir.replace(/\/$/, ""),
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node24",
    // Packages stay external and resolve from frontend/node_modules, which is
    // why the bundle is written under it.
    packages: "external",
    loader: { ".sql": "text" },
    logLevel: "warning",
  });
  const out = `${dir}node_modules/.cache/ashurbanipal-demo`;
  mkdirSync(out, { recursive: true });
  const file = `${out}/${name}.mjs`;
  writeFileSync(file, result.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}
