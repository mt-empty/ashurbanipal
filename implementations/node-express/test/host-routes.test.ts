import { request } from "node:http";
import express, { type Express } from "express";
import { describe, expect, it } from "vitest";
import type { DbSource } from "../src/db/types.js";
import { API_PATHS } from "../src/handlers.js";
import { createRouter, type NamedSource } from "../src/routes.js";
import { readFixture } from "./catalog-fixture.js";
import { startServer, type TestServer } from "./helpers.js";

// spec/protocol.md §3: the viewer never changes a host route, with the Host check on or off.

interface FixtureRequest {
  method: string;
  path: string;
}

const fixture = readFixture<{ viewer_paths: string[]; host_routes: FixtureRequest[]; unrouted: FixtureRequest[] }>(
  "host-routes-untouched.json",
);
const sources: NamedSource[] = [{ name: "primary", source: null as unknown as DbSource }];

/** Raw node:http, because fetch won't send a chosen Host. */
function send(server: TestServer, method: string, path: string, host: string): Promise<[number, string]> {
  const { port } = new URL(server.baseUrl);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host }, setHost: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve([res.statusCode ?? 0, body]));
    });
    req.on("error", reject);
    req.end();
  });
}

/** The host's routes registered after the viewer, so the viewer sees every request first. */
function hostApp(prefix: string, allowedHosts: string[]): Express {
  const app = express();
  const viewer = createRouter({ enabled: true, allowedHosts }, sources);
  if (prefix) app.use(prefix, viewer);
  else app.use(viewer);
  for (const route of fixture.host_routes) {
    const path = prefix + route.path.replace("{mount}", "/__ashurbanipal");
    app[route.method.toLowerCase() as "get" | "post" | "delete"](path, (_req, res) => {
      res.status(200).send("host-route");
    });
  }
  app.use((_req, res) => {
    res.status(404).send("host-404");
  });
  return app;
}

describe.each(["", "/svc"])("with the viewer under %j", (prefix) => {
  it.each([
    ["listed", ["localhost"], "localhost"],
    ["unlisted", ["localhost"], "rebind.invalid"],
    ["check off", [], "rebind.invalid"],
  ] as const)("host routes are untouched: %s", async (_label, allowedHosts, host) => {
    const server = await startServer(hostApp(prefix, [...allowedHosts]));
    try {
      for (const [requests, want] of [
        [fixture.host_routes, [200, "host-route"]],
        [fixture.unrouted, [404, "host-404"]],
      ] as const) {
        for (const req of requests) {
          const path = prefix + req.path.replace("{mount}", "/__ashurbanipal");
          expect(await send(server, req.method, path, host), `${req.method} ${path}`).toEqual(want);
        }
      }
    } finally {
      await server.close();
    }
  });
});

it("refuses a root mount", () => {
  for (const basePath of ["/", "//"]) {
    expect(() => createRouter({ enabled: true, basePath }, sources)).toThrow(/must not be the root/);
  }
});

it("serves exactly the fixture's viewer paths", () => {
  expect(["", ...API_PATHS.map((p) => `/api${p}`)]).toEqual(fixture.viewer_paths);
});
