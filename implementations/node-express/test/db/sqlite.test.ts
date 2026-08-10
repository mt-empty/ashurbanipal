import { Database } from "sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSource } from "../../src/db/sqlite.js";
import type { QueryOpts } from "../../src/db/types.js";
import { NotAllowedError } from "../../src/errors.js";

// No external infrastructure needed (":memory:"), mirroring
// implementations/rust/src/db/sqlite.rs's own #[cfg(test)] suite.

function seededDb(): Promise<Database> {
  return new Promise((resolve, reject) => {
    const db = new Database(":memory:", (err) => {
      if (err) return reject(err);
      db.exec(
        `create table users (
           id integer primary key,
           email text not null,
           age integer
         );
         create table orders (
           id integer primary key,
           user_id integer references users(id),
           status text not null
         );
         create table order_extra (
           order_id integer primary key references orders(id),
           gift_message text
         );
         insert into users (email, age) values ('a@x.com', 30), ('b@x.com', 30), ('c@x.com', 40);
         insert into orders (user_id, status) values (1, 'open');
         insert into order_extra (order_id, gift_message) values (1, 'enjoy!');`,
        (execErr) => {
          if (execErr) reject(execErr);
          else resolve(db);
        },
      );
    });
  });
}

function closeDb(db: Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

const baseOpts: QueryOpts = { limit: 10, offset: 0, descending: false, filter: [] };

describe("SqliteSource", () => {
  let db: Database;

  afterEach(async () => {
    if (db) await closeDb(db);
  });

  it("lists tables and round-trips query_table", async () => {
    db = await seededDb();
    const source = new SqliteSource(db);

    const tables = await source.listTables(undefined, 5000);
    expect(tables.map((t) => t.name)).toEqual(["order_extra", "orders", "users"]);
    expect(tables.every((t) => t.comment === undefined)).toBe(true);

    expect(await source.listSchemas()).toEqual(["main"]);
    await expect(source.listTables("other", 5000)).rejects.toBeInstanceOf(NotAllowedError);

    const data = await source.queryTable(undefined, "users", { ...baseOpts, sort: "age" }, 5000);
    // No reltuples-equivalent estimate on SQLite; always -1
    // (spec/protocol.md §5.4.4).
    expect(data.total_approx).toBe(-1);
    expect(data.rows).toHaveLength(3);
    expect(data.columns.find((c) => c.name === "id")?.key).toBe("pk");
    for (const row of data.rows) {
      for (const value of Object.values(row)) {
        expect(typeof value === "string" || value === null).toBe(true);
      }
    }
  });

  it("reports a foreign key column's key and references", async () => {
    db = await seededDb();
    const source = new SqliteSource(db);
    const data = await source.queryTable(undefined, "orders", baseOpts, 5000);
    const userIdCol = data.columns.find((c) => c.name === "user_id");
    expect(userIdCol?.key).toBe("fk");
    expect(userIdCol?.references).toEqual({ table: "users", column: "id" });
  });

  it("reports both key and references for a column that is its own PK and an FK", async () => {
    db = await seededDb();
    const source = new SqliteSource(db);
    const data = await source.queryTable(undefined, "order_extra", baseOpts, 5000);
    const orderIdCol = data.columns.find((c) => c.name === "order_id");
    expect(orderIdCol?.key).toBe("pk");
    expect(orderIdCol?.references).toEqual({ table: "orders", column: "id" });
  });

  it("table_counts always reports the -1 no-estimate sentinel", async () => {
    db = await seededDb();
    const source = new SqliteSource(db);
    const counts = await source.tableCounts(undefined, 5000);
    expect(counts).toEqual([
      { table: "order_extra", approx_rows: -1 },
      { table: "orders", approx_rows: -1 },
      { table: "users", approx_rows: -1 },
    ]);
  });

  it("common_values is always empty", async () => {
    db = await seededDb();
    const source = new SqliteSource(db);
    expect(await source.commonValues(undefined, "users", "age", 5000)).toEqual([]);
  });

  it("common_values rejects an unknown column", async () => {
    db = await seededDb();
    const source = new SqliteSource(db);
    await expect(source.commonValues(undefined, "users", "nope", 5000)).rejects.toBeInstanceOf(NotAllowedError);
  });

  it("ILIKE maps to SQLite's already-case-insensitive LIKE", async () => {
    db = await seededDb();
    const source = new SqliteSource(db);
    const data = await source.queryTable(
      undefined,
      "users",
      { ...baseOpts, filter: [{ column: "email", op: "ILIKE", value: "A@X%" }] },
      5000,
    );
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].email).toBe("a@x.com");
  });

  // Empirically proves the interrupt()-based cancellation mechanism
  // actually aborts a running query rather than just abandoning the
  // caller's wait (see db/sqlite.ts's bounded() doc comment) — a
  // recursive CTE generating far more rows than a short budget should
  // allow it to finish counting.
  it("a slow query is aborted by the timeout mechanism, not left to run", async () => {
    db = await seededDb();
    const source = new SqliteSource(db);

    const start = Date.now();
    await expect(
      new Promise((resolve, reject) => {
        db.get(
          `with recursive slow(x) as (
             select 1 union all select x + 1 from slow where x < 100000000
           ) select count(*) as n from slow`,
          (err: Error | null, row: unknown) => (err ? reject(err) : resolve(row)),
        );
        setTimeout(() => db.interrupt(), 200);
      }),
    ).rejects.toThrow();
    // Interrupted well before the query could have finished unbounded.
    expect(Date.now() - start).toBeLessThan(5000);

    // The connection must still be usable afterward — proves the
    // interrupt is self-clearing per query, not a stuck poisoned state.
    const stillWorks = await source.tableCounts(undefined, 5000);
    expect(stillWorks.length).toBeGreaterThan(0);
  });
});
