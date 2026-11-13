import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JOIN_DIALECT as pg, pgColumnClass, pgTypedCompare } from "../src/db/postgres.js";
import { FilterError, NotAllowedError, quoteIdent } from "../src/errors.js";
import { parseFilter } from "../src/filter.js";
import { type ColMeta, type JoinDialect, type TableMeta, tableWhereClause } from "../src/join.js";

// Consumes spec/fixtures/filter-builder-tests.json directly from the repo
// root (schema: spec/fixtures/README.md) — the same file the Rust
// reference's db.rs, the Spring Boot starter, and the Go port all consume,
// so this port's validation/building behavior can't drift from the
// reference's without a fixture-level failure.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

interface FixtureCase {
  name: string;
  table: string;
  conditions?: unknown;
  raw?: string;
  expect?: { where: string; values: string[] };
  expect_error?: string;
}

interface FixtureFile {
  tables: Record<string, Record<string, { type: string }>>;
  cases: FixtureCase[];
}

// The fixture's tables map stands in for the live catalog lookup
// (spec/fixtures/README.md).
function seedTable(table: string): TableMeta {
  const columns = fixture.tables[table];
  if (!columns) throw new Error(`fixture references unmapped table "${table}"`);
  return {
    name: table,
    orderKeys: [],
    columns: Object.entries(columns).map(([name, c]): ColMeta => {
      const col: ColMeta = { name, type: c.type, class: pgColumnClass(c.type, "", "", false) };
      const compare = pgTypedCompare(c.type);
      if (compare) col.compare = compare;
      return col;
    }),
  };
}

// Re-numbers the fixture's $1-based placeholders to match
// tableWhereClause's real numbering, which starts at $3 in production
// (queryTable binds limit/offset as $1/$2 first) — spec/fixtures/README.md:
// "Runners with a different placeholder scheme ... normalize before
// comparing", mirroring the Rust/Go runners' own shift-by-2 helper since
// this port's driver also uses $N positional parameters.
function shiftPlaceholders(fragment: string, by: number): string {
  return fragment.replace(/\$(\d+)/g, (_m, digits: string) => `$${Number(digits) + by}`);
}

const fixturePath = join(repoRoot, "spec", "fixtures", "filter-builder-tests.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureFile;

describe("filter-builder-tests.json fixtures", () => {
  it("fixture file is non-empty", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const raw = testCase.raw !== undefined ? testCase.raw : JSON.stringify(testCase.conditions);

      if (testCase.expect !== undefined) {
        const conditions = parseFilter(raw);
        const { where, values } = tableWhereClause(conditions, seedTable(testCase.table), pg);
        const expectedWhere = testCase.expect.where ? ` where ${shiftPlaceholders(testCase.expect.where, 2)}` : "";
        expect(where).toBe(expectedWhere);
        expect(values).toEqual(testCase.expect.values);
        return;
      }

      if (testCase.expect_error === "unknown_column" || testCase.expect_error === "invalid_value") {
        const conditions = parseFilter(raw);
        expect(() => tableWhereClause(conditions, seedTable(testCase.table), pg)).toThrow(
          testCase.expect_error === "unknown_column" ? NotAllowedError : FilterError,
        );
        return;
      }

      if (testCase.expect_error !== undefined) {
        expect(() => parseFilter(raw)).toThrow();
        return;
      }

      throw new Error(`case ${testCase.name}: neither expect nor expect_error present`);
    });
  }
});
