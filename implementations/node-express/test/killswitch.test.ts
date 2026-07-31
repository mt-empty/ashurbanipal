import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createRouter } from "../src/routes.js";
import { ProductionEnabledError } from "../src/config.js";

// Ports the Rust reference's fail-closed guarantees
// (implementations/rust/src/config.rs's tests) and the Go port's
// killswitch_test.go at the level a plain library function can observe
// them directly — createRouter's thrown-or-not behavior is itself the
// whole mechanism here (no DI container, no context-refresh failure to
// assert against). `null` stands in for a Pool throughout: createRouter
// never touches the database at construction time, only per-request, and
// none of these tests issue a request that would reach the database.
const noPool = null as unknown as Pool;

const ALL_MOUNT_PATHS = [
  "/__ashurbanipal",
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

// implementation.md §5.5 item 2 / PORTING.md hardening checklist item 2:
// absent config MUST mean disabled, never "enabled with defaults".
it("empty config is disabled", async () => {
  const router = createRouter({}, noPool);
  await withServer(router, async (baseUrl) => {
    for (const path of ALL_MOUNT_PATHS) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status, `GET ${path}`).toBe(404);
    }
  });
});

it("environment not in enabledFor is disabled", async () => {
  const router = createRouter({ environment: "staging", enabledFor: ["dev"] }, noPool);
  await withServer(router, async (baseUrl) => {
    for (const path of ALL_MOUNT_PATHS) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status, `GET ${path}`).toBe(404);
    }
  });
});

it("matching environment enables routes", async () => {
  const router = createRouter({ environment: "dev", enabledFor: ["dev", "integration"] }, noPool);
  await withServer(router, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/__ashurbanipal`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    // spec/protocol.md §5.1/§7: the UI route carries no protocol header.
    expect(res.headers.get("x-ashurbanipal-protocol")).toBeNull();
  });
});

// spec/protocol.md §4: "any" matches every environment except
// production-like ones.
it("'any' matches every non-production environment", async () => {
  const router = createRouter({ environment: "qa-eu-1", enabledFor: ["any"] }, noPool);
  await withServer(router, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/__ashurbanipal`);
    expect(res.status).toBe(200);
  });
});

describe("production-like enabledFor fails to construct", () => {
  // spec/protocol.md §4: a production-like name in enabledFor MUST be
  // rejected at config load — createRouter throwing is this port's only
  // observable form of "startup fails", since there's no separate
  // config-load step before it.
  for (const alias of ["production", "prod", "PROD", "Production", "PRD", "live"]) {
    it(alias, () => {
      expect(() => createRouter({ environment: "dev", enabledFor: ["dev", alias] }, noPool)).toThrow(
        ProductionEnabledError,
      );
    });
  }
});

describe("running environment itself production-like disables without failing", () => {
  // Running *in* production disables regardless of enabledFor (even
  // "any") — but this is a plain disable, not a construction failure,
  // since enabledFor itself names no production-like value here.
  for (const env of ["production", "PROD", "live"]) {
    it(env, async () => {
      const router = createRouter({ environment: env, enabledFor: ["any"] }, noPool);
      await withServer(router, async (baseUrl) => {
        for (const path of ALL_MOUNT_PATHS) {
          const res = await fetch(`${baseUrl}${path}`);
          expect(res.status, `GET ${path}`).toBe(404);
        }
      });
    });
  }
});
