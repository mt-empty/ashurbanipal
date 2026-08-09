import express, { type Router as ExpressRouter, type Request, type Response } from "express";
import { basePath, type Config, isEnabled, type ResolvedLimits, validateConfig, withDefaults } from "./config.js";
import type { DbSource } from "./db/types.js";
import { dbviewerHtml } from "./embed.js";
import { FilterError, NotAllowedError } from "./errors.js";
import { type Condition, parseFilter } from "./filter.js";
import { checkSiblings } from "./siblings.js";

const PROTOCOL_HEADER = "x-ashurbanipal-protocol";
// Bumped only for non-additive wire changes; must track the Rust
// reference's PROTOCOL_VERSION and every other port's own constant
// (spec/protocol.md §7).
const PROTOCOL_VERSION = "1";

/**
 * Mounts the Ashurbanipal viewer's six routes (the UI plus five API
 * routes) at cfg's base path into a plain express.Router — the host does
 * `app.use(createRouter(config, dbSource))`, constructing whichever
 * `DbSource` implementation (PostgresSource, SqliteSource, MySqlSource)
 * it wants itself; there is no driver auto-detection.
 *
 * Throws ProductionEnabledError when enabledFor names a production-like
 * value (spec/protocol.md §4) — fail-closed via a thrown error, not a
 * silently-swallowed default, so a host's own startup fails to boot
 * exactly like the Rust binary does when Config::from_toml rejects it.
 *
 * When cfg is not enabled for the running environment — including an
 * empty/undefined Config, which MUST mean disabled — createRouter returns
 * a router that 404s every request under basePath, indistinguishable from
 * the viewer never having been mounted at all (spec/protocol.md §4).
 */
export function createRouter(config: Config, dbSource: DbSource): ExpressRouter {
  validateConfig(config);

  const router = express.Router();
  if (!isEnabled(config)) {
    // No routes registered under basePath: Express's own 404 handling
    // takes over for anything unmatched, identical to the viewer never
    // having been mounted.
    return router;
  }

  const limits = withDefaults(config.limits);
  const timeoutMs = limits.queryTimeoutSecs * 1000;
  const mount = basePath(config);

  registerGet(router, mount, serveHtml);
  registerGet(router, `${mount}/api/schemas`, withProtocolHeader(listSchemasHandler(dbSource, timeoutMs)));
  registerGet(router, `${mount}/api/tables`, withProtocolHeader(listTablesHandler(dbSource, timeoutMs)));
  registerGet(router, `${mount}/api/table-counts`, withProtocolHeader(tableCountsHandler(dbSource, timeoutMs)));
  registerGet(router, `${mount}/api/tables/data`, withProtocolHeader(tableDataHandler(dbSource, limits, timeoutMs)));
  registerGet(
    router,
    `${mount}/api/tables/common-values`,
    withProtocolHeader(commonValuesHandler(dbSource, timeoutMs)),
  );
  registerGet(router, `${mount}/api/siblings`, withProtocolHeader(siblingsHandler(config.siblings ?? [])));

  return router;
}

// spec/protocol.md §2/§5 only ever declares GET on these six paths, but
// Express's app.get() leaves every other verb unmatched, falling through
// to a generic 404 — indistinguishable from a nonexistent path. router.all
// plus an explicit method check yields 405 for a real path hit with the
// wrong verb, which is what every path already registered under `{mount}`
// should return (RFC 9110), and what the Rust/Go routers' underlying
// method-aware routers do automatically by matching path before method.
function registerGet(router: ExpressRouter, path: string, handler: (req: Request, res: Response) => void): void {
  router.all(path, (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).set("Allow", "GET, HEAD").type("text/plain; charset=utf-8").send("Method Not Allowed");
      return;
    }
    handler(req, res);
  });
}

// Stamps every API response, success or error (spec/protocol.md §2/§7),
// with the protocol version header. The HTML route (serveHtml) is wired
// directly, without this wrapper, since §5.1 carries no protocol header.
function withProtocolHeader(
  handler: (req: Request, res: Response) => void | Promise<void>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    res.setHeader(PROTOCOL_HEADER, PROTOCOL_VERSION);
    Promise.resolve(handler(req, res)).catch((err: unknown) => writeError(res, err));
  };
}

function serveHtml(_req: Request, res: Response): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(dbviewerHtml);
}

function httpTextError(res: Response, status: number, message: string): void {
  res.status(status).type("text/plain; charset=utf-8").send(message);
}

// Maps a DbSource/filter error to the wire's two error classes
// (spec/protocol.md §2): NotAllowedError/FilterError is a client mistake
// (400, plain text); anything else is a database failure (500). Status
// code is the contract — wording is implementation-defined.
function writeError(res: Response, err: unknown): void {
  if (err instanceof NotAllowedError || err instanceof FilterError) {
    httpTextError(res, 400, err.message);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  httpTextError(res, 500, `database error: ${message}`);
}

function listSchemasHandler(dbSource: DbSource, timeoutMs: number) {
  return async (_req: Request, res: Response): Promise<void> => {
    const schemas = await dbSource.listSchemas(timeoutMs);
    res.json({ schemas });
  };
}

function listTablesHandler(dbSource: DbSource, timeoutMs: number) {
  return async (req: Request, res: Response): Promise<void> => {
    const schema = firstQueryValue(req, "schema");
    const tables = await dbSource.listTables(schema, timeoutMs);
    res.json({ tables });
  };
}

function tableCountsHandler(dbSource: DbSource, timeoutMs: number) {
  return async (req: Request, res: Response): Promise<void> => {
    const schema = firstQueryValue(req, "schema");
    const counts = await dbSource.tableCounts(schema, timeoutMs);
    res.json({ counts });
  };
}

function tableDataHandler(dbSource: DbSource, limits: ResolvedLimits, timeoutMs: number) {
  return async (req: Request, res: Response): Promise<void> => {
    const schema = firstQueryValue(req, "schema");
    const table = firstQueryValue(req, "table");
    if (table === undefined) {
      httpTextError(res, 400, "table parameter is required");
      return;
    }

    // An empty (or whitespace-only) filter param means "no filter", same
    // as an absent param; a valid-but-empty JSON array means the same
    // thing (spec/protocol.md §5.4.2).
    let conditions: Condition[] = [];
    const rawFilter = firstQueryValue(req, "filter");
    if (rawFilter !== undefined && rawFilter.trim() !== "") {
      try {
        conditions = parseFilter(rawFilter);
      } catch (err) {
        writeError(res, err);
        return;
      }
    }

    let limit: number;
    try {
      const requested = parseSaturating(req, "limit");
      limit = clamp(requested ?? limits.defaultPageSize, 1, limits.maxPageSize);
    } catch (err) {
      httpTextError(res, 400, err instanceof Error ? err.message : String(err));
      return;
    }

    let offset: number;
    try {
      offset = parseSaturating(req, "offset") ?? 0;
      if (offset < 0) offset = 0;
    } catch (err) {
      httpTextError(res, 400, err instanceof Error ? err.message : String(err));
      return;
    }

    const sort = firstQueryValue(req, "sort");

    let descending = false;
    const order = firstQueryValue(req, "order") ?? "";
    if (order === "" || order === "asc") {
      descending = false;
    } else if (order === "desc") {
      descending = true;
    } else {
      httpTextError(res, 400, `invalid order "${order}" (expected "asc" or "desc")`);
      return;
    }

    const data = await dbSource.queryTable(
      schema,
      table,
      {
        limit,
        offset,
        sort: sort && sort !== "" ? sort : undefined,
        descending,
        filter: conditions,
      },
      timeoutMs,
    );
    res.json(data);
  };
}

function commonValuesHandler(dbSource: DbSource, timeoutMs: number) {
  return async (req: Request, res: Response): Promise<void> => {
    const schema = firstQueryValue(req, "schema");
    const table = firstQueryValue(req, "table");
    const column = firstQueryValue(req, "column");
    if (table === undefined || column === undefined) {
      httpTextError(res, 400, "table and column parameters are required");
      return;
    }
    const values = await dbSource.commonValues(schema, table, column, timeoutMs);
    res.json({ values });
  };
}

function siblingsHandler(siblings: Config["siblings"]) {
  return async (_req: Request, res: Response): Promise<void> => {
    const statuses = await checkSiblings(siblings ?? []);
    res.json({ siblings: statuses });
  };
}

function firstQueryValue(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

// Parses a query param as an arbitrary-precision integer (via BigInt) and
// saturates it into [0, Number.MAX_SAFE_INTEGER], mirroring the Rust
// reference's deserialize_saturating_u32 and the Go port's
// parseSaturating: spec/protocol.md §5.4 requires limit/offset to be
// clamped, never rejected, for any out-of-range numeric value. Parsing
// with BigInt first (rather than Number(), which silently loses precision
// or produces NaN differently) and saturating sidesteps a native-int
// range check rejecting the value before this code even runs. Only
// genuinely non-numeric text ("abc", "1.5", "") still 400s.
function parseSaturating(req: Request, key: string): number | undefined {
  const raw = firstQueryValue(req, key)?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!/^[+-]?\d+$/.test(raw)) {
    throw new Error(`invalid integer parameter "${key}": "${raw}"`);
  }
  let n = BigInt(raw);
  if (n < 0n) n = 0n;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (n > max) n = max;
  return Number(n);
}
