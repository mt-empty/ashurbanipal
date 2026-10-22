import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { DbSource } from "../src/db/types.js";
import { createRouter, type NamedSource } from "../src/routes.js";

// /api/siblings never touches the database, so `null` stands in for a
// DbSource. Port 9 refuses at once, so every check is a fast healthy=false.
const sources: NamedSource[] = [{ name: "primary", source: null as unknown as DbSource }];
const baseUrl = "http://127.0.0.1:9/__ashurbanipal";

function labelledConfig(): Config {
  return {
    enabled: true,
    instance: { name: "orders", label: "dev" },
    siblings: [
      { name: "orders", label: "dev", baseUrl, healthPath: "/health" },
      { name: "orders", label: "int", baseUrl, healthPath: "/health" },
      { name: "billing", baseUrl, healthPath: "/health" },
    ],
  };
}

async function get(config: Config, ...paths: string[]): Promise<{ status: number; body: unknown }[]> {
  const app = express();
  app.use(createRouter(config, sources));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const results = [];
    for (const path of paths) {
      const res = await fetch(`http://127.0.0.1:${port}/__ashurbanipal${path}`);
      results.push({ status: res.status, body: await res.json() });
    }
    return results;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function getSiblings(config: Config): Promise<unknown> {
  const [{ body }] = await get(config, "/api/siblings");
  return body;
}

it("reports this instance in place, healthy, without a check", async () => {
  expect(await getSiblings(labelledConfig())).toStrictEqual({
    instance: { name: "orders", label: "dev" },
    siblings: [
      { name: "orders", label: "dev", base_url: baseUrl, healthy: true },
      { name: "orders", label: "int", base_url: baseUrl, healthy: false },
      { name: "billing", base_url: baseUrl, healthy: false },
    ],
  });
});

it("omits instance and label when neither is configured", async () => {
  const config: Config = { enabled: true, siblings: [{ name: "billing", baseUrl, healthPath: "/health" }] };
  expect(await getSiblings(config)).toStrictEqual({
    siblings: [{ name: "billing", base_url: baseUrl, healthy: false }],
  });
});

it.each([
  [
    "an instance without a label",
    (c: Config) => (c.instance = { name: "orders", label: "" }),
    "instance needs a non-empty name and label",
  ],
  [
    "an empty sibling label",
    (c: Config) => ((c.siblings ?? [])[1].label = ""),
    'sibling "orders" needs a non-empty string label, or none',
  ],
  [
    "a duplicate name and label",
    (c: Config) => ((c.siblings ?? [])[1].label = "dev"),
    'two siblings share the name "orders" and the same label',
  ],
  [
    "a null sibling label",
    (c: Config) => ((c.siblings ?? [])[1].label = null as unknown as string),
    'sibling "orders" needs a non-empty string label, or none',
  ],
])("reports %s from /api/siblings only", async (_name, mutate, reason) => {
  const config = labelledConfig();
  mutate(config);
  const [siblings, sourcesList] = await get(config, "/api/siblings", "/api/sources");
  expect(siblings).toStrictEqual({
    status: 500,
    body: {
      type: "about:blank",
      title: `invalid sibling configuration: ${reason}`,
      status: 500,
      code: "invalid_config",
    },
  });
  expect(sourcesList.status).toBe(200);
});

it("never validates siblings when disabled", () => {
  const config = labelledConfig();
  config.enabled = false;
  config.instance = { name: "orders", label: "" };
  expect(() => createRouter(config, [])).not.toThrow();
});
