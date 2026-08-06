import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Catalog, type QueryOpts } from "../src/catalog.js";
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

  // Regression test for the "connection pool sessions with different
  // search_path settings must not let a request's schema resolution drift
  // mid-flight" guarantee (spec/protocol.md §1, §5) — Node equivalent of
  // implementations/rust/tests/schema_isolation.rs's
  // query_table_never_mixes_schemas_across_pooled_connections.
  //
  // Builds its own 2-connection pool (separate from the beforeAll pool
  // above) whose physical connections alternate search_path between two
  // schemas that each hold a same-named probe table with a different
  // column shape. queryTable resolves+validates the schema and later
  // selects columns from it inside one withTimeout transaction (see
  // resolveSchema's doc comment in src/catalog.ts) — if those steps could
  // ever land on different pooled connections, a response would mix
  // shapes/values across schemas or fail outright. onConnect is awaited by
  // pg-pool before a client is handed to any caller (unlike the 'connect'
  // event), so the SET runs before any real query can race it.
  it(
    "query_table never mixes schemas across pooled connections",
    async () => {
      const schemaA = "ashb_test_schema_isolation_a";
      const schemaB = "ashb_test_schema_isolation_b";

      const setupPool = new Pool({ connectionString: databaseUrl, max: 1 });
      try {
        for (const schema of [schemaA, schemaB]) {
          await setupPool.query(`drop schema if exists ${schema} cascade`);
          await setupPool.query(`create schema ${schema}`);
        }
        await setupPool.query(`create table ${schemaA}.probe_isolation (id int primary key, marker text)`);
        await setupPool.query(`insert into ${schemaA}.probe_isolation values (1, 'A'), (2, 'A')`);
        await setupPool.query(`create table ${schemaB}.probe_isolation (id int primary key, marker text, extra text)`);
        await setupPool.query(`insert into ${schemaB}.probe_isolation values (1, 'B', 'X'), (2, 'B', 'X')`);

        let connectionCount = 0;
        const testPool = new Pool({
          connectionString: databaseUrl,
          max: 2,
          onConnect: async (client) => {
            const schema = connectionCount % 2 === 0 ? schemaA : schemaB;
            connectionCount += 1;
            await client.query(`set search_path = ${schema}`);
          },
        });

        try {
          // Acquire both connections while both are still checked out
          // (neither idle yet), forcing the pool to dial two distinct
          // physical connections; only then release them both back to the
          // idle set, so both schemas are represented once the concurrent
          // calls below begin.
          const c1 = await testPool.connect();
          const c2 = await testPool.connect();
          c1.release();
          c2.release();

          const catalog = new Catalog(testPool, 5000);
          const opts: QueryOpts = { limit: 10, offset: 0, descending: false, filter: [] };

          const results = await Promise.all(
            Array.from({ length: 40 }, () => catalog.queryTable(undefined, "probe_isolation", opts)),
          );

          for (const data of results) {
            const names = data.columns.map((c) => c.name);
            if (names.length === 2 && names[0] === "id" && names[1] === "marker") {
              for (const row of data.rows) {
                expect(row.marker, "schema_a shape must only ever contain schema_a's rows").toBe("A");
              }
            } else if (names.length === 3 && names[0] === "id" && names[1] === "marker" && names[2] === "extra") {
              for (const row of data.rows) {
                expect(row.marker, "schema_b shape must only ever contain schema_b's rows").toBe("B");
                expect(row.extra).toBe("X");
              }
            } else {
              throw new Error(`response mixed columns from both schemas — mid-request schema drift: ${names}`);
            }
          }
        } finally {
          await testPool.end();
        }
      } finally {
        for (const schema of [schemaA, schemaB]) {
          await setupPool.query(`drop schema if exists ${schema} cascade`).catch(() => {});
        }
        await setupPool.end();
      }
    },
    20000,
  );
});
