import express, { type Router as ExpressRouter, type Request, type Response } from "express";
import { basePath, type Config, isEnabled, type SiblingsView, siblingsView, withDefaults } from "./config.js";
import { dbviewerHtml, dbviewerHtmlGzip } from "./embed.js";
import { API_PATHS, handleApi, type NamedSource } from "./handlers.js";
import { checkSiblings } from "./siblings.js";

export type { NamedSource } from "./handlers.js";

/**
 * Mounts the Ashurbanipal viewer's routes (the UI plus the API routes)
 * at cfg's base path into a plain express.Router — the host does
 * `app.use(createRouter(config, sources))`, constructing whichever
 * `DbSource` implementation(s) (PostgresSource, SqliteSource, MySqlSource)
 * it wants itself; there is no driver auto-detection. `sources` MUST be
 * non-empty — a host with nothing to browse should pass `enabled: false`
 * instead, not an empty list. Sibling config is never rejected:
 * /api/siblings reports what it corrected in `warnings`.
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

  const opts = { limits: withDefaults(config.limits), siblings: siblingsBody(siblingsView(config)) };
  const mount = basePath(config);

  registerGet(router, mount, serveHtml);
  for (const path of API_PATHS) {
    registerGet(router, `${mount}/api${path}`, async (req, res) => {
      const r = await handleApi(sources, path, (key) => firstQueryValue(req, key), opts);
      res.status(r.status).set(r.headers).send(r.body);
    });
  }

  return router;
}

// Return 405 for non-GET methods on an existing protocol path. A handler's
// rejection goes to Express's error handling, never an unhandled rejection.
function registerGet(
  router: ExpressRouter,
  path: string,
  handler: (req: Request, res: Response) => void | Promise<void>,
): void {
  router.all(path, (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).set("Allow", "GET, HEAD").type("text/plain; charset=utf-8").send("Method Not Allowed");
      return;
    }
    Promise.resolve(handler(req, res)).catch(next);
  });
}

// The page carries neither API header (spec/protocol.md §5.1), so it is wired
// directly rather than through handleApi.
function serveHtml(req: Request, res: Response): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.vary("Accept-Encoding");
  if (req.acceptsEncodings("gzip")) {
    res.setHeader("Content-Encoding", "gzip");
    res.status(200).send(dbviewerHtmlGzip);
    return;
  }
  res.status(200).send(dbviewerHtml);
}

function siblingsBody({ instance, siblings, warnings }: SiblingsView): () => Promise<unknown> {
  return async () => ({
    ...(instance && { instance: { name: instance.name, label: instance.label } }),
    siblings: await checkSiblings(siblings, instance),
    ...(warnings.length > 0 && { warnings }),
  });
}

function firstQueryValue(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}
