import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildWhereClause, parseFilter } from "../src/filter.js";
import { NotAllowedError } from "../src/errors.js";

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
  cases: FixtureCase[];
}

// Static mirror of the seed schema's columns for the fixture's tables
// (spec/fixtures/README.md: unit runners substitute this for the live
// information_schema lookup), matching the Rust/Go/Spring runners' own
// copies.
function seedColumns(table: string): string[] {
  switch (table) {
    case "users":
      return ["id", "email", "full_name", "age", "is_active", "login_count", "metadata", "last_login_at", "created_at"];
    case "orders":
      return ["id", "user_id", "status", "total_cents", "discount_pct", "tags", "line_items", "created_at"];
    case "products":
      return ["id", "sku", "name", "category", "price", "weight_kg", "in_stock", "description", "created_on"];
    default:
      throw new Error(`fixture references unmapped table "${table}"`);
  }
}

// Re-numbers the fixture's $1-based placeholders to match
// buildWhereClause's real numbering, which starts at $3 in production
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
        const { where, values } = buildWhereClause(conditions, seedColumns(testCase.table), 3);
        const expectedWhere = testCase.expect.where ? ` where ${shiftPlaceholders(testCase.expect.where, 2)}` : "";
        expect(where).toBe(expectedWhere);
        expect(values).toEqual(testCase.expect.values);
        return;
      }

      if (testCase.expect_error === "unknown_column") {
        const conditions = parseFilter(raw);
        expect(() => buildWhereClause(conditions, seedColumns(testCase.table), 3)).toThrow(NotAllowedError);
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
