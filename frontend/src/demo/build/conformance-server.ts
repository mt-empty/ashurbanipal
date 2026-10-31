// Node: serves the live demo's route layer over HTTP, on PGlite loaded with
// conformance/seed/seed.sql, so the conformance kit can check the demo's
// backend like any port's (`mise run frontend:demo-conformance-server`).
// Single source, no siblings: the kit's default configuration.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { withDefaults } from "../../../../implementations/node-express/src/config.js";
import { openSource } from "../live/open-source.js";
import { handleApi } from "../live/routes.js";

const MOUNT = "/__ashurbanipal";
const repo = new URL("../../../../", import.meta.url);
const port = Number(process.env.PORT ?? 4005);

const seed = readFileSync(new URL("conformance/seed/seed.sql", repo), "utf8");
const html = readFileSync(new URL("frontend/dbviewer.html", repo));
const htmlGzip = gzipSync(html);
const sources = [{ name: "primary", source: await openSource(seed, { extensions: { pgcrypto } }) }];
const options = { limits: withDefaults(undefined), siblings: () => ({ siblings: [] }) };

// RFC 9110 §12.5.3: an explicit gzip entry decides; otherwise `*` does; q=0 refuses.
function acceptsGzip(header: string | undefined): boolean {
  const q = new Map<string, number>();
  for (const part of (header ?? "").split(",")) {
    const [coding, ...params] = part.split(";").map((s) => s.trim().toLowerCase());
    const weight = params.find((p) => p.startsWith("q="));
    if (coding) q.set(coding, weight ? Number(weight.slice(2)) : 1);
  }
  return (q.get("gzip") ?? q.get("*") ?? 0) > 0;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  const isUi = url.pathname === MOUNT || url.pathname === `${MOUNT}/`;
  if (!isUi && !url.pathname.startsWith(`${MOUNT}/api/`)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not Found");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" }).end("Method Not Allowed");
    return;
  }
  if (isUi) {
    const gzip = acceptsGzip(req.headers["accept-encoding"]);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      vary: "Accept-Encoding",
      ...(gzip ? { "content-encoding": "gzip" } : {}),
    });
    res.end(req.method === "HEAD" ? undefined : gzip ? htmlGzip : html);
    return;
  }
  const r = await handleApi(sources, url.pathname.slice(`${MOUNT}/api`.length), url.searchParams, options);
  res.writeHead(r.status, r.headers).end(req.method === "HEAD" ? undefined : r.body);
}).listen(port, () => console.log(`demo backend (conformance) on http://localhost:${port}${MOUNT}`));
