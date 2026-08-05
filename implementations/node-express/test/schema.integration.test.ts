import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRouter } from "../src/routes.js";

// DB-backed coverage of resolveSchema against the devcontainer's seeded
// Postgres (schemas: public, other_schema, warehouse — see
// .devcontainer/db/init/01-seed.sql) — the one part of this port's new
// multi-schema logic no unit test can exercise, since it validates a
// requested schema against a live pg_namespace lookup. Mirrors the
// equivalent cases in the Rust/Kotlin reference ports' own DB-backed
// integration suites; conformance/runner also covers this cross-language,
// but that suite runs separately from `pnpm test`.
const databaseUrl = process.env.DATABASE_URL;
const maybeDescribe = databaseUrl ? describe : describe.skip;

maybeDescribe("multi-schema support (live db)", () => {
  let pool: Pool;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const router = createRouter({ environment: "dev", enabledFor: ["dev"] }, pool);
    const app = express();
    app.use(router);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  async function getJson(path: string): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}${path}`);
    const body = res.status === 200 ? await res.json() : await res.text();
    return { status: res.status, body };
  }

  it("lists the seed's schemas, excluding system namespaces", async () => {
    const { status, body } = await getJson("/__ashurbanipal/api/schemas");
    expect(status).toBe(200);
    const schemas = (body as { schemas: string[] }).schemas;
    expect(schemas).toEqual(expect.arrayContaining(["public", "other_schema", "warehouse"]));
    expect(schemas.some((s) => s === "pg_catalog" || s === "information_schema" || s.startsWith("pg_"))).toBe(false);
  });

  it("an explicit schema=public matches the implicit default", async () => {
    const implicit = await getJson("/__ashurbanipal/api/tables");
    const explicit = await getJson("/__ashurbanipal/api/tables?schema=public");
    expect(explicit.body).toEqual(implicit.body);
  });

  it("an explicit other schema selects only its own tables", async () => {
    const { status, body } = await getJson("/__ashurbanipal/api/tables?schema=other_schema");
    expect(status).toBe(200);
    const names = (body as { tables: { name: string }[] }).tables.map((t) => t.name);
    expect(names).toEqual(["decoy_items"]);
  });

  it("rejects unrecognized schema values on every schema-aware route", async () => {
    for (const evil of ["", "nonexistent_schema", 'public"; drop schema public cascade; --', "public' OR '1'='1"]) {
      const q = encodeURIComponent(evil);
      for (const path of [
        `/__ashurbanipal/api/tables?schema=${q}`,
        `/__ashurbanipal/api/table-counts?schema=${q}`,
        `/__ashurbanipal/api/tables/data?schema=${q}&table=users`,
        `/__ashurbanipal/api/tables/common-values?schema=${q}&table=users&column=email`,
      ]) {
        const { status } = await getJson(path);
        expect(status, path).toBe(400);
      }
    }
  });

  it("a cross-schema FK reference includes the referenced table's schema", async () => {
    const { status, body } = await getJson("/__ashurbanipal/api/tables/data?schema=warehouse&table=shipments&limit=1");
    expect(status).toBe(200);
    const columns = (body as { columns: { name: string; key?: string; references?: { table: string; schema?: string } }[] }).columns;
    const orderId = columns.find((c) => c.name === "order_id");
    expect(orderId?.key).toBe("fk");
    expect(orderId?.references?.table).toBe("orders");
    expect(orderId?.references?.schema).toBe("public");
  });

  it("a same-schema FK reference omits the schema field", async () => {
    const { status, body } = await getJson("/__ashurbanipal/api/tables/data?table=orders&limit=1");
    expect(status).toBe(200);
    const columns = (body as { columns: { name: string; references?: { schema?: string } }[] }).columns;
    const userId = columns.find((c) => c.name === "user_id");
    expect(userId?.references?.schema).toBeUndefined();
  });
});
