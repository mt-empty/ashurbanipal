import { fileURLToPath } from "node:url";

// The page script's esbuild options, shared by build.mjs and the e2e coverage
// source map (tools/e2e-tests/coverage/build-map.mjs), which must match it byte for byte.
const dir = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");

export const pageBundleOptions = {
  entryPoints: [`${dir}/src/bootstrap/main.ts`],
  // Pins esbuild's inline path comments to frontend/ rather than process.cwd(),
  // so a build from the repo root matches one from frontend/ (frontend:build-check).
  absWorkingDir: dir,
  bundle: true,
  write: false,
  format: "esm",
  target: "es2022",
  minify: false,
  legalComments: "inline",
};
