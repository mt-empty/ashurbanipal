// The live demo's page side: answers /api/* by forwarding to one PGlite
// worker per source, started on first use. Bundled by build-demo.mjs into
// docs/demo/live/index.html; the worker is docs/demo/live/pglite-worker.js.
import { withDefaults } from "../../../../implementations/node-express/src/config.js";
import { installFetch, showBadge } from "../page-shim.js";
import { SIBLINGS, SIBLINGS_INSTANCE } from "../siblings.js";
import { DEMO_SOURCES } from "../sources.js";
import { type ApiResponse, json, problem } from "../wire.js";
import type { FromWorker, ToWorker } from "./worker.js";

declare global {
  interface Window {
    // Test hook: tools/e2e-tests' demo spec lowers it to force a query_timeout.
    __DEMO_QUERY_TIMEOUT_MS?: number;
  }
}
// The host default; time spent starting Postgres doesn't count against it.
const DEFAULT_TIMEOUT_MS = withDefaults(undefined).queryTimeoutSecs * 1000;

const setStatus = showBadge("Real Postgres 18 (PGlite) in your browser", "Lighter demo →", "../");

interface Pending {
  path: string;
  params: URLSearchParams;
  settle: (r: ApiResponse) => void;
  timer?: ReturnType<typeof setTimeout>;
}
interface DemoWorker {
  worker: Worker;
  ready: Promise<void>;
  pending: Map<number, Pending>;
}
const workers = new Map<string, DemoWorker>();
let nextId = 0;
let starting = 0;

function workerFor(source: string): DemoWorker {
  const existing = workers.get(source);
  if (existing) return existing;
  const worker = new Worker(new URL("pglite-worker.js", location.href), { type: "module", name: source });
  const entry: DemoWorker = { worker, ready: Promise.resolve(), pending: new Map() };
  let isReady = false;
  setStatus(`starting Postgres (${source})…`);
  starting++;
  entry.ready = new Promise<void>((resolve, reject) => {
    worker.onmessage = ({ data }: MessageEvent<FromWorker>) => {
      if (data.type === "ready") {
        isReady = true;
        resolve();
      } else if (data.type === "failed") reject(new Error(data.message));
      else if (data.type === "started") {
        const p = entry.pending.get(data.id);
        if (p) p.timer = setTimeout(() => stop(source, entry, data.id), timeoutMs());
      } else {
        const p = entry.pending.get(data.id);
        entry.pending.delete(data.id);
        clearTimeout(p?.timer);
        p?.settle(data.response);
      }
    };
    worker.onerror = (e) => {
      const message = e.message || "the database worker stopped";
      if (isReady) crash(source, entry, message);
      else reject(new Error(message));
    };
  }).finally(() => {
    if (--starting === 0) setStatus("");
  });
  workers.set(source, entry);
  return entry;
}

const timeoutMs = () => window.__DEMO_QUERY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS;

function retire(source: string, entry: DemoWorker): [number, Pending][] {
  entry.worker.terminate();
  if (workers.get(source) === entry) workers.delete(source);
  const pending = [...entry.pending];
  entry.pending.clear();
  for (const [, p] of pending) clearTimeout(p.timer);
  return pending;
}

// A running query can't be cancelled inside PGlite, so the worker goes. The
// requests queued behind it never started; they run again on a fresh worker.
function stop(source: string, entry: DemoWorker, timedOut: number): void {
  for (const [id, p] of retire(source, entry)) {
    if (id === timedOut) p.settle(problem(500, "query_timeout", "query timed out"));
    else void forward(source, p.path, p.params).then(p.settle);
  }
}

function crash(source: string, entry: DemoWorker, message: string): void {
  console.error(`ashurbanipal demo: the ${source} database stopped:`, message);
  for (const [, p] of retire(source, entry)) p.settle(problem(500, "database_error", `database error: ${message}`));
}

async function forward(source: string, path: string, params: URLSearchParams): Promise<ApiResponse> {
  const entry = workerFor(source);
  try {
    await entry.ready;
  } catch (err) {
    retire(source, entry);
    console.error("ashurbanipal demo: the database did not start", err);
    return problem(500, "database_error", `database error: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The worker may have been retired while this request waited for it.
  if (workers.get(source) !== entry) return forward(source, path, params);
  const id = nextId++;
  const message: ToWorker = { id, path, query: params.toString() };
  return new Promise<ApiResponse>((settle) => {
    entry.pending.set(id, { path, params, settle });
    entry.worker.postMessage(message);
  });
}

installFetch(async (path, params) => {
  if (path === "/sources") {
    return json({ sources: DEMO_SOURCES.map((name) => ({ name })), default: DEMO_SOURCES[0] });
  }
  if (path === "/siblings") return json({ instance: SIBLINGS_INSTANCE, siblings: SIBLINGS });
  const source = params.get("source") ?? DEMO_SOURCES[0];
  if (!(DEMO_SOURCES as readonly string[]).includes(source)) {
    return problem(400, "unknown_source", `source ${JSON.stringify(source)}`);
  }
  return forward(source, path, params);
});
