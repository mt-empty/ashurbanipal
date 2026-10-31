// What both GitHub Pages demos share in the page: the fetch override that
// answers dbviewer.html's /api/* calls, and the mode badge.
import type { ApiResponse } from "./wire.js";

export type ApiHandler = (path: string, params: URLSearchParams) => Promise<ApiResponse>;

// Same derivation as api.ts's API constant, so the demo works under any
// GitHub Pages project or user-site prefix.
export const API_BASE = `${location.pathname.replace(/\/+$/, "")}/api`;

// Must run at top level: build-demo.mjs splices the shim in as a classic
// <script>, which has to install before dbviewer.html's deferred module script.
export function installFetch(handle: ApiHandler): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, location.href);
    if (!url.pathname.startsWith(API_BASE)) return realFetch(input, init);
    const r = await handle(url.pathname.slice(API_BASE.length), url.searchParams);
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
}

/** A fixed corner badge naming the demo's mode, with a link to the other one. Returns a setter for its status text. */
export function showBadge(label: string, linkText: string, href: string): (status: string) => void {
  const badge = document.createElement("div");
  const text = document.createElement("span");
  const link = document.createElement("a");
  text.textContent = label;
  link.textContent = linkText;
  link.href = href;
  // Only the link takes clicks, so the badge never blocks a control under it.
  Object.assign(link.style, { color: "inherit", marginLeft: "0.75em", pointerEvents: "auto" });
  badge.append(text, link);
  Object.assign(badge.style, {
    position: "fixed",
    bottom: "0.5rem",
    right: "0.5rem",
    zIndex: "9999",
    background: "#222",
    color: "#eee",
    font: "12px ui-monospace, monospace",
    padding: "4px 8px",
    borderRadius: "4px",
    opacity: "0.9",
    pointerEvents: "none",
    maxWidth: "calc(100vw - 1rem)",
  });
  badge.id = "demo-badge";
  const attach = () => document.body.appendChild(badge);
  if (document.body) attach();
  else document.addEventListener("DOMContentLoaded", attach);
  return (status) => {
    text.textContent = status ? `${label} · ${status}` : label;
  };
}
