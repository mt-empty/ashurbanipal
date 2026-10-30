import { readFileSync } from "node:fs";
import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import http2, { type Http2ServerRequest } from "node:http2";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { perfCertificate } from "./tls";

/** Simulated server time per route. */
export interface ServerDelays {
  catalogMs: number;
  dataMs: number;
}

/** The round trip and the server time, both added before a request reaches the demo. */
export interface Delays extends ServerDelays {
  latencyMs: number;
}

export interface DelayProxy {
  url: string;
  setDelays(delays: Delays): void;
  close(): Promise<void>;
}

export interface ProxyOptions {
  /** Gzip HTML and JSON not already encoded, standing in for a host that compresses its API responses. */
  gzip?: boolean;
  /** Serve over HTTPS with HTTP/2 (self-signed certificate) instead of plain HTTP/1.1. */
  h2?: boolean;
  /** Serve this file as the UI page instead of the demo's own, so page builds can be compared on one backend. */
  page?: string;
}

const MOUNT = "/__ashurbanipal";
const DATA_ROUTE = /\/api\/tables\/(data|join)(\?|$)/;
const COMPRESSIBLE = /^(text\/html|application\/json)/;
// Connection-level headers HTTP/2 forbids in a response.
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"]);

type Req = IncomingMessage | Http2ServerRequest;
// What both response types offer; their own unions of overloads aren't callable.
type Res = NodeJS.WritableStream & {
  writeHead(status: number, headers?: OutgoingHttpHeaders): unknown;
};

function serverTime(path: string, delays: Delays): number {
  if (DATA_ROUTE.test(path)) return delays.dataMs;
  return path.includes("/api/") ? delays.catalogMs : 0;
}

// The round trip is added here, not by Chromium's throttling: Chromium treats
// its latency as a minimum time to response headers, so server time would hide
// inside it instead of adding to it. A proxy rather than page.route(), because
// Playwright turns the HTTP cache off while any route is registered. The first
// request on a new connection pays its handshake: one more round trip for TCP,
// two for TCP plus TLS 1.3 under `h2`.
export async function startDelayProxy(target: string, options: ProxyOptions = {}): Promise<DelayProxy> {
  const { gzip = false, h2 = false } = options;
  const page = options.page ? readFileSync(options.page) : undefined;
  const upstream = new URL(target);
  const agent = new http.Agent({ keepAlive: true });
  let delays: Delays = { latencyMs: 0, catalogMs: 0, dataMs: 0 };
  const unused = new WeakSet<object>();
  const handshakeTrips = h2 ? 2 : 1;

  function send(req: Req, res: Res, status: number, headers: IncomingHttpHeaders, body: Readable): void {
    const kept = Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP_BY_HOP.has(k.toLowerCase())));
    const compress =
      gzip &&
      /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? "")) &&
      !kept["content-encoding"] &&
      COMPRESSIBLE.test(String(kept["content-type"] ?? ""));
    if (!compress) {
      res.writeHead(status, kept);
      body.pipe(res);
      return;
    }
    const { "content-length": _, ...rest } = kept;
    res.writeHead(status, { ...rest, "content-encoding": "gzip", vary: "accept-encoding" });
    body.pipe(createGzip()).pipe(res);
  }

  function forward(req: Req, res: Res, path: string): void {
    if (page && req.method === "GET" && new URL(path, "http://x").pathname.replace(/\/+$/, "") === MOUNT) {
      send(
        req,
        res,
        200,
        { "content-type": "text/html; charset=utf-8", "content-length": String(page.length) },
        Readable.from([page]),
      );
      return;
    }
    // HTTP/2's pseudo-headers (`:path` and the like) have no HTTP/1.1 form.
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !k.startsWith(":")));
    const up = http.request(
      { host: upstream.hostname, port: upstream.port, path, method: req.method, headers, agent },
      (upRes) => send(req, res, upRes.statusCode ?? 502, upRes.headers, upRes),
    );
    up.on("error", (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    (req as Readable).pipe(up);
  }

  const handle = (req: Req, res: Res) => {
    const path = req.url ?? "/";
    const connection = "stream" in req ? req.stream.session : req.socket;
    const handshakeMs = connection && unused.delete(connection) ? handshakeTrips * delays.latencyMs : 0;
    setTimeout(() => forward(req, res, path), handshakeMs + delays.latencyMs + serverTime(path, delays));
  };

  const server = h2
    ? http2.createSecureServer({ ...perfCertificate(), allowHTTP1: false }, handle)
    : http.createServer(handle);
  const sessions = new Set<http2.ServerHttp2Session>();
  if (h2)
    (server as http2.Http2SecureServer).on("session", (session) => {
      unused.add(session);
      sessions.add(session);
      session.on("close", () => sessions.delete(session));
    });
  else (server as http.Server).on("connection", (socket) => unused.add(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `${h2 ? "https" : "http"}://127.0.0.1:${port}`,
    setDelays(next) {
      delays = next;
    },
    close() {
      agent.destroy();
      if (h2) {
        for (const session of sessions) session.destroy();
        return new Promise((resolve) => (server as http2.Http2SecureServer).close(() => resolve()));
      }
      (server as http.Server).closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
