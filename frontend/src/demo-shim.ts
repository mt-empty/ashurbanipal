// Fake backend for the GitHub Pages demo: answers dbviewer.html's /api/*
// calls from demo-fixtures.ts instead of a real server.
import { type CellValue, SCHEMAS, SIBLINGS, TABLES, type TableDef } from "./demo-fixtures.js";
import type { FilterCondition, FilterOp } from "./types.js";

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
// Compares by native type, not spec/protocol.md §5.4.2's text-cast
// lexicographic quirk ("10" < "9") — a demo should show filtering work.
function typedCompare(t: string, a: CellValue, b: CellValue): number {
  if (a === null && b === null) return 0;
  // Nulls compare as greater than any value, matching Postgres's default
  // (NULLS LAST ascending, NULLS FIRST descending) once the caller
  // multiplies by direction — not a fixed "nulls always first" rule.
  if (a === null) return 1;
  if (b === null) return -1;
  if (isNumericType(t)) return Number(a) - Number(b);
  if (isDateType(t)) return new Date(String(a)).getTime() - new Date(String(b)).getTime();
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  return String(toWire(a)).localeCompare(String(toWire(b)));
}
const VALID_OPS = new Set<FilterOp>(["=", "!=", ">", "<", ">=", "<=", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL"]);
function likeToRegExp(pattern: string, ci: boolean): RegExp {
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, ci ? "i" : "");
}
function matchesCondition(table: TableDef, row: Record<string, CellValue>, cond: FilterCondition): boolean {
  const t = columnType(table, cond.column);
  const cell = row[cond.column];
  const wire = toWire(cell);
  let result: boolean;
  switch (cond.op) {
    case "IS NULL":
      result = wire === null;
      break;
    case "IS NOT NULL":
      result = wire !== null;
      break;
    case "=":
      result = wire !== null && wire === cond.value;
      break;
    case "!=":
      result = wire === null || wire !== cond.value;
      break;
    case "LIKE":
      result = wire !== null && likeToRegExp(cond.value ?? "", false).test(wire);
      break;
    case "ILIKE":
      result = wire !== null && likeToRegExp(cond.value ?? "", true).test(wire);
      break;
    case ">":
    case "<":
    case ">=":
    case "<=": {
      if (wire === null) {
        result = false;
        break;
      }
      const target = isNumericType(t) ? Number(cond.value) : (cond.value ?? "");
      const cmp = typedCompare(t, cell, target);
      result = cond.op === ">" ? cmp > 0 : cond.op === "<" ? cmp < 0 : cond.op === ">=" ? cmp >= 0 : cmp <= 0;
      break;
    }
    // Unreachable given FilterOp's 10 members are all handled above — a
    // future member added without a matching case fails to compile here.
    default: {
      const _exhaustive: never = cond.op;
      result = false;
    }
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

// Single fake source: the hosted demo has nothing to switch between, so
// #source-select-wrap stays hidden the same way it would for any real
// single-source host — see loadSources.
function handleSources(): Response {
  return jsonResponse({ sources: [{ name: "demo" }] });
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
      if (!VALID_OPS.has(c.op)) return badRequest(`unknown filter op: ${c.op}`);
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

  // Number(x) || fallback treats an explicit "0" the same as absent —
  // wrong for offset=0 (a legitimate value) and clamps limit=0 up to the
  // default instead of down to the minimum. Check for absent/NaN instead.
  const limitParam = params.get("limit");
  const limitNum = limitParam === null ? NaN : Number(limitParam);
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitNum) ? limitNum : 50));
  const offsetParam = params.get("offset");
  const offsetNum = offsetParam === null ? NaN : Number(offsetParam);
  const offset = Math.max(0, Number.isFinite(offsetNum) ? offsetNum : 0);
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
const API_BASE = `${location.pathname.replace(/\/+$/, "")}/api`;

// Runs at top level, not inside a DOMContentLoaded handler: build-demo.mjs
// splices this in as a classic <script>, which installs before
// dbviewer.html's own deferred type="module" script ever runs.
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(rawUrl, location.href);
  if (!url.pathname.startsWith(API_BASE)) return realFetch(input, init);
  const path = url.pathname.slice(API_BASE.length);
  const params = url.searchParams;
  switch (path) {
    case "/sources":
      return handleSources();
    case "/schemas":
      return handleSchemas();
    case "/tables":
      return handleTables(params);
    case "/table-counts":
      return handleTableCounts(params);
    case "/tables/data":
      return handleTableData(params);
    case "/tables/common-values":
      return handleCommonValues(params);
    case "/siblings":
      return handleSiblings();
    default:
      return realFetch(input, init);
  }
};

document.addEventListener("DOMContentLoaded", () => {
  const badge = document.createElement("div");
  badge.textContent = "Demo — synthetic data, no live backend";
  Object.assign(badge.style, {
    position: "fixed",
    bottom: "0.5rem",
    right: "0.5rem",
    zIndex: "9999",
    background: "#222",
    color: "#eee",
    font: "12px ui-monospace, monospace",
    padding: "4px 8px",
    borderRadius: "4px",
    opacity: "0.85",
    pointerEvents: "none",
  });
  document.body.appendChild(badge);
});
