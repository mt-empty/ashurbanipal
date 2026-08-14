// Fake backend for the GitHub Pages demo: patches window.fetch to answer
// dbviewer.html's /api/* calls from demo-fixtures.ts instead of a real
// server. Bundled separately (build-demo.mjs) and spliced into a copy of
// dbviewer.html as a classic <script>, before the app's own type="module"
// script — module scripts are deferred, so this always installs first.
//
// Deliberately more "correct" than the real protocol in one place: filter
// comparisons here use each column's native type (numeric compares
// numeric, dates compare chronologically), not spec/protocol.md §5.4.2's
// documented text-cast quirk (lexicographic "10" < "9") — this is a
// showcase, so a viewer poking at it should see it work, not relive a
// deliberate v1 wart.
import { SCHEMAS, SIBLINGS, TABLES, type CellValue, type TableDef } from "./demo-fixtures.js";
import type { FilterCondition } from "./types.js";

function toWire(v: CellValue): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-ashurbanipal-protocol": "1" },
  });
}
function badRequest(msg: string): Response {
  return new Response(msg, {
    status: 400,
    headers: { "content-type": "text/plain", "x-ashurbanipal-protocol": "1" },
  });
}

function tablesFor(schema: string): TableDef[] {
  return TABLES.filter((t) => t.schema === schema);
}
function resolveSchema(params: URLSearchParams): { schema: string } | { error: string } {
  const requested = params.get("schema");
  if (requested === null) return { schema: "public" };
  if (!SCHEMAS.includes(requested)) return { error: `unknown schema: ${requested}` };
  return { schema: requested };
}
function columnType(table: TableDef, name: string): string {
  return table.columns.find((c) => c.name === name)?.type ?? "text";
}
function isNumericType(t: string): boolean {
  return t === "integer" || t === "numeric";
}
function isDateType(t: string): boolean {
  return t.startsWith("timestamp") || t === "date";
}
function typedCompare(t: string, a: CellValue, b: CellValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (isNumericType(t)) return Number(a) - Number(b);
  if (isDateType(t)) return new Date(String(a)).getTime() - new Date(String(b)).getTime();
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  return String(toWire(a)).localeCompare(String(toWire(b)));
}
function likeToRegExp(pattern: string, ci: boolean): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, ci ? "i" : "");
}
function matchesCondition(table: TableDef, row: Record<string, CellValue>, cond: FilterCondition): boolean {
  const t = columnType(table, cond.column);
  const cell = row[cond.column];
  const wire = toWire(cell);
  let result: boolean;
  switch (cond.op) {
    case "IS NULL": result = wire === null; break;
    case "IS NOT NULL": result = wire !== null; break;
    case "=": result = wire !== null && wire === cond.value; break;
    case "!=": result = wire === null || wire !== cond.value; break;
    case "LIKE": result = wire !== null && likeToRegExp(cond.value ?? "", false).test(wire); break;
    case "ILIKE": result = wire !== null && likeToRegExp(cond.value ?? "", true).test(wire); break;
    case ">": case "<": case ">=": case "<=": {
      if (wire === null) { result = false; break; }
      const target = isNumericType(t) ? Number(cond.value) : (cond.value ?? "");
      const cmp = typedCompare(t, cell, target);
      result = cond.op === ">" ? cmp > 0 : cond.op === "<" ? cmp < 0 : cond.op === ">=" ? cmp >= 0 : cmp <= 0;
      break;
    }
    default: result = false;
  }
  return cond.not ? !result : result;
}
// AND binds tighter than OR (spec/protocol.md §5.4.2): fold the flat
// condition list into OR-of-AND-groups on each "OR" logic token.
function matchesFilter(table: TableDef, row: Record<string, CellValue>, conditions: FilterCondition[]): boolean {
  if (conditions.length === 0) return true;
  const groups: FilterCondition[][] = [[conditions[0]!]];
  for (let i = 1; i < conditions.length; i++) {
    const c = conditions[i]!;
    if (c.logic === "OR") groups.push([c]);
    else groups[groups.length - 1]!.push(c);
  }
  return groups.some((g) => g.every((c) => matchesCondition(table, row, c)));
}
function allRows(table: TableDef): Record<string, CellValue>[] {
  return Array.from({ length: table.rowCount }, (_, i) => table.row(i));
}

function handleSchemas(): Response {
  return jsonResponse({ schemas: SCHEMAS });
}
function handleTables(params: URLSearchParams): Response {
  const s = resolveSchema(params);
  if ("error" in s) return badRequest(s.error);
  return jsonResponse({
    tables: tablesFor(s.schema).map((t) => (t.comment ? { name: t.name, comment: t.comment } : { name: t.name })),
  });
}
function handleTableCounts(params: URLSearchParams): Response {
  const s = resolveSchema(params);
  if ("error" in s) return badRequest(s.error);
  return jsonResponse({ counts: tablesFor(s.schema).map((t) => ({ table: t.name, approx_rows: t.approxRows })) });
}
function handleTableData(params: URLSearchParams): Response {
  const s = resolveSchema(params);
  if ("error" in s) return badRequest(s.error);
  const tableName = params.get("table");
  const table = tablesFor(s.schema).find((t) => t.name === tableName);
  if (!table) return badRequest(`unknown table: ${tableName}`);

  let rows = allRows(table);
  const filterParam = params.get("filter");
  if (filterParam) {
    let conditions: FilterCondition[];
    try {
      conditions = JSON.parse(filterParam);
    } catch {
      return badRequest("invalid filter JSON");
    }
    if (!Array.isArray(conditions)) return badRequest("invalid filter JSON");
    for (const c of conditions) {
      if (!table.columns.some((col) => col.name === c.column)) return badRequest(`unknown filter column: ${c.column}`);
    }
    rows = rows.filter((r) => matchesFilter(table, r, conditions));
  }

  const sort = params.get("sort");
  if (sort) {
    if (!table.columns.some((c) => c.name === sort)) return badRequest(`unknown sort column: ${sort}`);
    const order = params.get("order");
    if (order !== null && order !== "asc" && order !== "desc") return badRequest("invalid order");
    const dir = order === "desc" ? -1 : 1;
    const t = columnType(table, sort);
    rows = [...rows].sort((a, b) => dir * typedCompare(t, a[sort]!, b[sort]!));
  }

  const limit = Math.min(100, Math.max(1, Number(params.get("limit")) || 50));
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const page = rows.slice(offset, offset + limit);

  return jsonResponse({
    columns: table.columns,
    rows: page.map((r) => Object.fromEntries(table.columns.map((c) => [c.name, toWire(r[c.name]!)]))),
    total_approx: table.approxRows,
  });
}
function handleCommonValues(params: URLSearchParams): Response {
  const s = resolveSchema(params);
  if ("error" in s) return badRequest(s.error);
  const table = tablesFor(s.schema).find((t) => t.name === params.get("table"));
  if (!table) return badRequest(`unknown table: ${params.get("table")}`);
  const column = params.get("column");
  if (!column || !table.columns.some((c) => c.name === column)) return badRequest(`unknown column: ${column}`);

  const rows = allRows(table);
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = toWire(r[column]!);
    if (v === null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const values = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([value, count]) => ({ value, freq: count / rows.length }));
  return jsonResponse({ values });
}
function handleSiblings(): Response {
  return jsonResponse({ siblings: SIBLINGS });
}

const realFetch = window.fetch.bind(window);
// Same derivation as api.ts's API constant — matches whatever path this
// page is actually served at, so the demo works from any GitHub Pages
// project/user-site prefix without hardcoding one.
const API_BASE = location.pathname.replace(/\/+$/, "") + "/api";

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(rawUrl, location.href);
  if (!url.pathname.startsWith(API_BASE)) return realFetch(input, init);
  const path = url.pathname.slice(API_BASE.length);
  const params = url.searchParams;
  switch (path) {
    case "/schemas": return handleSchemas();
    case "/tables": return handleTables(params);
    case "/table-counts": return handleTableCounts(params);
    case "/tables/data": return handleTableData(params);
    case "/tables/common-values": return handleCommonValues(params);
    case "/siblings": return handleSiblings();
    default: return realFetch(input, init);
  }
};

document.addEventListener("DOMContentLoaded", () => {
  const badge = document.createElement("div");
  badge.textContent = "Demo — synthetic data, no live backend";
  Object.assign(badge.style, {
    position: "fixed", bottom: "0.5rem", right: "0.5rem", zIndex: "9999",
    background: "#222", color: "#eee", font: "12px ui-monospace, monospace",
    padding: "4px 8px", borderRadius: "4px", opacity: "0.85", pointerEvents: "none",
  });
  document.body.appendChild(badge);
});
