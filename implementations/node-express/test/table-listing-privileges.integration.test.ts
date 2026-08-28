import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSource } from "../src/db/postgres.js";
import type { QueryOpts } from "../src/db/types.js";
import { NotAllowedError } from "../src/errors.js";

// The table listing, the counts, and the `table` allow-list must all
// exclude tables the connected role can't SELECT (spec/protocol.md §5.2),
// and an INSERT-only table must throw NotAllowedError, never surface a raw
// permission-denied 500 — Node equivalent of
// implementations/rust/axum/tests/table_listing_privileges.rs.
const databaseUrl = process.env.DATABASE_URL;
const maybeDescribe = databaseUrl ? describe : describe.skip;

const SCHEMA = "ashb_test_table_privileges";
const ROLE = "ashb_test_table_privileges_role";
const TIMEOUT_MS = 5000;
const opts: QueryOpts = { limit: 10, offset: 0, descending: false, filter: [] };

maybeDescribe("table listing privilege gate (live db)", () => {
  let adminPool: Pool;
  let limitedPool: Pool;
  let source: PostgresSource;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    for (const stmt of [
      `drop schema if exists ${SCHEMA} cascade`,
      `drop role if exists ${ROLE}`,
      `create role ${ROLE} nosuperuser`,
      // Lets the limited pool's sessions start with `role` set to it.
      `grant ${ROLE} to current_user`,
      `create schema ${SCHEMA}`,
      `grant usage on schema ${SCHEMA} to ${ROLE}`,
      `create table ${SCHEMA}.readable (id int primary key, name text)`,
      `insert into ${SCHEMA}.readable values (1, 'a'), (2, 'b')`,
      `create table ${SCHEMA}.write_only (id int primary key)`,
      `create table ${SCHEMA}.no_grant (id int primary key)`,
      `grant select on ${SCHEMA}.readable to ${ROLE}`,
      `grant insert on ${SCHEMA}.write_only to ${ROLE}`,
    ]) {
      await adminPool.query(stmt);
    }

    // `options=-c role=…` starts every session as ROLE — the pg equivalent
    // of the Rust/Go tests' after-connect `set role`.
    limitedPool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c role=${ROLE}` });
    source = new PostgresSource(limitedPool);
  });

  afterAll(async () => {
    await limitedPool?.end();
    if (adminPool) {
      await adminPool.query(`drop schema if exists ${SCHEMA} cascade`);
      await adminPool.query(`drop role if exists ${ROLE}`);
      await adminPool.end();
    }
  });

  it("listTables and table-counts omit non-selectable tables", async () => {
    const tables = await source.listTables(SCHEMA, TIMEOUT_MS);
    expect(tables.map((t) => t.name)).toEqual(["readable"]);
    const counts = await source.tableCounts(SCHEMA, TIMEOUT_MS);
    expect(counts.map((c) => c.table)).toEqual(["readable"]);
  });

  it("queryTable works on the selectable table", async () => {
    const data = await source.queryTable(SCHEMA, "readable", opts, TIMEOUT_MS);
    expect(data.rows.length).toBe(2);
  });

  it("an INSERT-only table is rejected as NotAllowed, not a permission-denied 500", async () => {
    await expect(source.queryTable(SCHEMA, "write_only", opts, TIMEOUT_MS)).rejects.toBeInstanceOf(NotAllowedError);
  });

  it("a table the role has no privilege on is rejected as NotAllowed", async () => {
    await expect(source.queryTable(SCHEMA, "no_grant", opts, TIMEOUT_MS)).rejects.toBeInstanceOf(NotAllowedError);
  });
});
