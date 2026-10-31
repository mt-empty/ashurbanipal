// The synthetic demo's backend: answers /api/* from the build-time snapshot
// of the seeded sources. Catalog routes replay what PostgresSource answered;
// /tables/data filters, sorts, and pages the snapshot rows in JS.
import snapshotData from "virtual:demo-snapshot";
import type { FilterCondition, FilterOp } from "../../core/types.js";
import { columnTypeClass } from "../../lib/format.js";
import { SIBLINGS, SIBLINGS_INSTANCE } from "../siblings.js";
import { type ApiResponse, json, problem } from "../wire.js";
import type { Snapshot, SnapshotSource, SnapshotTable } from "./snapshot-types.js";

type Cell = string | null;
const snapshot = snapshotData as Snapshot;
const DEFAULT_SOURCE = snapshot.sources[0];

function scope(params: URLSearchParams): { source: SnapshotSource; schema: string } | ApiResponse {
  const name = params.get("source");
  const source = name === null ? DEFAULT_SOURCE : snapshot.sources.find((s) => s.name === name);
  if (!source) return problem(400, "unknown_source", `source ${JSON.stringify(name)}`);
  const schema = params.get("schema") ?? source.defaultSchema;
  if (schema === null || !source.schemas.includes(schema)) {
    return problem(400, "unknown_schema", `schema ${JSON.stringify(schema)}`);
  }
  return { source, schema };
}
function tableIn(params: URLSearchParams): { table: SnapshotTable } | ApiResponse {
  const s = scope(params);
  if ("status" in s) return s;
  const name = params.get("table");
  if (name === null) return problem(400, "invalid_parameter", "table parameter is required");
  const { tableData } = s.source.bySchema[s.schema];
  const table = Object.hasOwn(tableData, name) ? tableData[name] : undefined;
  if (!table) return problem(400, "unknown_table", `table ${JSON.stringify(name)}`);
  return { table };
}

// Compares by native type, not spec/protocol.md §5.4.2's text-cast
// lexicographic quirk ("10" < "9") — a demo should show filtering work.
// Nulls sort as greater than any value: Postgres's NULLS LAST ascending.
function typedCompare(type: string, a: Cell, b: Cell): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const cls = columnTypeClass(type);
  if (cls === "number") return Number(a) - Number(b);
  if (cls === "date") return new Date(a).getTime() - new Date(b).getTime();
  return a < b ? -1 : a > b ? 1 : 0;
}
const VALID_OPS = new Set<FilterOp>(["=", "!=", ">", "<", ">=", "<=", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL"]);
function likeToRegExp(pattern: string, ci: boolean): RegExp {
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, ci ? "i" : "");
}
function matches(type: string, cell: Cell, cond: FilterCondition): boolean {
  let result: boolean;
  switch (cond.op) {
    case "IS NULL":
      result = cell === null;
      break;
    case "IS NOT NULL":
      result = cell !== null;
      break;
    case "=":
      result = cell !== null && cell === cond.value;
      break;
    case "!=":
      result = cell === null || cell !== cond.value;
      break;
    case "LIKE":
    case "ILIKE":
      result = cell !== null && likeToRegExp(cond.value ?? "", cond.op === "ILIKE").test(cell);
      break;
    case ">":
    case "<":
    case ">=":
    case "<=": {
      if (cell === null) {
        result = false;
        break;
      }
      const cmp = typedCompare(type, cell, cond.value ?? "");
      result = cond.op === ">" ? cmp > 0 : cond.op === "<" ? cmp < 0 : cond.op === ">=" ? cmp >= 0 : cmp <= 0;
      break;
    }
    // Unreachable while every FilterOp is handled above; a new one fails to compile here.
    default: {
      const _exhaustive: never = cond.op;
      result = false;
    }
  }
  return cond.not ? !result : result;
}
// AND binds tighter than OR (spec/protocol.md §5.4.2): fold the flat
// condition list into OR-of-AND groups on each "OR" logic token.
function matchesFilter(table: SnapshotTable, row: Cell[], conditions: FilterCondition[]): boolean {
  if (conditions.length === 0) return true;
  const groups: FilterCondition[][] = [[conditions[0]]];
  for (const c of conditions.slice(1)) {
    if (c.logic === "OR") groups.push([c]);
    else groups[groups.length - 1].push(c);
  }
  const at = (column: string) => table.columns.findIndex((c) => c.name === column);
  return groups.some((g) => g.every((c) => matches(table.columns[at(c.column)].type, row[at(c.column)], c)));
}

function tableData(params: URLSearchParams): ApiResponse {
  const t = tableIn(params);
  if ("status" in t) return t;
  const { table } = t;
  const has = (name: string) => table.columns.some((c) => c.name === name);
  let rows = table.rows;
  const filterParam = params.get("filter");
  if (filterParam?.trim()) {
    let conditions: FilterCondition[];
    try {
      conditions = JSON.parse(filterParam);
    } catch {
      return problem(400, "invalid_filter", "invalid filter JSON");
    }
    if (!Array.isArray(conditions)) return problem(400, "invalid_filter", "filter must be a JSON array");
    for (const c of conditions) {
      if (!VALID_OPS.has(c.op)) return problem(400, "invalid_filter", `unknown filter op: ${c.op}`);
      if (!has(c.column)) return problem(400, "unknown_column", `column ${JSON.stringify(c.column)}`);
    }
    rows = rows.filter((r) => matchesFilter(table, r, conditions));
  }
  const sort = params.get("sort");
  if (sort) {
    if (!has(sort)) return problem(400, "unknown_column", `column ${JSON.stringify(sort)}`);
    const order = params.get("order");
    if (order !== null && order !== "" && order !== "asc" && order !== "desc") {
      return problem(400, "invalid_parameter", `invalid order "${order}" (expected "asc" or "desc")`);
    }
    const i = table.columns.findIndex((c) => c.name === sort);
    const dir = order === "desc" ? -1 : 1;
    rows = [...rows].sort((a, b) => dir * typedCompare(table.columns[i].type, a[i], b[i]));
  }
  // Absent or non-numeric means the default; an explicit "0" is a real value
  // (offset 0, or a limit clamped up to the minimum).
  const num = (key: string, fallback: number) => {
    const n = Number(params.get(key) ?? Number.NaN);
    return Number.isFinite(n) ? n : fallback;
  };
  const limit = Math.min(100, Math.max(1, num("limit", 50)));
  const offset = Math.max(0, num("offset", 0));
  return json({
    columns: table.columns,
    rows: rows
      .slice(offset, offset + limit)
      .map((r) => Object.fromEntries(table.columns.map((c, i) => [c.name, r[i]]))),
    total_approx: table.approxRows,
  });
}

export async function serve(path: string, params: URLSearchParams): Promise<ApiResponse> {
  if (path === "/sources") {
    return json({ sources: snapshot.sources.map(({ name }) => ({ name })), default: DEFAULT_SOURCE.name });
  }
  if (path === "/siblings") return json({ instance: SIBLINGS_INSTANCE, siblings: SIBLINGS });
  if (path === "/tables/join") {
    return problem(400, "invalid_join", "Joins need a real database: switch to the live demo (link in the corner).");
  }
  if (path === "/schemas") {
    const s = scope(params);
    if ("status" in s) return s;
    return json({ schemas: s.source.schemas.map((name) => ({ name })), default: s.source.defaultSchema });
  }
  if (path === "/tables" || path === "/table-counts") {
    const s = scope(params);
    if ("status" in s) return s;
    const { tables, tableData } = s.source.bySchema[s.schema];
    if (path === "/tables") return json({ tables });
    return json({ counts: tables.map(({ name }) => ({ table: name, approx_rows: tableData[name].approxRows })) });
  }
  if (path === "/tables/data") return tableData(params);
  const t = tableIn(params);
  if ("status" in t) return t;
  switch (path) {
    case "/tables/common-values": {
      const column = params.get("column");
      if (column === null || !t.table.columns.some((c) => c.name === column)) {
        return problem(400, "unknown_column", `column ${JSON.stringify(column)}`);
      }
      return json({ values: t.table.commonValues[column] ?? [] });
    }
    case "/tables/referenced-by":
      return json({ referenced_by: t.table.referencedBy });
    case "/tables/structure":
      return json(t.table.structure);
    default:
      return { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Not Found" };
  }
}
