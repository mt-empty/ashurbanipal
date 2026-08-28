import mysql, { type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MySqlSource } from "../src/db/mysql.js";
import type { QueryOpts } from "../src/db/types.js";
import { NotAllowedError } from "../src/errors.js";

// MySQL/MariaDB equivalent of table-listing-privileges.integration.test.ts.
//
// Neither engine has a has_table_privilege function, and no cheap
// role-aware way to narrow information_schema.tables to SELECT-able tables
// (see docs/adapter-decisions.md §5.2/§5.3), so the listing is NOT gated —
// an INSERT-only table still appears. What must hold: a residual
// ER_TABLEACCESS_DENIED_ERROR (errno 1142) at the row fetch throws
// NotAllowedError (→ 400), never a raw driver 500.

const SCHEMA = "ashb_test_table_privileges";
const USER = "ashb_test_table_privileges_user";
const PASSWORD = "ashb_test_pw";
const TIMEOUT_MS = 5000;
const opts: QueryOpts = { limit: 10, offset: 0, descending: false, filter: [] };

function limitedUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.username = USER;
  url.password = PASSWORD;
  url.pathname = `/${SCHEMA}`;
  return url.toString();
}

function runSuiteFor(label: string, envVar: "MYSQL_TEST_URL" | "MARIADB_TEST_URL"): void {
  const baseUrl = process.env[envVar] ?? "";
  const maybeDescribe = baseUrl ? describe : describe.skip;

  maybeDescribe(`table listing privilege gate — ${label} (live db)`, () => {
    let adminPool: Pool;
    let limitedPool: Pool;
    let source: MySqlSource;

    beforeAll(async () => {
      adminPool = mysql.createPool({ uri: baseUrl, connectionLimit: 1 });
      for (const stmt of [
        `drop database if exists ${SCHEMA}`,
        `drop user if exists '${USER}'@'%'`,
        `create database ${SCHEMA}`,
        `create user '${USER}'@'%' identified by '${PASSWORD}'`,
        `create table ${SCHEMA}.readable (id int primary key, name varchar(50))`,
        `insert into ${SCHEMA}.readable values (1, 'a'), (2, 'b')`,
        `create table ${SCHEMA}.write_only (id int primary key)`,
        `create table ${SCHEMA}.no_grant (id int primary key)`,
        `grant select on ${SCHEMA}.readable to '${USER}'@'%'`,
        `grant insert on ${SCHEMA}.write_only to '${USER}'@'%'`,
      ]) {
        await adminPool.query(stmt);
      }
      limitedPool = mysql.createPool({ uri: limitedUrl(baseUrl), connectionLimit: 2 });
      source = new MySqlSource(limitedPool);
    });

    afterAll(async () => {
      await limitedPool?.end();
      if (adminPool) {
        await adminPool.query(`drop database if exists ${SCHEMA}`);
        await adminPool.query(`drop user if exists '${USER}'@'%'`);
        await adminPool.end();
      }
    });

    it("still lists an INSERT-only table (documented gap), but not a zero-privilege one", async () => {
      const names = (await source.listTables(SCHEMA, TIMEOUT_MS)).map((t) => t.name);
      expect(names).toContain("readable");
      // If write_only ever stops being listed, update docs/adapter-decisions.md.
      expect(names).toContain("write_only");
      expect(names).not.toContain("no_grant");
    });

    it("queryTable works on the selectable table", async () => {
      const data = await source.queryTable(SCHEMA, "readable", opts, TIMEOUT_MS);
      expect(data.rows.length).toBe(2);
    });

    it("an INSERT-only table is rejected as NotAllowed, not a permission-denied 500", async () => {
      await expect(source.queryTable(SCHEMA, "write_only", opts, TIMEOUT_MS)).rejects.toBeInstanceOf(NotAllowedError);
    });

    it("a table absent from the allow-list is rejected as NotAllowed", async () => {
      await expect(source.queryTable(SCHEMA, "no_grant", opts, TIMEOUT_MS)).rejects.toBeInstanceOf(NotAllowedError);
    });
  });
}

runSuiteFor("MySQL", "MYSQL_TEST_URL");
runSuiteFor("MariaDB", "MARIADB_TEST_URL");
