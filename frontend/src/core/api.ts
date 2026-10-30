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
  route: string;
  params: URLSearchParams;
  key: string;
  response: Promise<Response>;
  expires: number;
}

let prefetched: Prefetched[] = [];

// Parameter order is not part of a request's identity.
function keyOf(route: string, params: URLSearchParams): string {
  const sorted = new URLSearchParams(params);
  sorted.sort();
  return `${route}?${sorted}`;
}

function splitPath(path: string): [route: string, params: URLSearchParams] {
  const [route, query = ""] = path.split("?");
  return [route, new URLSearchParams(query)];
}

function dropExpired(): number {
  const now = performance.now();
  prefetched = prefetched.filter((p) => p.expires > now);
  return now;
}

export function prefetch(path: string, kind: PrefetchKind, ttlMs = Number.POSITIVE_INFINITY): void {
  const now = dropExpired();
  const [route, params] = splitPath(path);
  const key = keyOf(route, params);
  if (prefetched.some((p) => p.key === key)) return;
  const response = fetch(API + path);
  // A failed request surfaces when an api() call takes it, and only then.
  response.catch(() => {});
  prefetched.push({ kind, route, params, key, response, expires: now + ttlMs });
}

export function clearPrefetched(kind: PrefetchKind): void {
  prefetched = prefetched.filter((p) => p.kind !== kind);
}

/**
 * A start-up request that left `param` out asked for the default the server
 * reports, so naming that default here lets it match by path. `among` limits
 * this to requests carrying exactly those params (null: absent).
 */
export function nameStartupDefault(
  param: string,
  value: string | null,
  among: Record<string, string | null> = {},
): void {
  if (value === null) return;
  for (const p of prefetched) {
    if (p.kind !== "boot" || p.params.has(param)) continue;
    if (Object.entries(among).some(([name, wanted]) => p.params.get(name) !== wanted)) continue;
    p.params.set(param, value);
    p.key = keyOf(p.route, p.params);
  }
}

function takePrefetched(path: string): Promise<Response> | undefined {
  dropExpired();
  const key = keyOf(...splitPath(path));
  const found = prefetched.find((p) => p.key === key);
  if (!found) return undefined;
  prefetched = prefetched.filter((p) => p !== found);
  return found.response;
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const resp = await ((!init && takePrefetched(path)) || fetch(API + path, init));
  if (splitPath(path)[0] === "/tables") checkProtocolVersion(resp);
  if (!resp.ok) throw await errorFromResponse(resp);
  return resp.json();
}
