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

export async function api<T = unknown>(path: string): Promise<T> {
  const resp = await fetch(API + path);
  // path may carry a query string (e.g. "/tables?schema=…") — compare just
  // the route, not the whole path, so the version check still fires.
  if (path.split("?")[0] === "/tables") checkProtocolVersion(resp);
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}
