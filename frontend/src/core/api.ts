import type { SchemasResponse, SourcesResponse } from "./types.js";

// Derived from the page's own URL, not hardcoded, so the UI works behind
// any reverse-proxy prefix; trailing slashes stripped so /x/ and /x agree.
export const API = `${location.pathname.replace(/\/+$/, "")}/api`;

// ==== Protocol version skew ====
// The frontend artifact ships separately from backends (ports vendor this
// file), so the first /tables response's x-ashurbanipal-protocol header is
// compared against the version this file speaks. A mismatch — or a missing
// header — is handed to a subscriber (main.ts shows the banner); it never
// blocks: a skewed pairing usually still mostly works, and refusing to
// render would be strictly worse than degraded browsing.
const PROTOCOL_VERSION = "1";
let protocolChecked = false;
let skewMessage: string | null = null;
let skewSubscriber: ((message: string) => void) | null = null;

// The first /tables fetch can resolve before main.ts's body registers the
// subscriber, so a message that already arrived is replayed on registration.
export function onProtocolSkew(cb: (message: string) => void): void {
  skewSubscriber = cb;
  if (skewMessage !== null) cb(skewMessage);
}

function checkProtocolVersion(resp: Response): void {
  if (protocolChecked) return;
  protocolChecked = true;
  const got = resp.headers.get("x-ashurbanipal-protocol");
  if (got === PROTOCOL_VERSION) return;
  skewMessage =
    `protocol version mismatch: this UI speaks v${PROTOCOL_VERSION}, ` +
    `the server reports ${got ? `v${got}` : "no version"} — some features may misbehave`;
  skewSubscriber?.(skewMessage);
}

// spec/protocol.md §2: error bodies are RFC 9457 application/problem+json
// carrying a stable `code`. `code` is exposed for callers that want to
// branch on it (e.g. a `not_readable` drill-in); everything else can keep
// treating a thrown ApiError as a plain Error and read `.message`.
export class ApiError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code: string | undefined) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

async function errorFromResponse(resp: Response): Promise<ApiError> {
  // An unrecognized/absent `code` still yields a usable message — clients
  // MUST treat it as a generic error of the given status (spec/protocol.md §2).
  try {
    const body: unknown = await resp.json();
    if (body && typeof body === "object" && "title" in body && typeof body.title === "string") {
      const code = "code" in body && typeof body.code === "string" ? body.code : undefined;
      return new ApiError(body.title, code);
    }
  } catch {
    /* fall through to the generic message below */
  }
  return new ApiError(`request failed with status ${resp.status}`, undefined);
}

// ==== Requests sent ahead ====
// A request sent before anything asks for it (start-up's, a hovered chip's, the
// next page); the first api() call for the same request takes the answer
// instead of asking again. Each answer is used at most once.
type PrefetchKind = "boot" | "view";

interface Prefetched {
  kind: PrefetchKind;
  path: string;
  route: string;
  params: URLSearchParams;
  response: Promise<Response>;
  expires: number;
}

let prefetched: Prefetched[] = [];

// Start-up's requests go out before the source and schema are known, so they
// may leave either out; the server's defaults, read from its own answers to
// /sources and /schemas, decide what they stand for.
let defaultSource: string | null | undefined;
let defaultSchema: string | null | undefined;
let defaultsRead: Promise<unknown> = Promise.resolve();

function readDefault(response: Promise<Response>, set: (value: string | null) => void): void {
  const read = response
    .then((r) => (r.ok ? r.clone().json() : null))
    .then((body: SourcesResponse | SchemasResponse | null) => set(body?.default ?? null))
    .catch(() => set(null));
  defaultsRead = Promise.all([defaultsRead, read]);
}

function dropExpired(): number {
  const now = performance.now();
  prefetched = prefetched.filter((p) => p.expires > now);
  return now;
}

function splitPath(path: string): [route: string, params: URLSearchParams] {
  const [route, query = ""] = path.split("?");
  return [route, new URLSearchParams(query)];
}

export function prefetch(path: string, kind: PrefetchKind, ttlMs = Number.POSITIVE_INFINITY): void {
  const now = dropExpired();
  if (prefetched.some((p) => p.path === path)) return;
  const response = fetch(API + path);
  // A failed request surfaces when an api() call takes it, and only then.
  response.catch(() => {});
  const [route, params] = splitPath(path);
  prefetched.push({ kind, path, route, params, response, expires: now + ttlMs });
  if (kind !== "boot") return;
  if (route === "/sources") readDefault(response, (v) => (defaultSource = v));
  if (route === "/schemas") readDefault(response, (v) => (defaultSchema = v));
}

export function clearPrefetched(kind: PrefetchKind): void {
  prefetched = prefetched.filter((p) => p.kind !== kind);
}

const SCOPE_KEYS = new Set(["source", "schema"]);
const otherParams = (params: URLSearchParams) =>
  [...params]
    .filter(([k]) => !SCOPE_KEYS.has(k))
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("&");

// A start-up request that left the source or schema out matches only if the
// server's default is exactly what the caller now asks for.
function sameRequest(p: Prefetched, route: string, params: URLSearchParams): boolean {
  if (p.kind !== "boot" || p.route !== route || otherParams(p.params) !== otherParams(params)) return false;
  const source = (q: URLSearchParams) => q.get("source") ?? defaultSource;
  const schema = (q: URLSearchParams) => q.get("schema") ?? (route === "/schemas" ? null : defaultSchema);
  return source(p.params) === source(params) && schema(p.params) === schema(params);
}

async function takePrefetched(path: string): Promise<Response | undefined> {
  dropExpired();
  let found = prefetched.find((p) => p.path === path);
  if (!found && prefetched.some((p) => p.kind === "boot")) {
    await defaultsRead;
    const [route, params] = splitPath(path);
    found = prefetched.find((p) => sameRequest(p, route, params));
  }
  if (!found) return undefined;
  prefetched = prefetched.filter((p) => p !== found);
  return found.response;
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const resp = (!init && (await takePrefetched(path))) || (await fetch(API + path, init));
  // path may carry a query string (e.g. "/tables?schema=…") — compare just
  // the route, not the whole path, so the version check still fires.
  if (path.split("?")[0] === "/tables") checkProtocolVersion(resp);
  if (!resp.ok) throw await errorFromResponse(resp);
  return resp.json();
}
