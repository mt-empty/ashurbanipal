import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PostgresSource } from "../src/db/postgres.js";
import { createRouter } from "../src/routes.js";
import { describeWithEnv, getJson as sharedGetJson, startServer, type TestServer } from "./helpers.js";

// A plain select on a table with inheritance children returns their rows too,
// so its row estimate, keys and common values must describe those rows.
const schema = "ashb_test_node_inheritance_parent";
type Column = { name: string; key?: string };
type Data = { rows: unknown[]; columns: Column[]; total_approx: number };

describeWithEnv("DATABASE_URL")("inheritance parent (live db)", () => {
  let pool: Pool;
  let testServer: TestServer;
  const exec = (sql: string) => pool.query(sql.replaceAll("$s", schema));

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    // Three levels: tickets (30 rows: open/pending/closed), tickets_archive
    // (70: archived/closed) and tickets_purged (20: purged). Ids repeat across
    // them, so the parent's primary key does not hold. Autovacuum is off so
    // each table's statistics change only when the test analyzes it.
    await exec(`drop schema if exists $s cascade;
      create schema $s;
      create table $s.tickets (id int primary key, status text not null) with (autovacuum_enabled = false);
      create table $s.tickets_archive (id int not null, status text not null) with (autovacuum_enabled = false);
      create table $s.tickets_purged () inherits ($s.tickets_archive) with (autovacuum_enabled = false);
      create table $s.lone (id int primary key);
      insert into $s.tickets
        select g, (array['open','pending','closed'])[g % 3 + 1] from generate_series(1, 30) g;
      insert into $s.tickets_archive
        select g, (array['archived','closed'])[g % 2 + 1] from generate_series(1, 70) g;
      insert into $s.tickets_purged select g, 'purged' from generate_series(1, 20) g;`);
    const router = createRouter({ enabled: true }, [{ name: "default", source: new PostgresSource(pool) }]);
    testServer = await startServer(router);
  });

  afterAll(async () => {
    await testServer.close();
    await exec("drop schema if exists $s cascade");
    await pool.end();
  });

  const getJson = async <T>(path: string): Promise<T> => {
    const { status, body } = await sharedGetJson(testServer.baseUrl, `/__ashurbanipal/api/${path}schema=${schema}`);
    expect(status).toBe(200);
    return body as T;
  };
  const estimates = async () => {
    const total = (await getJson<Data>("tables/data?table=tickets&")).total_approx;
    const { counts } = await getJson<{ counts: { table: string; approx_rows: number }[] }>("table-counts?");
    return { total, counts: Object.fromEntries(counts.map((c) => [c.table, c.approx_rows])) };
  };
  const commonValues = async (table: string) =>
    new Map(
      (
        await getJson<{ values: { value: string; freq: number }[] }>(
          `tables/common-values?table=${table}&column=status&`,
        )
      ).values.map((v) => [v.value, v.freq]),
    );

  // One test: each step changes the statistics the next one reads.
  it("describes every descendant's rows", async () => {
    // The parent is analyzed while it has no children, so it has only its own
    // statistics row; then the archive (and its child) is attached.
    await exec("analyze $s.tickets; alter table $s.tickets_archive inherit $s.tickets;");
    const before = await estimates();
    expect(before.total, "children with no estimate yet add nothing").toBe(30);
    expect(before.counts.tickets_archive, "no table in its tree has one").toBe(-1);
    expect((await commonValues("tickets")).size, "no with-children statistics row yet").toBe(0);

    await exec("analyze $s.tickets; analyze $s.tickets_archive; analyze $s.tickets_purged;");
    const page1 = await getJson<Data>("tables/data?table=tickets&limit=100&");
    const page2 = await getJson<Data>("tables/data?table=tickets&limit=100&offset=100&");
    expect(page1.rows.length + page2.rows.length, "all three levels' rows").toBe(120);
    expect(page1.columns.find((c) => c.name === "id")?.key, "the parent's key does not hold").toBeUndefined();
    expect((await getJson<Data>("tables/data?table=lone&")).columns[0].key).toBe("pk");

    const after = await estimates();
    expect(after.total).toBe(120);
    expect(after.counts).toMatchObject({ tickets: 120, tickets_archive: 90, tickets_purged: 20 });

    const parent = await commonValues("tickets");
    expect(parent.size).toBe(5);
    expect(parent.get("closed")).toBeCloseTo(0.375, 3);
    expect((await commonValues("tickets_purged")).size).toBe(1);
  });
});
