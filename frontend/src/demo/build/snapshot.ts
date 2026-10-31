// Node, at build time: seeds each demo source into PGlite and records what
// node-express's PostgresSource answers, for the synthetic page to serve.
import { openSource } from "../live/open-source.js";
import { SEEDS } from "../seeds.js";
import { DEMO_SOURCES } from "../sources.js";
import type { Snapshot, SnapshotSource, SnapshotTable } from "../synthetic/snapshot-types.js";

// Rows per table the synthetic page carries; larger tables are cut to their
// first rows by primary key, and their counts clamped to match.
const ROW_CAP = 200;
const TIMEOUT_MS = 60_000;

export async function buildSnapshot(): Promise<Snapshot> {
  const sources: SnapshotSource[] = [];
  for (const name of DEMO_SOURCES) {
    const src = await openSource(SEEDS[name]);
    const listing = await src.listSchemas(TIMEOUT_MS);
    const bySchema: SnapshotSource["bySchema"] = {};
    for (const schema of listing.schemas) {
      const tables = await src.listTables(schema, TIMEOUT_MS);
      const counts = new Map((await src.tableCounts(schema, TIMEOUT_MS)).map((c) => [c.table, c.approx_rows]));
      const tableData: Record<string, SnapshotTable> = {};
      for (const { name: table } of tables) {
        const opts = { limit: 1, offset: 0, descending: false, filter: [] };
        const { columns } = await src.queryTable(schema, table, opts, TIMEOUT_MS);
        const sort = columns.find((c) => c.key === "pk")?.name;
        const data = await src.queryTable(schema, table, { ...opts, limit: ROW_CAP, sort }, TIMEOUT_MS);
        const approx = counts.get(table) ?? -1;
        const commonValues: SnapshotTable["commonValues"] = {};
        for (const { name: column } of columns) {
          const values = await src.commonValues(schema, table, column, TIMEOUT_MS);
          if (values.length > 0) commonValues[column] = values;
        }
        tableData[table] = {
          columns: data.columns,
          rows: data.rows.map((r) => data.columns.map((c) => r[c.name])),
          approxRows: approx < 0 ? -1 : Math.min(approx, data.rows.length),
          structure: await src.structure(schema, table, TIMEOUT_MS),
          referencedBy: await src.referencedBy(schema, table, TIMEOUT_MS),
          commonValues,
        };
      }
      bySchema[schema] = { tables, tableData };
    }
    sources.push({ name, schemas: listing.schemas, defaultSchema: listing.default, bySchema });
  }
  return { sources };
}
