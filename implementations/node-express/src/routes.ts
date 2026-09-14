import express, { type Router as ExpressRouter, type Request, type Response } from "express";
import { basePath, type Config, isEnabled, type ResolvedLimits, withDefaults } from "./config.js";
import type { DbSource } from "./db/types.js";
import { dbviewerHtml } from "./embed.js";
import { FilterError, NOT_ALLOWED_CODE, NotAllowedError } from "./errors.js";
import { type Condition, parseFilter } from "./filter.js";
import { checkSiblings } from "./siblings.js";

const PROTOCOL_HEADER = "x-ashurbanipal-protocol";
// Bumped only for non-additive wire changes (spec/protocol.md §7).
const PROTOCOL_VERSION = "1";

/**
 * One registered `DbSource`, named for `source` param resolution
 * (spec/protocol.md §1's "Resolved source", §5.8) — a live connection
 * object, never `Config` data (a host constructs these itself, same as
 * the single-source `DbSource` this replaces).
 */
export interface NamedSource {
  name: string;
  source: DbSource;
}

/**
 * Mounts the Ashurbanipal viewer's routes (the UI plus the API routes)
 * at cfg's base path into a plain express.Router — the host does
 * `app.use(createRouter(config, sources))`, constructing whichever
 * `DbSource` implementation(s) (PostgresSource, SqliteSource, MySqlSource)
 * it wants itself; there is no driver auto-detection. `sources` MUST be
 * non-empty — a host with nothing to browse should pass `enabled: false`
 * instead, not an empty list.
 *
 * When cfg.enabled is not true — including an empty/undefined Config,
 * which MUST mean disabled — createRouter returns a router that 404s
 * every request under basePath, indistinguishable from the viewer never
 * having been mounted at all (spec/protocol.md §4).
 */
export function createRouter(config: Config, sources: NamedSource[]): ExpressRouter {
  const router = express.Router();
  if (!isEnabled(config)) {
    // No routes registered under basePath: Express's own 404 handling
    // takes over for anything unmatched, identical to the viewer never
    // having been mounted.
    return router;
  }
  if (sources.length === 0) {
    throw new Error("createRouter requires at least one source");
  }

  const limits = withDefaults(config.limits);
  const timeoutMs = limits.queryTimeoutSecs * 1000;
  const mount = basePath(config);

  registerGet(router, mount, serveHtml);
  registerGet(router, `${mount}/api/sources`, withProtocolHeader(listSourcesHandler(sources)));
  registerGet(router, `${mount}/api/schemas`, withProtocolHeader(listSchemasHandler(sources, timeoutMs)));
  registerGet(router, `${mount}/api/tables`, withProtocolHeader(listTablesHandler(sources, timeoutMs)));
  registerGet(router, `${mount}/api/table-counts`, withProtocolHeader(tableCountsHandler(sources, timeoutMs)));
  registerGet(router, `${mount}/api/tables/data`, withProtocolHeader(tableDataHandler(sources, limits, timeoutMs)));
  registerGet(router, `${mount}/api/tables/common-values`, withProtocolHeader(commonValuesHandler(sources, timeoutMs)));
  registerGet(router, `${mount}/api/tables/referenced-by`, withProtocolHeader(referencedByHandler(sources, timeoutMs)));
  registerGet(router, `${mount}/api/siblings`, withProtocolHeader(siblingsHandler(config.siblings ?? [])));

  return router;
}

/**
 * Resolves the `source` query param against `sources` the same way
 * `schema` resolves against a live catalog list (spec/protocol.md §1):
 * absent means the first-registered default, present means an exact
 * case-sensitive match or a rejection — never a fallback guess.
 */
function resolveSource(sources: NamedSource[], requested: string | undefined): DbSource {
  if (requested === undefined) return sources[0].source;
  const found = sources.find((s) => s.name === requested);
  if (found === undefined) {
    throw new NotAllowedError(`source ${JSON.stringify(requested)}`, "source");
  }
  return found.source;
}

// Return 405 for non-GET methods on an existing protocol path.
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

// RFC 9457 Problem Details (spec/protocol.md §2) — `type` is always
// "about:blank", Ashurbanipal defines no problem-type URI namespace.
function httpProblemError(res: Response, status: number, code: string, title: string): void {
  res
    .status(status)
    .type("application/problem+json")
    .send(JSON.stringify({ type: "about:blank", title, status, code }));
}

// Maps a DbSource/filter error to the wire's error taxonomy
// (spec/protocol.md §2): NotAllowedError's kind picks the exact
// unknown_*/not_readable code; FilterError is always invalid_filter;
// anything else is a database failure (500). Status code + code are the
// contract — `title` wording is implementation-defined.
function writeError(res: Response, err: unknown): void {
  if (err instanceof NotAllowedError) {
    httpProblemError(res, 400, NOT_ALLOWED_CODE[err.kind], err.message);
    return;
  }
  if (err instanceof FilterError) {
    httpProblemError(res, 400, "invalid_filter", err.message);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  httpProblemError(res, 500, "database_error", `database error: ${message}`);
}

function listSourcesHandler(sources: NamedSource[]) {
  return async (_req: Request, res: Response): Promise<void> => {
    res.json({ sources: sources.map(({ name }) => ({ name })) });
  };
}

function listSchemasHandler(sources: NamedSource[], timeoutMs: number) {
  return async (req: Request, res: Response): Promise<void> => {
    const source = resolveSource(sources, firstQueryValue(req, "source"));
    const schemas = await source.listSchemas(timeoutMs);
    res.json({ schemas });
  };
}

function listTablesHandler(sources: NamedSource[], timeoutMs: number) {
  return async (req: Request, res: Response): Promise<void> => {
    const source = resolveSource(sources, firstQueryValue(req, "source"));
    const schema = firstQueryValue(req, "schema");
    const tables = await source.listTables(schema, timeoutMs);
    res.json({ tables });
  };
}

function tableCountsHandler(sources: NamedSource[], timeoutMs: number) {
  return async (req: Request, res: Response): Promise<void> => {
    const source = resolveSource(sources, firstQueryValue(req, "source"));
    const schema = firstQueryValue(req, "schema");
    const counts = await source.tableCounts(schema, timeoutMs);
    res.json({ counts });
  };
}

function tableDataHandler(sources: NamedSource[], limits: ResolvedLimits, timeoutMs: number) {
  return async (req: Request, res: Response): Promise<void> => {
    const source = resolveSource(sources, firstQueryValue(req, "source"));
    const schema = firstQueryValue(req, "schema");
    const table = firstQueryValue(req, "table");
    if (table === undefined) {
      httpProblemError(res, 400, "invalid_parameter", "table parameter is required");
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
      httpProblemError(res, 400, "invalid_parameter", err instanceof Error ? err.message : String(err));
      return;
    }

    let offset: number;
    try {
      offset = parseSaturating(req, "offset") ?? 0;
      if (offset < 0) offset = 0;
    } catch (err) {
      httpProblemError(res, 400, "invalid_parameter", err instanceof Error ? err.message : String(err));
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
      httpProblemError(res, 400, "invalid_parameter", `invalid order "${order}" (expected "asc" or "desc")`);
      return;
    }

    const data = await source.queryTable(
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

function commonValuesHandler(sources: NamedSource[], timeoutMs: number) {
  return async (req: Request, res: Response): Promise<void> => {
    const source = resolveSource(sources, firstQueryValue(req, "source"));
    const schema = firstQueryValue(req, "schema");
    const table = firstQueryValue(req, "table");
    const column = firstQueryValue(req, "column");
    if (table === undefined || column === undefined) {
      httpProblemError(res, 400, "invalid_parameter", "table and column parameters are required");
      return;
    }
    const values = await source.commonValues(schema, table, column, timeoutMs);
    res.json({ values });
  };
}

function referencedByHandler(sources: NamedSource[], timeoutMs: number) {
  return async (req: Request, res: Response): Promise<void> => {
    const source = resolveSource(sources, firstQueryValue(req, "source"));
    const schema = firstQueryValue(req, "schema");
    const table = firstQueryValue(req, "table");
    if (table === undefined) {
      httpProblemError(res, 400, "invalid_parameter", "table parameter is required");
      return;
    }
    const entries = await source.referencedBy(schema, table, timeoutMs);
    res.json({ referenced_by: entries });
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

// Clamp numeric limit/offset without precision loss; reject only non-numeric text
// (spec/protocol.md §5.4).
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
