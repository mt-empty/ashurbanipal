import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { expect, it } from "vitest";
import type { DbSource } from "../src/db/types.js";
import { createRouter, type NamedSource } from "../src/routes.js";

// Tests createRouter's fail-closed behavior directly. `null` stands in for a DbSource:
// createRouter never touches the database at construction time, only
// per-request, and none of these tests issue a request that would reach
// the database.
const noSources: NamedSource[] = [{ name: "default", source: null as unknown as DbSource }];

const ALL_MOUNT_PATHS = [
  "/__ashurbanipal",
  "/__ashurbanipal/api/sources",
  "/__ashurbanipal/api/schemas",
  "/__ashurbanipal/api/tables",
  "/__ashurbanipal/api/table-counts",
  "/__ashurbanipal/api/tables/data",
  "/__ashurbanipal/api/tables/common-values",
  "/__ashurbanipal/api/siblings",
];

async function withServer(router: express.Router, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(router);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// PORTING.md hardening checklist item 2: absent config MUST mean
// disabled, never "enabled with defaults".
it("empty config is disabled", async () => {
  const router = createRouter({}, noSources);
  await withServer(router, async (baseUrl) => {
    for (const path of ALL_MOUNT_PATHS) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status, `GET ${path}`).toBe(404);
    }
  });
});

it("enabled: false is disabled", async () => {
  const router = createRouter({ enabled: false }, noSources);
  await withServer(router, async (baseUrl) => {
    for (const path of ALL_MOUNT_PATHS) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status, `GET ${path}`).toBe(404);
    }
  });
});

it("enabled: true enables routes", async () => {
  const router = createRouter({ enabled: true }, noSources);
  await withServer(router, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/__ashurbanipal`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    // spec/protocol.md §5.1/§7: the UI route carries no protocol header.
    expect(res.headers.get("x-ashurbanipal-protocol")).toBeNull();
  });
});
