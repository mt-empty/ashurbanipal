// Serves docs/ the way GitHub Pages does for the demos — gzip for html/js/wasm,
// no COOP/COEP headers — at http://localhost:4003/demo/ and /demo/live/.
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../docs", import.meta.url));
const port = Number(process.env.PORT ?? 4003);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".gz": "application/gzip",
};
const COMPRESS = new Set([".html", ".js", ".wasm"]);

createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    return void res.writeHead(400, { "content-type": "text/plain" }).end("Bad Request");
  }
  let file = join(root, normalize(pathname));
  if (!file.startsWith(root)) return void res.writeHead(403).end();
  try {
    if (statSync(file).isDirectory()) {
      if (!pathname.endsWith("/")) return void res.writeHead(301, { location: `${pathname}/` }).end();
      file = join(file, "index.html");
    }
    let body = readFileSync(file);
    const ext = extname(file);
    const headers = { "content-type": TYPES[ext] ?? "application/octet-stream" };
    if (COMPRESS.has(ext) && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
      body = gzipSync(body);
      headers["content-encoding"] = "gzip";
    }
    res.writeHead(200, headers).end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not Found");
  }
}).listen(port, () => console.log(`demos at http://localhost:${port}/demo/ and /demo/live/`));
