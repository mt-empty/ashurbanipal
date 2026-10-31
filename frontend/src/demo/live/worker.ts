// The live demo's database: one module worker per source (its name), so a
// slow query never blocks the page and the page can stop it by terminating
// the worker — PGlite ignores statement_timeout.
import { withDefaults } from "../../../../implementations/node-express/src/config.js";
import { handleApi, type NamedSource } from "../../../../implementations/node-express/src/handlers.js";
import { SEEDS } from "../seeds.js";
import { DEMO_SOURCES, type DemoSource } from "../sources.js";
import type { ApiResponse } from "../wire.js";
import { openSource } from "./open-source.js";

export type ToWorker = { id: number; path: string; query: string };
export type FromWorker =
  | { type: "ready" }
  | { type: "failed"; message: string }
  | { type: "started"; id: number }
  | { type: "response"; id: number; response: ApiResponse };

const post = (message: FromWorker) => self.postMessage(message);
const asset = (name: string) => new URL(name, import.meta.url);

// GitHub Pages may or may not add Content-Encoding to a .gz file; the gzip
// magic bytes say whether the browser already unpacked it.
async function fsBundle(): Promise<Blob> {
  const bytes = new Uint8Array(await (await fetch(asset("pglite.data.gz"))).arrayBuffer());
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new Blob([bytes]);
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).blob();
}

const sources: Promise<NamedSource[]> = (async () => {
  const name = self.name as DemoSource;
  if (!DEMO_SOURCES.includes(name)) throw new Error(`unknown demo source ${JSON.stringify(name)}`);
  const [pgliteWasmModule, initdbWasmModule, data] = await Promise.all([
    WebAssembly.compileStreaming(fetch(asset("pglite.wasm"))),
    WebAssembly.compileStreaming(fetch(asset("initdb.wasm"))),
    fsBundle(),
  ]);
  const source = await openSource(SEEDS[name], { pgliteWasmModule, initdbWasmModule, fsBundle: data });
  return [{ name, source }];
})();
sources.then(
  () => post({ type: "ready" }),
  (err: unknown) => post({ type: "failed", message: err instanceof Error ? err.message : String(err) }),
);

const OPTIONS = { limits: withDefaults(undefined), siblings: async () => ({ siblings: [] }) };

// One request at a time (PGlite has one connection anyway), announced as it
// starts so the page times the query, not its wait in this queue.
let queue = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<ToWorker>) => {
  queue = queue.then(async () => {
    const ready = await sources;
    post({ type: "started", id: data.id });
    const params = new URLSearchParams(data.query);
    const response = await handleApi(ready, data.path, (key) => params.get(key) ?? undefined, OPTIONS);
    post({ type: "response", id: data.id, response });
  });
};
