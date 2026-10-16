import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSource } from "../src/db/postgres.js";
import { isQueryTimeout } from "../src/errors.js";
import { BadJoinError, type JoinOpts, type JoinSpec, parseJoin } from "../src/join.js";

// Postgres catalog types the conformance seed cannot vary: enum identity,
// arrays, and the timeout label (spec/protocol.md §5.11). One schema per
// describe so concurrent files cannot race each other's DDL.
const databaseUrl = process.env.DATABASE_URL;
const maybeDescribe = databaseUrl ? describe : describe.skip;

const opts = (over: Partial<JoinOpts> = {}): JoinOpts => ({
  limit: 10,
  offset: 0,
  descending: false,
  filter: [],
  ...over,
});

function pairJoin(left: string, leftCol: string, right: string, rightCol: string): JoinSpec {
  return parseJoin(
    JSON.stringify({
      table: left,
      joins: [{ type: "inner", table: right, on: [{ left: { join: 0, column: leftCol }, right: rightCol }] }],
    }),
  );
}

maybeDescribe("join against live Postgres", () => {
  const types = "ashb_test_node_join_types";
  const slow = "ashb_test_node_join_slow";
  let pool: Pool;
  let source: PostgresSource;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 3 });
    source = new PostgresSource(pool);
    await pool.query(`drop schema if exists ${types} cascade; create schema ${types};`);
    await pool.query(`
      create type ${types}.mood as enum ('ok', 'sad');
      create type ${types}.size as enum ('s', 'm');
      create table ${types}.a (id int primary key, m ${types}.mood, z ${types}.size, tags text[], n numeric);
      create table ${types}.b (id int primary key, m ${types}.mood, z ${types}.size, tags text[], n bigint);
      insert into ${types}.a values (1, 'ok', 's', '{x}', 1.0);
      insert into ${types}.b values (1, 'ok', 's', '{x}', 1);`);
    await pool.query(`drop schema if exists ${slow} cascade; create schema ${slow};`);
    await pool.query(`
      create table ${slow}.a as select g as id, g % 2 as k from generate_series(1, 20000) g;
      create table ${slow}.b as select g as id, g % 2 as k from generate_series(1, 20000) g;`);
  });

  afterAll(async () => {
    await pool.query(`drop schema if exists ${types} cascade; drop schema if exists ${slow} cascade;`);
    await pool.end();
  });

  it("pairs enums only within one type and never joins arrays", async () => {
    const same = await source.queryJoin(types, pairJoin("a", "m", "b", "m"), opts(), 5000);
    expect(same.rows).toHaveLength(1);
    await expect(source.queryJoin(types, pairJoin("a", "m", "b", "z"), opts(), 5000)).rejects.toBeInstanceOf(
      BadJoinError,
    );
    await expect(source.queryJoin(types, pairJoin("a", "tags", "b", "tags"), opts(), 5000)).rejects.toBeInstanceOf(
      BadJoinError,
    );
    const mixed = await source.queryJoin(types, pairJoin("a", "n", "b", "n"), opts(), 5000);
    expect(mixed.rows).toHaveLength(1);
  });

  it("names a slow join a query timeout and keeps the pool usable", async () => {
    const started = Date.now();
    const err = await source
      .queryJoin(slow, pairJoin("a", "k", "b", "k"), opts({ sort: "id", descending: true }), 1000)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(isQueryTimeout(err), String(err)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);

    const ok = await source.queryJoin(slow, pairJoin("a", "id", "b", "id"), opts(), 5000);
    expect(ok.rows).toHaveLength(10);
    expect(ok.has_more).toBe(true);
  });
});
