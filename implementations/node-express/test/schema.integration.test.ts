import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSource } from "../src/db/postgres.js";
import type { QueryOpts } from "../src/db/types.js";
import { createRouter } from "../src/routes.js";
import { getJson as sharedGetJson, startServer, type TestServer } from "./helpers.js";

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
  let testServer: TestServer;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const router = createRouter({ enabled: true }, [{ name: "default", source: new PostgresSource(pool) }]);
    testServer = await startServer(router);
  });

  afterAll(async () => {
    await testServer.close();
    await pool.end();
  });

  const getJson = (path: string) => sharedGetJson(testServer.baseUrl, path);

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
    const columns = (
      body as { columns: { name: string; key?: string; references?: { table: string; schema?: string } }[] }
    ).columns;
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

  // GET /api/tables/referenced-by (spec/protocol.md §5.9) — the reverse of
  // the per-column `references` above. Mirrors the Rust P5.9-* conformance
  // checks (conformance/runner/referenced_by.rs) against the same seed.
  describe("referenced-by (§5.9)", () => {
    type RbEntry = { table: string; schema?: string; constraint: string; columns: { from: string; to: string }[] };
    const referencedBy = async (table: string): Promise<RbEntry[]> => {
      const { status, body } = await getJson(
        `/__ashurbanipal/api/tables/referenced-by?table=${encodeURIComponent(table)}`,
      );
      expect(status).toBe(200);
      return (body as { referenced_by: RbEntry[] }).referenced_by;
    };
    const entriesFor = (list: RbEntry[], table: string) => list.filter((e) => e.table === table);
    const onlyPair = (e: RbEntry): [string, string] => {
      expect(e.columns).toHaveLength(1);
      return [e.columns[0].from, e.columns[0].to];
    };

    it("lists incoming FK constraints with explicit column pairs", async () => {
      const list = await referencedBy("users");

      const orders = entriesFor(list, "orders");
      expect(orders).toHaveLength(1);
      expect(onlyPair(orders[0])).toEqual(["user_id", "id"]);
      expect(orders[0].constraint).not.toBe("");
      expect(orders[0].schema).toBeUndefined();

      // support_tickets has two separate FKs into users -> two entries.
      const tickets = entriesFor(list, "support_tickets");
      expect(tickets).toHaveLength(2);
      expect(new Set(tickets.map(onlyPair).map(([f, t]) => `${f}->${t}`))).toEqual(
        new Set(["user_id->id", "assigned_admin_id->id"]),
      );
      for (const e of tickets) expect(e.schema).toBeUndefined();

      // (table, constraint) is unique within one response.
      const keys = list.map((e) => `${e.table} | ${e.constraint}`);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("includes composite foreign keys with every column pair", async () => {
      const list = await referencedBy("inventory_locations");
      expect(list).toHaveLength(1);
      expect(list[0].table).toBe("inventory_counts");
      expect(list[0].columns).toEqual([
        { from: "warehouse_code", to: "warehouse_code" },
        { from: "bin_code", to: "bin_code" },
      ]);
    });

    it("returns an empty list when nothing references the table", async () => {
      expect(await referencedBy("feature_flags")).toEqual([]);
    });

    it("carries a schema field for cross-schema referrers", async () => {
      const se = entriesFor(await referencedBy("users"), "shipment_events");
      expect(se).toHaveLength(1);
      expect(se[0].schema).toBe("warehouse");
      expect(onlyPair(se[0])).toEqual(["handled_by_user_id", "id"]);
    });

    it("an explicit schema=public matches the implicit default", async () => {
      const implicit = await getJson("/__ashurbanipal/api/tables/referenced-by?table=users");
      const explicit = await getJson("/__ashurbanipal/api/tables/referenced-by?schema=public&table=users");
      expect(explicit.body).toEqual(implicit.body);
    });

    it("rejects unknown or malicious input cleanly, with the protocol header", async () => {
      for (const path of [
        `/__ashurbanipal/api/tables/referenced-by?table=${encodeURIComponent("")}`,
        `/__ashurbanipal/api/tables/referenced-by?table=${encodeURIComponent("no_such_table")}`,
        `/__ashurbanipal/api/tables/referenced-by?table=${encodeURIComponent('users"; drop table users; --')}`,
        `/__ashurbanipal/api/tables/referenced-by?table=${encodeURIComponent("users' OR '1'='1")}`,
        "/__ashurbanipal/api/tables/referenced-by",
        "/__ashurbanipal/api/tables/referenced-by?schema=no_such_schema&table=users",
        "/__ashurbanipal/api/tables/referenced-by?source=no_such_source&table=users",
      ]) {
        const res = await fetch(`${testServer.baseUrl}${path}`);
        expect(res.status, path).toBe(400);
        expect(res.headers.get("x-ashurbanipal-protocol"), path).toBe("1");
      }
    });

    it("carries the protocol version header on a 200", async () => {
      const res = await fetch(`${testServer.baseUrl}/__ashurbanipal/api/tables/referenced-by?table=users`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-ashurbanipal-protocol")).toBe("1");
    });
  });

  // Pool sessions with different search_path values must not drift mid-operation
  // (spec/protocol.md §1, §5).
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
  it("query_table never mixes schemas across pooled connections", async () => {
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

        const source = new PostgresSource(testPool);
        const opts: QueryOpts = { limit: 10, offset: 0, descending: false, filter: [] };

        const results = await Promise.all(
          Array.from({ length: 40 }, () => source.queryTable(undefined, "probe_isolation", opts, 5000)),
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
  }, 20000);
});
