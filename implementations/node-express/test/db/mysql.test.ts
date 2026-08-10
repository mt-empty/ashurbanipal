import mysql, { type Pool } from "mysql2/promise";
import { afterAll, describe, expect, it } from "vitest";
import { MySqlSource, timedSelect, type Variant } from "../../src/db/mysql.js";
import type { QueryOpts } from "../../src/db/types.js";
import { NotAllowedError } from "../../src/errors.js";

// Live-instance coverage, mirroring implementations/rust/src/db/mysql.rs's
// #[cfg(test)] suite — run against the devcontainer's real `mysql` and
// `mariadb` services (MYSQL_TEST_URL / MARIADB_TEST_URL), each variant its
// own describe block so the MariaDB path is verified against a real
// MariaDB server, not just assumed API-symmetric with MySQL. Skips
// cleanly (no failure) when its own env var is absent.

// No live instance needed — a fake pool proves variant() retries after a
// transient failure instead of pinning every future call to one stale
// rejection forever (the `??=`-memoized-promise bug this test guards
// against).
describe("MySqlSource variant() detection", () => {
  it("does not permanently poison itself after one failed detection", async () => {
    let calls = 0;
    const fakePool = {
      query: async () => {
        calls++;
        if (calls === 1) {
          throw new Error("connection reset (simulated transient failure)");
        }
        return [[{ v: "8.0.35" }]];
      },
    } as unknown as Pool;

    const source = new MySqlSource(fakePool);
    const variant = source as unknown as { variant(): Promise<Variant> };

    await expect(variant.variant()).rejects.toThrow(/simulated transient failure/);
    await expect(variant.variant()).resolves.toBe("mysql");
    expect(calls).toBe(2);
  });
});

let counter = 0;

interface SeededDb {
  pool: Pool;
  name: string;
}

async function seededDb(baseUrl: string): Promise<SeededDb> {
  const admin = await mysql.createConnection(baseUrl);
  const name = `ashurbanipal_test_${process.hrtime.bigint()}_${counter++}`;
  await admin.query(`create database \`${name}\``);
  await admin.end();

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const pool = mysql.createPool(url.toString());

  await pool.query(
    "create table users (id integer primary key auto_increment, email varchar(255) not null, age integer)",
  );
  await pool.query(
    "create table orders (id integer primary key auto_increment, user_id integer, status varchar(50) not null, " +
      "constraint fk_orders_user foreign key (user_id) references users(id))",
  );
  await pool.query(
    "create table order_extra (order_id integer primary key, gift_message varchar(255), " +
      "constraint fk_order_extra_order foreign key (order_id) references orders(id))",
  );
  for (const [email, age] of [
    ["a@x.com", 30],
    ["b@x.com", 30],
    ["c@x.com", 40],
  ] as const) {
    await pool.query("insert into users (email, age) values (?, ?)", [email, age]);
  }
  await pool.query("insert into orders (user_id, status) values (1, 'open')");
  await pool.query("insert into order_extra (order_id, gift_message) values (1, 'enjoy!')");

  return { pool, name };
}

async function dropAndClose(db: SeededDb, baseUrl: string): Promise<void> {
  await db.pool.end();
  const admin = await mysql.createConnection(baseUrl);
  await admin.query(`drop database \`${db.name}\``);
  await admin.end();
}

const baseOpts: QueryOpts = { limit: 10, offset: 0, descending: false, filter: [] };

function runSuiteFor(label: string, envVar: "MYSQL_TEST_URL" | "MARIADB_TEST_URL", expectedVariant: Variant): void {
  const baseUrl = process.env[envVar];
  const maybeDescribe = baseUrl ? describe : describe.skip;

  maybeDescribe(`MySqlSource against real ${label}`, () => {
    const dbs: SeededDb[] = [];

    afterAll(async () => {
      for (const db of dbs) {
        await dropAndClose(db, baseUrl!).catch(() => {});
      }
    });

    async function fresh(): Promise<SeededDb> {
      const db = await seededDb(baseUrl!);
      dbs.push(db);
      return db;
    }

    it("resolving the default schema with no default database gives a clear error", async () => {
      const url = new URL(baseUrl!);
      url.pathname = "";
      const noDefaultDbPool = mysql.createPool(url.toString());
      try {
        const source = new MySqlSource(noDefaultDbPool);
        await expect(source.listTables(undefined, 5000)).rejects.toThrow(/no default database/);
      } finally {
        await noDefaultDbPool.end();
      }
    });

    it("lists tables and round-trips query_table", async () => {
      const db = await fresh();
      const source = new MySqlSource(db.pool);

      const tables = await source.listTables(undefined, 5000);
      // Set, not array order: MariaDB's default collation sorts "order_extra"
      // after "orders" (underscore outweighs letters), unlike MySQL — exact
      // cross-collation ordering isn't a guarantee this project makes (see
      // docs/adapter-decisions.md §5.2).
      expect(new Set(tables.map((t) => t.name))).toEqual(new Set(["order_extra", "orders", "users"]));
      expect(tables.every((t) => t.comment === undefined)).toBe(true);

      await expect(source.listTables("no_such_schema", 5000)).rejects.toBeInstanceOf(NotAllowedError);

      const data = await source.queryTable(undefined, "users", { ...baseOpts, sort: "age" }, 5000);
      expect(data.rows).toHaveLength(3);
      expect(data.columns.find((c) => c.name === "id")?.key).toBe("pk");
      for (const row of data.rows) {
        for (const value of Object.values(row)) {
          expect(typeof value === "string" || value === null).toBe(true);
        }
      }
    });

    it("reports a foreign key column's key and references", async () => {
      const db = await fresh();
      const source = new MySqlSource(db.pool);
      const data = await source.queryTable(undefined, "orders", baseOpts, 5000);
      const userIdCol = data.columns.find((c) => c.name === "user_id");
      expect(userIdCol?.key).toBe("fk");
      expect(userIdCol?.references?.table).toBe("users");
      expect(userIdCol?.references?.column).toBe("id");
    });

    it("reports both key and references for a column that is its own PK and an FK", async () => {
      const db = await fresh();
      const source = new MySqlSource(db.pool);
      const data = await source.queryTable(undefined, "order_extra", baseOpts, 5000);
      const orderIdCol = data.columns.find((c) => c.name === "order_id");
      expect(orderIdCol?.key).toBe("pk");
      expect(orderIdCol?.references?.table).toBe("orders");
      expect(orderIdCol?.references?.column).toBe("id");
    });

    it("table_counts reports a real estimate, not the no-mechanism sentinel", async () => {
      const db = await fresh();
      // InnoDB's background stats recalculation may not have run yet
      // right after insert — force it for a deterministic estimate.
      await db.pool.query("analyze table users");
      const source = new MySqlSource(db.pool);
      const counts = await source.tableCounts(undefined, 5000);
      const usersCount = counts.find((c) => c.table === "users")?.approx_rows;
      expect(usersCount, "expected a real estimate, got the no-estimate sentinel").toBeGreaterThanOrEqual(0);
    });

    it("common_values is always empty", async () => {
      const db = await fresh();
      const source = new MySqlSource(db.pool);
      expect(await source.commonValues(undefined, "users", "age", 5000)).toEqual([]);
    });

    it("common_values rejects an unknown column", async () => {
      const db = await fresh();
      const source = new MySqlSource(db.pool);
      await expect(source.commonValues(undefined, "users", "nope", 5000)).rejects.toBeInstanceOf(NotAllowedError);
    });

    it("ILIKE is case-insensitive via LOWER(...) LIKE LOWER(...)", async () => {
      const db = await fresh();
      const source = new MySqlSource(db.pool);
      const data = await source.queryTable(
        undefined,
        "users",
        { ...baseOpts, filter: [{ column: "email", op: "ILIKE", value: "A@X%" }] },
        5000,
      );
      expect(data.rows).toHaveLength(1);
      expect(data.rows[0].email).toBe("a@x.com");
    });

    // The load-bearing regression test PR #26 (Rust) and the Go port both
    // required: proves the two forks' distinct timeout mechanisms
    // (MAX_EXECUTION_TIME hint vs. SET STATEMENT max_statement_time) each
    // actually abort a genuinely slow query on a live instance of that
    // specific fork, rather than assuming API symmetry between them.
    it("a slow query is aborted by this fork's own timeout mechanism", async () => {
      const db = await fresh();
      const conn = await db.pool.getConnection();
      try {
        if (expectedVariant === "mariadb") {
          // MariaDB caps WITH RECURSIVE at max_recursive_iterations
          // (default 1000) regardless of max_statement_time — without
          // raising it the CTE finishes in under a millisecond, long
          // before the timeout gets a chance to fire, making this a
          // broken test rather than a passing one.
          await conn.query("set session max_recursive_iterations = 100000000");
        }
        const sql = timedSelect(
          expectedVariant,
          1000,
          "count(*) as n from (with recursive slow(x) as (" +
            "select 1 union all select x + 1 from slow where x < 100000000" +
            ") select x from slow) t",
        );
        await expect(conn.query(sql)).rejects.toThrow();

        // The same connection must still be usable afterward — proves
        // the mechanism is self-resetting, no stale state left behind.
        const [ok] = await conn.query("select 1 as ok");
        expect((ok as { ok: number }[])[0].ok).toBe(1);
      } finally {
        conn.release();
      }
    }, 20000);
  });
}

runSuiteFor("MySQL", "MYSQL_TEST_URL", "mysql");
runSuiteFor("MariaDB", "MARIADB_TEST_URL", "mariadb");
