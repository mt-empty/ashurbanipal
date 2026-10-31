import type { ResolvedLimits } from "./config.js";
import type { DbSource } from "./db/types.js";
import { FilterError, isQueryTimeout, NOT_ALLOWED_CODE, NotAllowedError } from "./errors.js";
import { type Condition, parseFilter, parseFilterForJoin } from "./filter.js";
import { BadJoinError, BadParamError, parseJoin } from "./join.js";

const PROTOCOL_HEADER = "x-ashurbanipal-protocol";
// Bumped only for non-additive wire changes (spec/protocol.md §7).
const PROTOCOL_VERSION = "1";

/**
 * One registered `DbSource`, named for `source` param resolution
 * (spec/protocol.md §1's "Resolved source", §5.8) — a live connection
 * object, never `Config` data (a host constructs these itself).
 */
export interface NamedSource {
  name: string;
  source: DbSource;
}

export interface ApiOptions {
  limits: ResolvedLimits;
  /** The `/api/siblings` body; the caller owns sibling config and health checks. */
  siblings: () => Promise<unknown>;
}

/** An API response, ready for whichever HTTP layer sends it. */
export interface ApiResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Every protocol route's path, relative to `{mount}/api`; handleApi answers anything else with a 404. */
export const API_PATHS = [
  "/sources",
  "/schemas",
  "/tables",
  "/table-counts",
  "/tables/data",
  "/tables/common-values",
  "/tables/referenced-by",
  "/tables/structure",
  "/tables/join",
  "/siblings",
] as const;
type ApiPath = (typeof API_PATHS)[number];

/**
 * Answers one API request — `path` is relative to `{mount}/api`, `query`
 * reads a query parameter's first value — without any HTTP framework.
 * Every request failure becomes its spec/protocol.md §2 problem response;
 * it throws only for an empty `sources`, a host setup error.
 */
export async function handleApi(
  sources: NamedSource[],
  path: string,
  query: (key: string) => string | undefined,
  opts: ApiOptions,
): Promise<ApiResult> {
  if (sources.length === 0) throw new Error("handleApi requires at least one source");
  try {
    return await route(sources, path as ApiPath, query, opts);
  } catch (err) {
    return errorResult(err);
  }
}

async function route(
  sources: NamedSource[],
  path: ApiPath,
  query: (key: string) => string | undefined,
  { limits, siblings }: ApiOptions,
): Promise<ApiResult> {
  const timeoutMs = limits.queryTimeoutSecs * 1000;
  // Resolved per route, so a route that takes no `source` never rejects one.
  const source = () => resolveSource(sources, query("source"));
  const schema = query("schema");
  switch (path) {
    case "/sources":
      return json({ sources: sources.map(({ name }) => ({ name })), default: defaultSource(sources).name });
    case "/siblings":
      return json(await siblings());
    case "/schemas": {
      const listing = await source().listSchemas(timeoutMs);
      return json({ schemas: listing.schemas.map((name) => ({ name })), default: listing.default });
    }
    case "/tables":
      return json({ tables: await source().listTables(schema, timeoutMs) });
    case "/table-counts":
      return json({ counts: await source().tableCounts(schema, timeoutMs) });
    case "/tables/data": {
      const src = source();
      const table = required(query, "table");
      // An empty (or whitespace-only) filter param means "no filter", same
      // as an absent param; a valid-but-empty JSON array means the same
      // thing (spec/protocol.md §5.4.2).
      const rawFilter = query("filter");
      const filter: Condition[] = rawFilter !== undefined && rawFilter.trim() !== "" ? parseFilter(rawFilter) : [];
      const limit = clamp(parseSaturating(query, "limit") ?? limits.defaultPageSize, 1, limits.maxPageSize);
      const offset = Math.max(parseSaturating(query, "offset") ?? 0, 0);
      const sort = query("sort");
      const descending = parseOrder(query("order"));
      return json(
        await src.queryTable(schema, table, { limit, offset, sort: sort || undefined, descending, filter }, timeoutMs),
      );
    }
    case "/tables/join": {
      const src = source();
      const spec = parseJoin(required(query, "join"));
      const rawFilter = query("filter");
      const filter: Condition[] =
        rawFilter !== undefined && rawFilter.trim() !== "" ? parseFilterForJoin(rawFilter) : [];
      const limit = clamp(parseSaturating(query, "limit") ?? limits.defaultPageSize, 1, limits.maxPageSize);
      const offset = Math.max(parseSaturating(query, "offset") ?? 0, 0);
      const sort = query("sort");
      let sortJoin: number | undefined;
      const rawSortJoin = query("sort_join");
      if (rawSortJoin !== undefined) {
        if (!/^\d+$/.test(rawSortJoin.trim())) {
          throw new BadParamError(`invalid sort_join "${rawSortJoin}" (expected a table position)`);
        }
        sortJoin = Number(rawSortJoin.trim());
      }
      const descending = parseOrder(query("order"));
      return json(
        await src.queryJoin(
          schema,
          spec,
          { limit, offset, sort: sort || undefined, sortJoin, descending, filter },
          timeoutMs,
        ),
      );
    }
    case "/tables/common-values": {
      const src = source();
      const table = query("table");
      const column = query("column");
      if (table === undefined || column === undefined) {
        throw new BadParamError("table and column parameters are required");
      }
      return json({ values: await src.commonValues(schema, table, column, timeoutMs) });
    }
    case "/tables/referenced-by": {
      const src = source();
      return json({ referenced_by: await src.referencedBy(schema, required(query, "table"), timeoutMs) });
    }
    case "/tables/structure": {
      const src = source();
      return json(await src.structure(schema, required(query, "table"), timeoutMs));
    }
    default: {
      // A path outside API_PATHS. A new API_PATHS entry without a case fails to compile here.
      const _unhandled: never = path;
      return { status: 404, headers: apiHeaders("text/plain; charset=utf-8"), body: "Not Found" };
    }
  }
}

/** What an absent `source` param resolves to, which `/api/sources` reports as `default`. */
function defaultSource(sources: NamedSource[]): NamedSource {
  return sources[0];
}

/**
 * Resolves the `source` query param against `sources` the same way
 * `schema` resolves against a live catalog list (spec/protocol.md §1):
 * absent means the first-registered default, present means an exact
 * case-sensitive match or a rejection — never a fallback guess.
 */
function resolveSource(sources: NamedSource[], requested: string | undefined): DbSource {
  if (requested === undefined) return defaultSource(sources).source;
  const found = sources.find((s) => s.name === requested);
  if (found === undefined) {
    throw new NotAllowedError(`source ${JSON.stringify(requested)}`, "source");
  }
  return found.source;
}

function required(query: (key: string) => string | undefined, key: string): string {
  const value = query(key);
  if (value === undefined) throw new BadParamError(`${key} parameter is required`);
  return value;
}

function parseOrder(order: string | undefined): boolean {
  if (order === undefined || order === "" || order === "asc") return false;
  if (order === "desc") return true;
  throw new BadParamError(`invalid order "${order}" (expected "asc" or "desc")`);
}

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

// Clamp numeric limit/offset without precision loss; reject only non-numeric text
// (spec/protocol.md §5.4).
function parseSaturating(query: (key: string) => string | undefined, key: string): number | undefined {
  const raw = query(key)?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!/^[+-]?\d+$/.test(raw)) {
    throw new BadParamError(`invalid integer parameter "${key}": "${raw}"`);
  }
  let n = BigInt(raw);
  if (n < 0n) n = 0n;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (n > max) n = max;
  return Number(n);
}

// Every API response, success or error (spec/protocol.md §2/§7), carries the
// protocol version header and nosniff, which stops a browser from rendering
// echoed request text as HTML.
function apiHeaders(contentType: string): Record<string, string> {
  return { [PROTOCOL_HEADER]: PROTOCOL_VERSION, "X-Content-Type-Options": "nosniff", "Content-Type": contentType };
}

function json(body: unknown): ApiResult {
  return { status: 200, headers: apiHeaders("application/json; charset=utf-8"), body: JSON.stringify(body) };
}

// RFC 9457 Problem Details (spec/protocol.md §2) — `type` is always
// "about:blank", Ashurbanipal defines no problem-type URI namespace.
function problem(status: number, code: string, title: string): ApiResult {
  return {
    status,
    headers: apiHeaders("application/problem+json; charset=utf-8"),
    body: JSON.stringify({ type: "about:blank", title, status, code }),
  };
}

// Maps a DbSource/filter error to the wire's error taxonomy
// (spec/protocol.md §2): NotAllowedError's kind picks the exact
// unknown_*/not_readable code; FilterError is always invalid_filter;
// BadJoinError is invalid_join; a bad parameter is invalid_parameter; a statement stopped by the query
// timeout is query_timeout; anything else is a database failure (500). Status code + code are the
// contract — `title` wording is implementation-defined.
function errorResult(err: unknown): ApiResult {
  if (err instanceof NotAllowedError) return problem(400, NOT_ALLOWED_CODE[err.kind], err.message);
  if (err instanceof FilterError) return problem(400, "invalid_filter", err.message);
  if (err instanceof BadJoinError) return problem(400, "invalid_join", err.message);
  if (err instanceof BadParamError) return problem(400, "invalid_parameter", err.message);
  if (isQueryTimeout(err)) return problem(500, "query_timeout", "query timed out");
  const message = err instanceof Error ? err.message : String(err);
  return problem(500, "database_error", `database error: ${message}`);
}
