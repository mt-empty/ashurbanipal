import { describe, expect, it } from "vitest";
import { FilterError, NOT_ALLOWED_CODE, NotAllowedError } from "../src/errors.js";
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
  if (k === "path_not_json") return "invalid_value"; // the builder's own invalid_filter
  return k === "unknown_column" || k === "invalid_value" ? k : STRUCTURAL;
}

function expected(c: FixtureCase, engine: string): Outcome | undefined {
  if ((c.expect_error === undefined) === (c.expect === undefined)) {
    throw new Error(`case ${c.name}: needs exactly one of expect and expect_error`);
  }
  if (c.expect_error !== undefined) return { error: kind(c.expect_error) };
  const want = c.expect?.[engine];
  if (want?.error !== undefined) return { error: kind(want.error) };
  return want && { ...want, where: want.where && ` where ${want.where}` };
}

function runCase(engine: Engine, table: TableMeta, c: FixtureCase): Outcome {
  if ((c.raw === undefined) === (c.conditions === undefined)) {
    throw new Error(`case ${c.name}: needs exactly one of raw and conditions`);
  }
  let conditions: ReturnType<typeof parseFilter>;
  try {
    conditions = parseFilter(c.raw ?? JSON.stringify(c.conditions));
  } catch {
    return { error: STRUCTURAL };
  }
  try {
    return tableWhereClause(conditions, table, engine.dialect);
  } catch (err) {
    if (err instanceof NotAllowedError) return { error: NOT_ALLOWED_CODE[err.kind] };
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
