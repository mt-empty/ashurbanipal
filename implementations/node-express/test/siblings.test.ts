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

async function getSiblings(config: Config): Promise<unknown> {
  const app = express();
  app.use(createRouter(config, sources));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__ashurbanipal/api/siblings`);
    return await res.json();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it("echoes instance and labels and leaves out this instance", async () => {
  expect(await getSiblings(labelledConfig())).toStrictEqual({
    instance: { name: "orders", label: "dev" },
    siblings: [
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
  ["an instance without a label", (c: Config) => (c.instance = { name: "orders", label: "" })],
  ["an empty sibling label", (c: Config) => ((c.siblings ?? [])[1].label = "")],
  ["a duplicate name and label", (c: Config) => ((c.siblings ?? [])[1].label = "dev")],
  ["a null sibling label", (c: Config) => ((c.siblings ?? [])[1].label = null as unknown as string)],
])("rejects %s when enabled", (_name, mutate) => {
  const config = labelledConfig();
  mutate(config);
  expect(() => createRouter(config, sources)).toThrow();
});

it("never validates siblings when disabled", () => {
  const config = labelledConfig();
  config.enabled = false;
  config.instance = { name: "orders", label: "" };
  expect(() => createRouter(config, [])).not.toThrow();
});
