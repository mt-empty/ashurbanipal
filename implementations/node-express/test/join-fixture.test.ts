import { describe, expect, it } from "vitest";
import { parseFilterForJoin } from "../src/filter.js";
import { errorResult } from "../src/handlers.js";
import {
  BadJoinError,
  buildJoinSelect,
  type JoinOpts,
  joinTableRefs,
  parseJoin,
  planJoin,
  type TableMeta,
  tableSchemas,
} from "../src/join.js";
import { type Catalog, type Engine, engineCatalog, engines, readFixture } from "./catalog-fixture.js";

// Consumes spec/fixtures/join-builder-tests.json (schema: spec/fixtures/README.md).

interface Outcome {
  sql?: string;
  values?: string[];
  labels?: string[];
  error?: string;
}

interface FixtureCase {
  name: string;
  join?: unknown;
  join_raw?: string;
  filter?: unknown;
  sort?: string;
  sort_join?: number;
  order?: string;
  schema?: string;
  expect_error?: string;
  expect?: Record<string, Outcome>;
}

const fixture = readFixture<{ cases: FixtureCase[] }>("join-builder-tests.json");

function errorCode(err: unknown): string {
  return (JSON.parse(errorResult(err).body) as { code: string }).code;
}

function runCase(engine: Engine, catalog: Catalog, tables: Map<string, TableMeta>, c: FixtureCase): Outcome {
  const request = c.schema ?? catalog.default_schema;
  if (!catalog.schemas.includes(request))
    throw new Error(`request schema ${request} is not in the ${engine.name} catalog`);
  try {
    const spec = parseJoin(c.join_raw ?? JSON.stringify(c.join));
    const opts: JoinOpts = {
      limit: 50,
      offset: 0,
      sort: c.sort,
      sortJoin: c.sort_join,
      descending: c.order === "desc",
      filter: c.filter === undefined ? [] : parseFilterForJoin(JSON.stringify(c.filter)),
    };
    const refs = joinTableRefs(spec);
    const schemas = tableSchemas(refs, request, catalog.schemas);
    const metas = refs.map((r, i) => {
      const meta = tables.get(`${schemas[i]}.${r.table}`);
      if (!meta) throw new BadJoinError(`unknown table "${r.table}"`);
      return meta;
    });
    const plan = planJoin(spec, metas, opts);
    const { body, values } = buildJoinSelect(plan, engine.dialect);
    return { sql: body, values, labels: plan.labels };
  } catch (err) {
    // A 500 here is a bug in the planner, not a rejection the fixture can expect.
    if (errorResult(err).status >= 500) throw err;
    return { error: errorCode(err) };
  }
}

for (const engine of engines) {
  const { catalog, tables } = engineCatalog(engine);
  const cases = fixture.cases.filter((c) => c.expect_error !== undefined || c.expect?.[engine.name] !== undefined);

  describe(`join-builder-tests.json fixtures (${engine.name})`, () => {
    it("has cases for this engine", () => {
      expect(cases.length).toBeGreaterThan(0);
    });
    for (const c of cases) {
      it(c.name, () => {
        const want = c.expect_error !== undefined ? { error: c.expect_error } : c.expect?.[engine.name];
        expect(runCase(engine, catalog, tables, c)).toEqual(want);
      });
    }
  });
}
