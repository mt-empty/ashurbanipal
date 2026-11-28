// One Bombadil exploration of the viewer: start the Node demo on the seed database, run
// spec.ts against it, then summarise each failed property once from the trace. Exits 1
// when a property failed (Bombadil's own exit 2), and with Bombadil's code on any other error.
//   BOMBADIL_TIME       run length (default 10m)    BOMBADIL_PORT  demo port (default 4320)
//   BOMBADIL_REPRODUCE  a trace to replay instead of exploring; writes results/reproduce.bin
//   CHROME              Chrome or Chromium to drive (default: google-chrome/chromium on PATH, else Playwright's)
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const port = Number(process.env.BOMBADIL_PORT ?? 4320);
const timeLimit = process.env.BOMBADIL_TIME || "10m";
const origin = `http://localhost:${port}/__ashurbanipal/`;
const results = join(here, "results");
// A relative trace path is the caller's: mise runs this from tools/bombadil and passes the caller's directory.
const callerDir = process.env.MISE_ORIGINAL_CWD ?? process.cwd();
const replay = process.env.BOMBADIL_REPRODUCE ? resolve(callerDir, process.env.BOMBADIL_REPRODUCE) : null;
const trace = join(results, replay ? "reproduce.bin" : "run.bin");
const bombadil = join(here, "node_modules/.bin/bombadil");

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const name of ["google-chrome", "chromium", "chromium-browser"]) {
    const found = spawnSync("which", [name], { encoding: "utf8" }).stdout.trim();
    if (found) return found;
  }
  const cache = join(homedir(), ".cache/ms-playwright");
  const builds = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)) : [];
  builds.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const build of builds) {
    const chrome = join(cache, build, "chrome-linux64/chrome");
    if (existsSync(chrome)) return chrome;
  }
  throw new Error("no Chrome found: set CHROME, or run `mise run frontend:test-e2e-install --browsers chromium`");
}

// Something already answering on the port would be explored instead of the demo started here.
async function answers() {
  return fetch(origin).then(
    (r) => r.ok,
    () => false,
  );
}

async function waitForServer(server) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`the demo exited with ${server.exitCode}; see results/server.log`);
    if (await answers()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the demo did not answer at ${origin} within 120 s; see results/server.log`);
}

function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
}

function exited(child) {
  return new Promise((done, fail) => {
    child.on("error", fail);
    child.on("exit", (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

// The first state each property failed in, with what it saw there.
async function violations() {
  const reader = spawn(bombadil, ["trace", "--json", trace], { stdio: ["ignore", "pipe", "inherit"] });
  const done = exited(reader);
  const first = new Map();
  for await (const line of createInterface({ input: reader.stdout })) {
    if (!line.trim()) continue;
    const state = JSON.parse(line);
    for (const v of state.metadata.violations ?? []) {
      if (first.has(v.name)) continue;
      const raw = JSON.stringify(v.violation);
      // A failure built with Pure carries its own description; otherwise show the cells it read.
      const seen =
        raw.match(/"Pure":\{"pretty":"((?:[^"\\]|\\.)*)"/)?.[1] ?? raw.match(/"snapshots":(\[.*?\])/)?.[1] ?? raw;
      first.set(v.name, { index: state.index, url: state.metadata.state?.url, seen: seen.slice(0, 600) });
    }
  }
  const code = await done;
  if (code !== 0) throw new Error(`bombadil trace exited with ${code}`);
  return first;
}

if (replay === trace) throw new Error(`replay a copy, not ${trace}: this run writes its trace there`);
if (await answers()) throw new Error(`something already answers at ${origin}; stop it or set BOMBADIL_PORT`);
mkdirSync(results, { recursive: true });
const chrome = findChrome();

// The demo writes its log straight to the file, never through this process.
const logFd = openSync(join(results, "server.log"), "w");
const server = spawn("pnpm", ["run", "demo"], {
  cwd: join(root, "implementations/node-express"),
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CONFORMANCE_"))),
    DB_BACKEND: "postgres",
    PORT: String(port),
    SIBLING_PORT: "",
  },
  stdio: ["ignore", logFd, logFd],
  // Its own process group, so stop() also ends the node process pnpm starts.
  detached: true,
});
closeSync(logFd);

let explorer;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stop(explorer);
    stop(server);
    process.exit(130);
  });
}

let status;
try {
  await waitForServer(server);
  console.log(replay ? `replaying ${replay} with ${chrome}` : `exploring ${origin} for ${timeLimit} with ${chrome}`);
  explorer = spawn(
    bombadil,
    [
      "browser",
      "test",
      "--headless",
      "--no-sandbox",
      ...(replay ? ["--reproduce", replay] : ["--time-limit", timeLimit]),
      "--allow-url",
      "http://localhost/__ashurbanipal*",
      "--output-path",
      trace,
      "--output-path-overwrite",
      origin,
      "spec.ts",
    ],
    {
      cwd: here,
      stdio: ["ignore", "ignore", "inherit"],
      // Coverage instrumentation warns on every inline-script URL change; RUST_LOG=warn brings it back.
      env: { RUST_LOG: "error", ...process.env, CHROME: chrome },
      detached: true,
    },
  );
  status = await exited(explorer);
} finally {
  stop(server);
}
if (status !== 0 && status !== 2) {
  console.error(`bombadil exited with ${status}`);
  process.exit(status);
}

const found = await violations();
const lines =
  found.size === 0 ? ["no property failed"] : [`${found.size} propert${found.size === 1 ? "y" : "ies"} failed:`];
if (status === 2 && found.size === 0) lines[0] = "bombadil reported a violation, but none was read from the trace";
for (const [name, v] of found) lines.push(`- ${name}, first at state ${v.index} (${v.url})`, `  saw: ${v.seen}`);
lines.push(
  "",
  `inspect:   ${bombadil} browser inspect ${trace}`,
  `replay:    cp ${trace} ${results}/case.bin && BOMBADIL_REPRODUCE=${results}/case.bin mise run frontend:explore`,
);
const summary = lines.join("\n");
writeFileSync(join(results, "summary.txt"), `${summary}\n`);
console.log(summary);
process.exit(found.size === 0 && status === 0 ? 0 : 1);
