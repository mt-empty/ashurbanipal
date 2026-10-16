import { Database } from "sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { partialIndexPredicate, SqliteSource, sqliteTypeClass } from "../../src/db/sqlite.js";
import type { QueryOpts } from "../../src/db/types.js";
import { isQueryTimeout, NotAllowedError } from "../../src/errors.js";
import { BadJoinError, type JoinSpec, parseJoin } from "../../src/join.js";

// No external infrastructure is needed (":memory:").

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

  it("referenced_by lists incoming FKs with synthesized constraint names", async () => {
    db = await seededDb();
    const source = new SqliteSource(db);

    const toUsers = await source.referencedBy(undefined, "users", 5000);
    expect(toUsers).toHaveLength(1);
    expect(toUsers[0].table).toBe("orders");
    expect(toUsers[0].schema).toBeUndefined();
    expect(toUsers[0].columns).toEqual([{ from: "user_id", to: "id" }]);
    // SQLite FKs are unnamed — the label is synthesized fk_<id>.
    expect(toUsers[0].constraint).toMatch(/^fk_\d+$/);

    expect((await source.referencedBy(undefined, "orders", 5000)).map((e) => e.table)).toEqual(["order_extra"]);
    expect(await source.referencedBy(undefined, "order_extra", 5000)).toEqual([]);

    await expect(source.referencedBy(undefined, "no_such_table", 5000)).rejects.toBeInstanceOf(NotAllowedError);
    await expect(source.referencedBy("other", "users", 5000)).rejects.toBeInstanceOf(NotAllowedError);
  });

  it("structure reports indexes, partial predicate, unique and FK actions", async () => {
    db = await new Promise<Database>((resolve, reject) => {
      const d = new Database(":memory:", (err) => {
        if (err) return reject(err);
        d.exec(
          `create table users (id integer primary key, email text unique);
           create table orders (
             id integer primary key,
             user_id integer not null references users on delete cascade,
             kind text,
             status text
           );
           create index orders_kind_status_idx on orders(kind, status);
           create index orders_open_idx on orders(user_id) where status = 'open';`,
          (e) => (e ? reject(e) : resolve(d)),
        );
      });
    });
    const source = new SqliteSource(db);

    const s = await source.structure(undefined, "orders", 5000);
    const byName = new Map(s.indexes.map((i) => [i.name, i]));
    expect(byName.get("orders_kind_status_idx")?.columns).toEqual(["kind", "status"]);
    expect(byName.get("orders_open_idx")?.predicate).toBe("status = 'open'");
    expect(byName.get("orders_kind_status_idx")?.predicate).toBeUndefined();
    expect(s.constraints.primary_key?.columns).toEqual(["id"]);
    expect(s.constraints.foreign_keys).toHaveLength(1);
    expect(s.constraints.foreign_keys[0]).toMatchObject({
      table: "users",
      columns: [{ from: "user_id", to: "id" }],
      on_delete: "CASCADE",
      on_update: "NO ACTION",
    });
    expect(s.constraints.check).toEqual([]);

    const users = await source.structure(undefined, "users", 5000);
    expect(users.constraints.unique.map((u) => u.columns)).toEqual([["email"]]);

    await expect(source.structure(undefined, "no_such_table", 5000)).rejects.toBeInstanceOf(NotAllowedError);
    await expect(source.structure("other", "users", 5000)).rejects.toBeInstanceOf(NotAllowedError);
  });

  // "REFERENCES parent" with no parenthesised column list is valid DDL
  // meaning "the parent's primary key", but pragma_foreign_key_list reports
  // "to" as NULL for that form rather than filling in the PK name — the
  // query must resolve it itself.
  it("referenced_by resolves a shorthand FK with no named parent column", async () => {
    db = await new Promise<Database>((resolve, reject) => {
      const conn = new Database(":memory:", (err) => {
        if (err) return reject(err);
        conn.exec(
          `create table users (id integer primary key, email text not null);
           create table pets (id integer primary key, owner_id integer references users);`,
          (execErr) => (execErr ? reject(execErr) : resolve(conn)),
        );
      });
    });
    const source = new SqliteSource(db);

    const refs = await source.referencedBy(undefined, "users", 5000);
    const pets = refs.find((r) => r.table === "pets");
    expect(pets, "pets' FK to users must be reported").toBeDefined();
    expect(pets?.columns, "an unnamed parent column must resolve to users' primary key, not null/empty").toEqual([
      { from: "owner_id", to: "id" },
    ]);
  });

  // Same shorthand-FK bug, forward direction: keyMetadata (which supplies
  // query_table's per-column references) shares referencedBy's pre-fix
  // bug — pragma_foreign_key_list.to is NULL for "REFERENCES parent" with
  // no named column, and until fixed keyMetadata doesn't resolve it the
  // way referencedBy now does.
  it("query_table resolves a shorthand FK with no named parent column", async () => {
    db = await new Promise<Database>((resolve, reject) => {
      const conn = new Database(":memory:", (err) => {
        if (err) return reject(err);
        conn.exec(
          `create table users (id integer primary key, email text not null);
           create table pets (id integer primary key, owner_id integer references users);`,
          (execErr) => (execErr ? reject(execErr) : resolve(conn)),
        );
      });
    });
    const source = new SqliteSource(db);

    const data = await source.queryTable(undefined, "pets", baseOpts, 5000);
    const ownerIdCol = data.columns.find((c) => c.name === "owner_id");
    expect(ownerIdCol?.key).toBe("fk");
    expect(
      ownerIdCol?.references,
      "an unnamed parent column must resolve to users' primary key, not null/empty",
    ).toEqual({
      table: "users",
      column: "id",
    });
  });

  it("referenced_by resolves a shorthand FK against a composite primary key", async () => {
    db = await new Promise<Database>((resolve, reject) => {
      const conn = new Database(":memory:", (err) => {
        if (err) return reject(err);
        conn.exec(
          `create table warehouse_bins (
             warehouse_code text not null,
             bin_code text not null,
             primary key (warehouse_code, bin_code)
           );
           create table bin_counts (
             id integer primary key,
             warehouse_code text not null,
             bin_code text not null,
             qty integer not null,
             foreign key (warehouse_code, bin_code) references warehouse_bins
           );`,
          (execErr) => (execErr ? reject(execErr) : resolve(conn)),
        );
      });
    });
    const source = new SqliteSource(db);

    const refs = await source.referencedBy(undefined, "warehouse_bins", 5000);
    const binCounts = refs.find((r) => r.table === "bin_counts");
    expect(binCounts?.columns, "a composite FK must resolve every parent PK column").toHaveLength(2);
    expect(binCounts?.columns).toEqual(
      expect.arrayContaining([
        { from: "warehouse_code", to: "warehouse_code" },
        { from: "bin_code", to: "bin_code" },
      ]),
    );
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
    ).rejects.toSatisfy((e: unknown) => isQueryTimeout(e));
    // Interrupted well before the query could have finished unbounded.
    expect(Date.now() - start).toBeLessThan(5000);

    // The connection must still be usable afterward — proves the
    // interrupt is self-clearing per query, not a stuck poisoned state.
    const stillWorks = await source.tableCounts(undefined, 5000);
    expect(stillWorks.length).toBeGreaterThan(0);
  });
});

describe("partialIndexPredicate", () => {
  it("finds the top-level WHERE only", () => {
    expect(partialIndexPredicate("CREATE INDEX i ON t(a) WHERE status = 'open'")).toBe("status = 'open'");
    expect(partialIndexPredicate("CREATE INDEX i ON t(a)\nwhere\n  b > 1")).toBe("b > 1");
    expect(partialIndexPredicate("CREATE INDEX i ON t(a) WHERE note = ' where '")).toBe("note = ' where '");
    expect(partialIndexPredicate("CREATE INDEX i ON t(a || ' where ')")).toBeUndefined();
    expect(partialIndexPredicate("CREATE INDEX i ON t(lower(a) )")).toBeUndefined();
  });
});

describe("SqliteSource.queryJoin", () => {
  let db: Database;

  afterEach(async () => {
    if (db) await closeDb(db);
  });

  const joinOpts = { limit: 10, offset: 0, descending: false, filter: [] };
  const usersOrders = (type: string): JoinSpec =>
    parseJoin(
      JSON.stringify({
        table: "users",
        joins: [{ type, table: "orders", on: [{ left: { join: 0, column: "id" }, right: "user_id" }] }],
      }),
    );

  it("keeps unmatched rows on left and drops them on inner", async () => {
    db = await seededDb();
    const source = new SqliteSource(db);
    const left = await source.queryJoin(undefined, usersOrders("left"), joinOpts, 5000);
    expect(left.rows).toHaveLength(3);
    expect(left.has_more).toBe(false);
    expect(left.rows.filter((r) => r.status === null)).toHaveLength(2);
    const inner = await source.queryJoin(undefined, usersOrders("inner"), joinOpts, 5000);
    expect(inner.rows).toHaveLength(1);
  });

  it("self-joins with distinct labels and reports has_more", async () => {
    db = await seededDb();
    const source = new SqliteSource(db);
    const self = parseJoin(
      JSON.stringify({
        table: "users",
        joins: [{ type: "inner", table: "users", on: [{ left: { join: 0, column: "age" }, right: "age" }] }],
        columns: [
          { join: 0, column: "id" },
          { join: 1, column: "id" },
        ],
      }),
    );
    const page = await source.queryJoin(undefined, self, { ...joinOpts, limit: 2 }, 5000);
    expect(page.rows).toHaveLength(2);
    expect(page.has_more).toBe(true);
    expect(page.columns.map((c) => c.name)).toEqual(["id_0", "id_1"]);
  });

  it("filters and sorts on a joined table's column", async () => {
    db = await seededDb();
    const source = new SqliteSource(db);
    const three = parseJoin(
      JSON.stringify({
        table: "orders",
        joins: [
          { type: "left", table: "users", on: [{ left: { join: 0, column: "user_id" }, right: "id" }] },
          { type: "left", table: "order_extra", on: [{ left: { join: 0, column: "id" }, right: "order_id" }] },
        ],
        columns: [
          { join: 0, column: "id" },
          { join: 1, column: "email" },
          { join: 2, column: "gift_message" },
        ],
      }),
    );
    const data = await source.queryJoin(
      undefined,
      three,
      { ...joinOpts, sort: "email", sortJoin: 1, filter: [{ column: "email", op: "LIKE", value: "a@%", join: 1 }] },
      5000,
    );
    expect(data.rows).toEqual([{ id: "1", email: "a@x.com", gift_message: "enjoy!" }]);
  });

  it("rejects hostile names, mismatched types and other schemas", async () => {
    db = await seededDb();
    const source = new SqliteSource(db);
    const hostile = parseJoin(
      JSON.stringify({
        table: 'users"; drop table users; --',
        joins: [{ type: "left", table: "orders", on: [{ left: { join: 0, column: "id" }, right: "user_id" }] }],
      }),
    );
    await expect(source.queryJoin(undefined, hostile, joinOpts, 5000)).rejects.toBeInstanceOf(NotAllowedError);
    const mismatch = parseJoin(
      JSON.stringify({
        table: "users",
        joins: [{ type: "left", table: "orders", on: [{ left: { join: 0, column: "email" }, right: "user_id" }] }],
      }),
    );
    await expect(source.queryJoin(undefined, mismatch, joinOpts, 5000)).rejects.toBeInstanceOf(BadJoinError);
    await expect(source.queryJoin("other", usersOrders("left"), joinOpts, 5000)).rejects.toBeInstanceOf(
      NotAllowedError,
    );
  });
});

describe("sqliteTypeClass", () => {
  it("classes follow declared names, then affinity", () => {
    expect(sqliteTypeClass("INTEGER")).toEqual({ kind: "number" });
    expect(sqliteTypeClass("DECIMAL(10,2)")).toEqual({ kind: "number" });
    expect(sqliteTypeClass("VARCHAR(20)")).toEqual({ kind: "text" });
    expect(sqliteTypeClass("BLOB")).toEqual({ kind: "binary" });
    expect(sqliteTypeClass("UUID")).toEqual({ kind: "uuid" });
    expect(sqliteTypeClass("TIMESTAMP(6)")).toEqual({ kind: "temporal" });
    expect(sqliteTypeClass("")).toEqual({ kind: "untyped" });
    for (const t of ["REAL", "DOUBLE PRECISION", "JSON"]) expect(sqliteTypeClass(t), t).toBeUndefined();
  });
});
