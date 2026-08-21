import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CommonValueEntry, CountEntry, DbSource, QueryOpts, TableData, TableInfo } from "../src/db/types.js";
import { createRouter, type NamedSource } from "../src/routes.js";

// A minimal in-memory DbSource, standing in for a real backend the same
// way killswitch.test.ts's `null` stand-in does for kill-switch tests —
// multi-source resolution (routes.ts's resolveSource) never touches the
// database itself, only picks which DbSource a request reaches, so a fake
// with distinguishable canned data is enough to prove resolution without
// a live DB.
class FakeDbSource implements DbSource {
  constructor(private readonly label: string) {}

  async listSchemas(): Promise<string[]> {
    return [`${this.label}-schema`];
  }

  async listTables(): Promise<TableInfo[]> {
    return [{ name: `${this.label}-table` }];
  }

  async tableCounts(): Promise<CountEntry[]> {
    return [{ table: `${this.label}-table`, approx_rows: 1 }];
  }

  async queryTable(_schema: string | undefined, table: string, _opts: QueryOpts): Promise<TableData> {
    return { columns: [{ name: "label", type: "text" }], rows: [{ label: `${this.label}:${table}` }], total_approx: 1 };
  }

  async commonValues(): Promise<CommonValueEntry[]> {
    return [{ value: this.label, freq: 1 }];
  }
}

const alpha: NamedSource = { name: "alpha", source: new FakeDbSource("alpha") };
const beta: NamedSource = { name: "beta", source: new FakeDbSource("beta") };

describe("multi-source support", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const router = createRouter({ enabled: true }, [alpha, beta]);
    const app = express();
    app.use(router);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function getJson(path: string): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}${path}`);
    const body = res.status === 200 ? await res.json() : await res.text();
    return { status: res.status, body };
  }

  it("lists registered source names in registration order", async () => {
    const { status, body } = await getJson("/__ashurbanipal/api/sources");
    expect(status).toBe(200);
    expect(body).toEqual({ sources: [{ name: "alpha" }, { name: "beta" }] });
  });

  it("rejects an unrecognized source value on every source-aware route", async () => {
    for (const path of [
      "/__ashurbanipal/api/schemas?source=nonexistent",
      "/__ashurbanipal/api/tables?source=nonexistent",
      "/__ashurbanipal/api/table-counts?source=nonexistent",
      "/__ashurbanipal/api/tables/data?source=nonexistent&table=t",
      "/__ashurbanipal/api/tables/common-values?source=nonexistent&table=t&column=c",
    ]) {
      const { status } = await getJson(path);
      expect(status, path).toBe(400);
    }
  });

  it("omitting source resolves to the first-registered source", async () => {
    const implicit = await getJson("/__ashurbanipal/api/schemas");
    const explicitAlpha = await getJson("/__ashurbanipal/api/schemas?source=alpha");
    expect(implicit.body).toEqual({ schemas: ["alpha-schema"] });
    expect(implicit.body).toEqual(explicitAlpha.body);
  });

  it("an explicit non-default source selects its own data", async () => {
    const { status, body } = await getJson("/__ashurbanipal/api/schemas?source=beta");
    expect(status).toBe(200);
    expect(body).toEqual({ schemas: ["beta-schema"] });
  });
});
