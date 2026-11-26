import { request } from "node:http";
import express, { type Express } from "express";
import { expect, it } from "vitest";
import type { DbSource } from "../src/db/types.js";
import { allowsHost, hostAllowList } from "../src/host-allow-list.js";
import { createRouter, type NamedSource } from "../src/routes.js";
import { startServer, type TestServer } from "./helpers.js";

// spec/protocol.md §3.1.
it.each([
  [[], "anything.example", true],
  [[], undefined, true],
  [["billing.internal"], "billing.internal", true],
  [["billing.internal"], "billing.internal:4000", true],
  [["billing.internal"], "evil.example", false],
  [["billing.internal"], "billing.internal.evil.example", false],
  [["billing.internal:4000"], "billing.internal:4000", true],
  [["billing.internal:4000"], "billing.internal", false],
  [["billing.internal:4000"], "billing.internal:4001", false],
  [["Billing.Internal"], "BILLING.internal:4000", true],
  [["billing.internal"], "billing.internal.", true],
  [["billing.internal"], "billing.internal.:4000", true],
  [["other.internal."], "other.internal", true],
  [["localhost"], ".", false],
  [["billing.internal"], "billing.internal..", false],
  [["[::1]:4000"], "[::1]:4000", true],
  [["[::1]:4000"], "[::1]:4001", false],
  [["[fe80::1]"], "[FE80::1]:80", true],
  [["[::1]"], "::1", false],
  [["localhost"], undefined, false],
  [["localhost"], "", false],
  [["localhost"], "localhost:", false],
  [["localhost"], "localhost:99999", false],
  [["localhost"], "localhost:80x", false],
  [["localhost"], "user@localhost", false],
  [["localhost"], "localhost/path", false],
  [["localhost"], "local host", false],
  [["http://localhost"], "localhost", false],
  [["http://localhost", "ok.example"], "ok.example", true],
])("entries %j, Host %j: allowed %s", (entries, host, want) => {
  expect(allowsHost(hostAllowList(entries), host)).toBe(want);
});

it("treats a lone value as one entry, never letter by letter", () => {
  const lone = hostAllowList("billing.internal" as unknown as string[]);
  expect(allowsHost(lone, "billing.internal")).toBe(true);
  expect(allowsHost(lone, "b")).toBe(false);
  const wrong = hostAllowList(4000 as unknown as string[]);
  expect(wrong.entries).toEqual([]);
  expect(wrong.warnings).toHaveLength(1);
});

it("warns when the list is absent and for each bad entry", () => {
  expect(hostAllowList(undefined).warnings).toEqual([expect.stringContaining("allowed_hosts is not set")]);
  const { warnings } = hostAllowList(["http://localhost", "localhost/x", "*.example", "localhost:abc", "ok.example"]);
  expect(warnings).toHaveLength(4);
  expect(warnings[0]).toContain('"http://localhost"');
});

const sources: NamedSource[] = [{ name: "primary", source: null as unknown as DbSource }];

/** Raw node:http, because fetch won't send a chosen Host. */
function get(server: TestServer, path: string, headers: Record<string, string>, method = "GET"): Promise<number> {
  const { port } = new URL(server.baseUrl);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers, setHost: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

/** A host app with its own `/other` route and a 418 for anything that falls through the viewer. */
function hostApp(mount: (app: Express) => void): Express {
  const app = express();
  app.get("/other", (_req, res) => {
    res.status(200).end();
  });
  mount(app);
  app.use((_req, res) => {
    res.status(418).end();
  });
  return app;
}

// No case without Host: node:http answers that with 400 before Express runs.
it("an unlisted Host falls through to the host app", async () => {
  const server = await startServer(
    hostApp((app) => app.use(createRouter({ enabled: true, allowedHosts: ["localhost"] }, sources))),
  );
  try {
    for (const path of ["/__ashurbanipal", "/__ashurbanipal/api/tables"]) {
      expect(await get(server, path, { host: "rebind.invalid" }), path).toBe(418);
      expect(await get(server, path, { host: "rebind.invalid", "x-forwarded-host": "localhost" }), path).toBe(418);
    }
    expect(await get(server, "/__ashurbanipal", { host: "LOCALHOST:4000" })).toBe(200);
  } finally {
    await server.close();
  }
});

it("the check follows a custom mount", async () => {
  const server = await startServer(
    hostApp((app) =>
      app.use("/svc", createRouter({ enabled: true, basePath: "/viewer", allowedHosts: ["localhost"] }, sources)),
    ),
  );
  try {
    expect(await get(server, "/svc/viewer", { host: "rebind.invalid" })).toBe(418);
    expect(await get(server, "/svc/viewer/api/tables", { host: "rebind.invalid" }, "POST")).toBe(418);
    expect(await get(server, "/svc/viewer", { host: "localhost" })).toBe(200);
    expect(await get(server, "/other", { host: "rebind.invalid" })).toBe(200);
  } finally {
    await server.close();
  }
});
