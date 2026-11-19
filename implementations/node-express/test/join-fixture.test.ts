import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mysqlColumnClass, JOIN_DIALECT as mysqlDialect, mysqlTypedCompare } from "../src/db/mysql.js";
import { pgColumnClass, JOIN_DIALECT as pgDialect, pgTypedCompare } from "../src/db/postgres.js";
import { sqliteColumnClass, JOIN_DIALECT as sqliteDialect, sqliteTypedCompare } from "../src/db/sqlite.js";
import { parseFilterForJoin } from "../src/filter.js";
import { errorResult } from "../src/handlers.js";
import {
  BadJoinError,
  buildJoinSelect,
  type ColMeta,
  type JoinDialect,
  type JoinOpts,
  joinTableRefs,
  parseJoin,
  planJoin,
  type TableMeta,
  tableSchemas,
  tieBreakKeys,
} from "../src/join.js";

// Consumes spec/fixtures/join-builder-tests.json (schema: spec/fixtures/README.md).

type CatalogColumn = Record<string, string | boolean>;

interface Catalog {
  schemas: string[];
  default_schema: string;
  tables: Record<
    string,
    { columns: CatalogColumn[]; unique_keys: { name: string; primary: boolean; columns: string[] }[] }
  >;
}

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

/** One engine's half of the fixture: how a catalog column row becomes a ColMeta, as that backend's tableMeta builds it. */
interface Engine {
  name: string;
  dialect: JoinDialect;
  /** SQLite has no schema above the database. */
  splicesSchema: boolean;
  column(c: CatalogColumn): ColMeta;
}

const str = (c: CatalogColumn, key: string): string => String(c[key] ?? "");

function withOptional(col: ColMeta, compare: ColMeta["compare"], collation: unknown): ColMeta {
  if (compare) col.compare = compare;
  if (typeof collation === "string") col.collation = collation;
  return col;
}

const engines: Engine[] = [
  {
    name: "postgres",
    dialect: pgDialect,
    splicesSchema: true,
    column: (c) =>
      withOptional(
        {
          name: str(c, "name"),
          type: str(c, "type"),
          class: pgColumnClass(str(c, "data_type"), str(c, "udt_schema"), str(c, "udt_name"), c.is_enum === true),
        },
        pgTypedCompare(str(c, "data_type")),
        c.collation,
      ),
  },
  {
    name: "mysql",
    dialect: mysqlDialect,
    splicesSchema: true,
    column: (c) =>
      withOptional(
        {
          name: str(c, "name"),
          type: str(c, "column_type"),
          class: mysqlColumnClass(str(c, "data_type"), str(c, "column_type")),
        },
        mysqlTypedCompare(str(c, "data_type")),
        c.collation,
      ),
  },
  {
    name: "sqlite",
    dialect: sqliteDialect,
    splicesSchema: false,
    column: (c) => {
      const declared = str(c, "declared");
      const cls = sqliteColumnClass(declared);
      return withOptional(
        { name: str(c, "name"), type: declared || "unknown", class: cls },
        sqliteTypedCompare(cls),
        undefined,
      );
    },
  },
];

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "..", "..", "spec", "fixtures", "join-builder-tests.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  catalogs: Record<string, Catalog>;
  cases: FixtureCase[];
};

function catalogTables(engine: Engine, catalog: Catalog): Map<string, TableMeta> {
  const out = new Map<string, TableMeta>();
  for (const [key, t] of Object.entries(catalog.tables)) {
    const dot = key.indexOf(".");
    const columns = t.columns.map((c) => engine.column(c));
    const meta: TableMeta = { name: key.slice(dot + 1), columns, orderKeys: tieBreakKeys(columns, t.unique_keys) };
    if (engine.splicesSchema) meta.schema = key.slice(0, dot);
    out.set(key, meta);
  }
  return out;
}

function errorCode(err: unknown): string {
  return (JSON.parse(errorResult(err).body) as { code: string }).code;
}

function runCase(engine: Engine, catalog: Catalog, tables: Map<string, TableMeta>, c: FixtureCase): Outcome {
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
    const request = c.schema ?? catalog.default_schema;
    if (!catalog.schemas.includes(request))
      throw new Error(`request schema ${request} is not in the ${engine.name} catalog`);
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
    if (err instanceof Error && err.message.startsWith("request schema")) throw err;
    return { error: errorCode(err) };
  }
}

for (const engine of engines) {
  const catalog = fixture.catalogs[engine.name];
  if (!catalog) throw new Error(`fixture has no ${engine.name} catalog`);
  const tables = catalogTables(engine, catalog);
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
