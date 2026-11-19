import { describe, expect, it } from "vitest";
import { FilterError, NotAllowedError } from "../src/errors.js";
import { parseFilter } from "../src/filter.js";
import { type TableMeta, tableWhereClause } from "../src/join.js";
import { type Engine, engineCatalog, engines, readFixture } from "./catalog-fixture.js";

// Consumes spec/fixtures/filter-builder-tests.json (schema: spec/fixtures/README.md).

interface Outcome {
  where?: string;
  values?: string[];
  error?: string;
}

interface FixtureCase {
  name: string;
  table: string;
  conditions?: unknown;
  raw?: string;
  expect?: Record<string, Outcome>;
  expect_error?: string;
}

const fixture = readFixture<{ cases: FixtureCase[] }>("filter-builder-tests.json");

/** Structural kinds all fail the parse before any schema access, so they compare as one. */
const STRUCTURAL = "structural";

function kind(k: string): string {
  return k === "unknown_column" || k === "invalid_value" ? k : STRUCTURAL;
}

function expected(c: FixtureCase, engine: string): Outcome | undefined {
  if (c.expect_error !== undefined) return { error: kind(c.expect_error) };
  const want = c.expect?.[engine];
  if (want?.error !== undefined) return { error: kind(want.error) };
  return want;
}

function runCase(engine: Engine, table: TableMeta, c: FixtureCase): Outcome {
  let conditions: ReturnType<typeof parseFilter>;
  try {
    conditions = parseFilter(c.raw ?? JSON.stringify(c.conditions));
  } catch {
    return { error: STRUCTURAL };
  }
  try {
    const { where, values } = tableWhereClause(conditions, table, engine.dialect);
    return { where: where.replace(/^ where /, ""), values };
  } catch (err) {
    if (err instanceof NotAllowedError) return { error: "unknown_column" };
    if (err instanceof FilterError) return { error: "invalid_value" };
    throw err;
  }
}

for (const engine of engines) {
  const { catalog, tables } = engineCatalog(engine);
  const cases = fixture.cases.filter((c) => expected(c, engine.name) !== undefined);

  describe(`filter-builder-tests.json fixtures (${engine.name})`, () => {
    it("has cases for this engine", () => {
      expect(cases.length).toBeGreaterThan(0);
    });

    for (const c of cases) {
      it(c.name, () => {
        const key = `${catalog.default_schema}.${c.table}`;
        const table = tables.get(key);
        if (!table) throw new Error(`no ${key} in the ${engine.name} catalog`);
        expect(runCase(engine, table, c)).toEqual(expected(c, engine.name));
      });
    }
  });
}
