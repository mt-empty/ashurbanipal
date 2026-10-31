// The live demo's API routes over a DbSource, framework-free: a request's
// path and query in, a status, headers and body out (spec/protocol.md §5).
// Runs in the demo's worker and, for the conformance run, in Node.
import type { ResolvedLimits } from "../../../../implementations/node-express/src/config.js";
import type { DbSource } from "../../../../implementations/node-express/src/db/types.js";
import {
  FilterError,
  isQueryTimeout,
  NOT_ALLOWED_CODE,
  NotAllowedError,
} from "../../../../implementations/node-express/src/errors.js";
import {
  type Condition,
  parseFilter,
  parseFilterForJoin,
} from "../../../../implementations/node-express/src/filter.js";
import { BadJoinError, BadParamError, parseJoin } from "../../../../implementations/node-express/src/join.js";
import { type ApiResponse, json, problem } from "../wire.js";

export interface NamedSource {
  name: string;
  source: DbSource;
}

export interface RouteOptions {
  limits: ResolvedLimits;
  siblings: () => unknown | Promise<unknown>;
}

class ParamError extends Error {}

export async function handleApi(
  sources: NamedSource[],
  path: string,
  params: URLSearchParams,
  opts: RouteOptions,
): Promise<ApiResponse> {
  try {
    return await route(sources, path, params, opts);
  } catch (err) {
    return errorResponse(err);
  }
}

async function route(
  sources: NamedSource[],
  path: string,
  params: URLSearchParams,
  { limits, siblings }: RouteOptions,
): Promise<ApiResponse> {
  const timeoutMs = limits.queryTimeoutSecs * 1000;
  const first = (key: string) => params.get(key) ?? undefined;
  const required = (key: string) => {
    const v = first(key);
    if (v === undefined) throw new ParamError(`${key} parameter is required`);
    return v;
  };
  if (path === "/sources") {
    return json({ sources: sources.map(({ name }) => ({ name })), default: sources[0].name });
  }
  if (path === "/siblings") return json(await siblings());

  const source = resolveSource(sources, first("source"));
  const schema = first("schema");
  switch (path) {
    case "/schemas": {
      const listing = await source.listSchemas(timeoutMs);
      return json({ schemas: listing.schemas.map((name) => ({ name })), default: listing.default });
    }
    case "/tables":
      return json({ tables: await source.listTables(schema, timeoutMs) });
    case "/table-counts":
      return json({ counts: await source.tableCounts(schema, timeoutMs) });
    case "/tables/data": {
      const table = required("table");
      const rawFilter = first("filter");
      const filter = rawFilter !== undefined && rawFilter.trim() !== "" ? parseFilter(rawFilter) : [];
      const limit = clamp(parseSaturating(first("limit")) ?? limits.defaultPageSize, 1, limits.maxPageSize);
      const offset = Math.max(parseSaturating(first("offset")) ?? 0, 0);
      const sort = first("sort");
      const data = await source.queryTable(
        schema,
        table,
        { limit, offset, sort: sort || undefined, descending: parseOrder(first("order")), filter },
        timeoutMs,
      );
      return json(data);
    }
    case "/tables/join": {
      const spec = parseJoin(required("join"));
      const rawFilter = first("filter");
      const filter: Condition[] =
        rawFilter !== undefined && rawFilter.trim() !== "" ? parseFilterForJoin(rawFilter) : [];
      const limit = clamp(parseSaturating(first("limit")) ?? limits.defaultPageSize, 1, limits.maxPageSize);
      const offset = Math.max(parseSaturating(first("offset")) ?? 0, 0);
      const sort = first("sort");
      let sortJoin: number | undefined;
      const rawSortJoin = first("sort_join");
      if (rawSortJoin !== undefined) {
        if (!/^\d+$/.test(rawSortJoin.trim())) {
          throw new ParamError(`invalid sort_join "${rawSortJoin}" (expected a table position)`);
        }
        sortJoin = Number(rawSortJoin.trim());
      }
      const descending = parseOrder(first("order"));
      return json(
        await source.queryJoin(
          schema,
          spec,
          { limit, offset, sort: sort || undefined, sortJoin, descending, filter },
          timeoutMs,
        ),
      );
    }
    case "/tables/common-values": {
      const table = first("table");
      const column = first("column");
      if (table === undefined || column === undefined) {
        throw new ParamError("table and column parameters are required");
      }
      return json({ values: await source.commonValues(schema, table, column, timeoutMs) });
    }
    case "/tables/referenced-by":
      return json({ referenced_by: await source.referencedBy(schema, required("table"), timeoutMs) });
    case "/tables/structure":
      return json(await source.structure(schema, required("table"), timeoutMs));
    default:
      return { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Not Found" };
  }
}

function resolveSource(sources: NamedSource[], requested: string | undefined): DbSource {
  if (requested === undefined) return sources[0].source;
  const found = sources.find((s) => s.name === requested);
  if (found === undefined) throw new NotAllowedError(`source ${JSON.stringify(requested)}`, "source");
  return found.source;
}

function parseOrder(order: string | undefined): boolean {
  if (order === undefined || order === "" || order === "asc") return false;
  if (order === "desc") return true;
  throw new ParamError(`invalid order "${order}" (expected "asc" or "desc")`);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

// Clamp numeric limit/offset without precision loss; reject only non-numeric
// text (spec/protocol.md §5.4).
function parseSaturating(value: string | undefined): number | undefined {
  const raw = value?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!/^[+-]?\d+$/.test(raw)) throw new ParamError(`invalid integer parameter: "${raw}"`);
  let n = BigInt(raw);
  if (n < 0n) n = 0n;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (n > max) n = max;
  return Number(n);
}

function errorResponse(err: unknown): ApiResponse {
  if (err instanceof NotAllowedError) return problem(400, NOT_ALLOWED_CODE[err.kind], err.message);
  if (err instanceof FilterError) return problem(400, "invalid_filter", err.message);
  if (err instanceof BadJoinError) return problem(400, "invalid_join", err.message);
  if (err instanceof BadParamError || err instanceof ParamError) return problem(400, "invalid_parameter", err.message);
  if (isQueryTimeout(err)) return problem(500, "query_timeout", "query timed out");
  const message = err instanceof Error ? err.message : String(err);
  return problem(500, "database_error", `database error: ${message}`);
}
