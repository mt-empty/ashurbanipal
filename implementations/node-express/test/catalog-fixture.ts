import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mysqlColumnClass, JOIN_DIALECT as mysqlDialect, mysqlTypedCompare } from "../src/db/mysql.js";
import { pgColumnClass, JOIN_DIALECT as pgDialect, pgTypedCompare } from "../src/db/postgres.js";
import { sqliteColumnClass, JOIN_DIALECT as sqliteDialect, sqliteTypedCompare } from "../src/db/sqlite.js";
import { type ColMeta, type JoinDialect, type TableMeta, tieBreakKeys } from "../src/join.js";

// Engine-native catalogs from spec/fixtures/catalogs.json, shared by the join
// and filter fixture runners (schema: spec/fixtures/README.md).

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "spec", "fixtures");

export function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as T;
}

type CatalogColumn = Record<string, string | boolean>;

export interface Catalog {
  schemas: string[];
  default_schema: string;
  tables: Record<
    string,
    { columns: CatalogColumn[]; unique_keys: { name: string; primary: boolean; columns: string[] }[] }
  >;
}

/** One engine's half of the fixtures: how a catalog column row becomes a ColMeta, as that backend's tableMeta builds it. */
export interface Engine {
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

export const engines: Engine[] = [
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

const catalogs = readFixture<{ catalogs: Record<string, Catalog> }>("catalogs.json").catalogs;

/** The engine's catalog and its tables keyed `schema.table`. */
export function engineCatalog(engine: Engine): { catalog: Catalog; tables: Map<string, TableMeta> } {
  const catalog = catalogs[engine.name];
  if (!catalog) throw new Error(`catalogs.json has no ${engine.name} catalog`);
  return { catalog, tables: catalogTables(engine, catalog) };
}

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
