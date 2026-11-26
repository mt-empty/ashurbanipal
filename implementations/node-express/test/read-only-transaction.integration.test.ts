import mysql, { type PoolConnection } from "mysql2/promise";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MySqlSource } from "../src/db/mysql.js";
import { PostgresSource } from "../src/db/postgres.js";
import type { QueryOpts } from "../src/db/types.js";
import { describeWithEnv } from "./helpers.js";

// Every operation runs in a read-only transaction (spec/protocol.md §6).
const TIMEOUT_MS = 5000;
const opts: QueryOpts = { limit: 10, offset: 0, descending: false, filter: [] };

const SCHEMA = "ashb_test_node_read_only_tx";
const ROLE = "ashb_test_node_read_only_tx_role";

// A row-level security policy that calls a writing function is the one way a
// plain SELECT on a listed table can write. RLS does not apply to a
// superuser, so the source's sessions start as an ordinary role.
describeWithEnv("DATABASE_URL")("read-only transaction — postgres (live db)", () => {
  let adminPool: Pool;
  let rolePool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    for (const stmt of [
      `drop schema if exists ${SCHEMA} cascade`,
      `drop role if exists ${ROLE}`,
      `create role ${ROLE} nosuperuser`,
      `grant ${ROLE} to current_user`,
      `create schema ${SCHEMA}`,
      `grant usage on schema ${SCHEMA} to ${ROLE}`,
      // The role may insert, so only the read-only transaction stops the write.
      `create table ${SCHEMA}.audit (id serial primary key)`,
      `grant insert on ${SCHEMA}.audit to ${ROLE}`,
      `grant usage on sequence ${SCHEMA}.audit_id_seq to ${ROLE}`,
      `create function ${SCHEMA}.log_read() returns boolean language sql volatile
         as $$ insert into ${SCHEMA}.audit default values; select true $$`,
      `create table ${SCHEMA}.watched (id int primary key)`,
      `insert into ${SCHEMA}.watched values (1)`,
      `alter table ${SCHEMA}.watched enable row level security`,
      `create policy log_every_read on ${SCHEMA}.watched for select to ${ROLE} using (${SCHEMA}.log_read())`,
      `grant select on ${SCHEMA}.watched to ${ROLE}`,
    ]) {
      await adminPool.query(stmt);
    }
    rolePool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, options: `-c role=${ROLE}` });
  });

  afterAll(async () => {
    await rolePool?.end();
    if (adminPool) {
      await adminPool.query(`drop schema if exists ${SCHEMA} cascade`);
      await adminPool.query(`drop role if exists ${ROLE}`);
      await adminPool.end();
    }
  });

  it("a select that would write fails and writes nothing", async () => {
    const source = new PostgresSource(rolePool);
    await expect(source.queryTable(SCHEMA, "watched", opts, TIMEOUT_MS)).rejects.toMatchObject({ code: "25006" });
    const { rows } = await adminPool.query<{ n: string }>(`select count(*) as n from ${SCHEMA}.audit`);
    expect(rows[0].n).toBe("0");
  });
});

// A SELECT on a MySQL base table cannot write, so this opens the source's own
// operation transaction and tries an INSERT in it.
type WithTx = <T>(fn: (conn: PoolConnection) => Promise<T>) => Promise<T>;

function runMySqlSuite(label: string, envVar: "MYSQL_TEST_URL" | "MARIADB_TEST_URL"): void {
  describeWithEnv(envVar)(`read-only transaction — ${label} (live db)`, () => {
    let pool: mysql.Pool;

    beforeAll(async () => {
      pool = mysql.createPool({ uri: process.env[envVar] ?? "", connectionLimit: 2 });
      await pool.query(`drop database if exists ${SCHEMA}`);
      await pool.query(`create database ${SCHEMA}`);
      await pool.query(`create table ${SCHEMA}.audit (id int auto_increment primary key)`);
    });

    afterAll(async () => {
      if (pool) {
        await pool.query(`drop database if exists ${SCHEMA}`);
        await pool.end();
      }
    });

    it("an insert inside the operation transaction fails", async () => {
      const source = new MySqlSource(pool);
      const withTx = (source as unknown as { withTx: WithTx }).withTx.bind(source);
      await expect(withTx((conn) => conn.query(`insert into ${SCHEMA}.audit () values ()`))).rejects.toMatchObject({
        sqlState: "25006",
      });
      const [rows] = await pool.query<mysql.RowDataPacket[]>(`select count(*) as n from ${SCHEMA}.audit`);
      expect(Number(rows[0].n)).toBe(0);
    });
  });
}

runMySqlSuite("MySQL", "MYSQL_TEST_URL");
runMySqlSuite("MariaDB", "MARIADB_TEST_URL");
