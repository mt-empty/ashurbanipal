import { $ } from "./dom.js";

// Derived from the page's own URL, not hardcoded, so the UI works behind
// any reverse-proxy prefix; trailing slashes stripped so /x/ and /x agree.
export const API = location.pathname.replace(/\/+$/, "") + "/api";

// ==== Protocol version skew warning ====
// The frontend artifact ships separately from backends (ports vendor this
// file), so the first /tables response's x-ashurbanipal-protocol header is
// compared against the version this file speaks. A mismatch — or a missing
// header — warns but never blocks: a skewed pairing usually still mostly
// works, and refusing to render would be strictly worse than degraded
// browsing.
const PROTOCOL_VERSION = "1";
let protocolChecked = false;
function checkProtocolVersion(resp: Response): void {
  if (protocolChecked) return;
  protocolChecked = true;
  const got = resp.headers.get("x-ashurbanipal-protocol");
  if (got === PROTOCOL_VERSION) return;
  $("protocol-warning-text").textContent =
    `protocol version mismatch: this UI speaks v${PROTOCOL_VERSION}, ` +
    `the server reports ${got ? `v${got}` : "no version"} — some features may misbehave`;
  $("protocol-warning").hidden = false;
}
$("protocol-warning-dismiss").onclick = () => {
  $("protocol-warning").hidden = true;
};

export async function api<T = unknown>(path: string): Promise<T> {
  const resp = await fetch(API + path);
  // path may carry a query string (e.g. "/tables?schema=…") — compare just
  // the route, not the whole path, so the version check still fires.
  if (path.split("?")[0] === "/tables") checkProtocolVersion(resp);
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}
