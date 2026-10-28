import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// The app is read-only, so tests need no isolation from each other: one demo
// server per browser project is enough, which spreads the request load of a
// three-browser run. Tests that need another configuration (siblings, a
// second source, a mount prefix) spawn their own through
// tests/support/second-server.ts.
const CRATE_ROOT = "../../implementations/rust/axum";
const PORTS = { chromium: 4310, firefox: 4311, webkit: 4312 };
const SHOWCASE_IGNORE = /showcase\.spec\.ts/;

// E2E_BACKEND picks the engine the demo browses; the suite is written for the Postgres seed, so on
// SQLite or MySQL only the default-scope smoke runs (docs/e2e-testing-guidelines.md §5).
const BACKEND = process.env.E2E_BACKEND || "postgres";
if (!["postgres", "sqlite", "mysql"].includes(BACKEND))
  throw new Error(`E2E_BACKEND: unknown ${BACKEND}; expected postgres, sqlite or mysql`);
const SMOKE_SPEC = /default-scope\.spec\.ts/;
// Playwright's per-project `testIgnore` replaces the root one rather than
// merging with it, so every project-level `testIgnore` below must include
// ALWAYS_IGNORE or showcase.spec.ts leaks back into that project's run.
const ALWAYS_IGNORE = BACKEND === "postgres" ? [SHOWCASE_IGNORE, SMOKE_SPEC] : [SHOWCASE_IGNORE];
const CHROMIUM_ONLY_IGNORE = [...ALWAYS_IGNORE, /inspection-affordances\.spec\.ts/];
const SQLITE_SEED = fileURLToPath(new URL("../../conformance/seed/seed.sqlite.sql", import.meta.url));

// This suite is a frontend UI-regression suite, not
// part of the protocol conformance kit (conformance/runner) — but it's
// useful for a port to run the same shared-frontend smoke against its own
// instance, so PLAYWRIGHT_BASE_URL lets it skip spawning `examples/demo`
// entirely and point every project at an already-running implementation.
const EXTERNAL_BASE_URL = process.env.PLAYWRIGHT_BASE_URL;

// E2E_BROWSERS (e.g. "chromium,firefox") trims the projects *and* their demo
// servers: Playwright starts every webServer entry whatever `--project` picks.
// Unset or empty means all three.
const BROWSERS = (process.env.E2E_BROWSERS || Object.keys(PORTS).join(",")).split(",");
const unknown = BROWSERS.filter((b) => !(b in PORTS));
if (unknown.length)
  throw new Error(`E2E_BROWSERS: unknown ${unknown.join(", ")}; expected ${Object.keys(PORTS).join(", ")}`);
const selected = (browser: keyof typeof PORTS) => BROWSERS.includes(browser);

// SQLite gets a fresh seeded file per server; MySQL needs a database already loaded from
// conformance/seed/seed.mysql.sql (E2E_MYSQL_URL, default MYSQL_TEST_URL).
function backendSetup(port: number): { prepare: string; features: string; env: Record<string, string> } {
  if (BACKEND === "sqlite") {
    const file = `${tmpdir()}/ashurbanipal-e2e-${port}.sqlite`;
    return {
      prepare: `rm -f "${file}" && sqlite3 "${file}" < "${SQLITE_SEED}" && `,
      features: "--features sqlite",
      env: { DB_BACKEND: "sqlite", SQLITE_PATH: `sqlite://${file}` },
    };
  }
  if (BACKEND === "mysql") {
    const url = process.env.E2E_MYSQL_URL || process.env.MYSQL_TEST_URL;
    if (!url) throw new Error("E2E_BACKEND=mysql needs E2E_MYSQL_URL or MYSQL_TEST_URL");
    return { prepare: "", features: "--features mysql", env: { DB_BACKEND: "mysql", DATABASE_URL: url } };
  }
  return { prepare: "", features: "", env: {} };
}

function demoServer(port: number) {
  const { prepare, features, env } = backendSetup(port);
  return {
    command: `${prepare}exec cargo run -p ashurbanipal-axum ${features} --example demo`,
    cwd: CRATE_ROOT,
    url: `http://localhost:${port}/health`,
    // A leftover Postgres demo on the port would silently answer for another engine.
    reuseExistingServer: !process.env.CI && BACKEND === "postgres",
    timeout: 120_000,
    env: {
      ...process.env,
      ...env,
      PORT: String(port),
      SIBLING_PORT: "",
      MOUNT_PREFIX: "",
    },
  };
}

export default defineConfig({
  testDir: "./tests",
  // Not a correctness test — a scripted walkthrough recorded to video for
  // a showcase clip. Run via `mise run frontend:showcase` (playwright.showcase.config.ts),
  // never as part of this suite.
  testIgnore: ALWAYS_IGNORE,
  testMatch: BACKEND === "postgres" ? undefined : SMOKE_SPEC,
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  // Playwright's CI default is half the cores: 2 on a 4-vCPU ubuntu-latest runner.
  workers: process.env.CI ? 4 : undefined,
  // A loaded CI runner can take longer than expect's 5 s default to answer a fetch and render it.
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  reporter: "html",
  use: {
    trace: "on-first-retry",
  },
  projects: (EXTERNAL_BASE_URL
    ? [
        { name: "chromium", use: { ...devices["Desktop Chrome"], baseURL: EXTERNAL_BASE_URL } },
        {
          name: "firefox",
          use: { ...devices["Desktop Firefox"], baseURL: EXTERNAL_BASE_URL },
          testIgnore: CHROMIUM_ONLY_IGNORE,
        },
        {
          name: "webkit",
          use: { ...devices["Desktop Safari"], baseURL: EXTERNAL_BASE_URL },
          testIgnore: CHROMIUM_ONLY_IGNORE,
        },
      ]
    : [
        {
          name: "chromium",
          use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${PORTS.chromium}` },
        },
        {
          name: "firefox",
          use: { ...devices["Desktop Firefox"], baseURL: `http://localhost:${PORTS.firefox}` },
          // Playwright's clipboard-read/clipboard-write context permissions
          // are Chromium-only — see inspection-affordances.spec.ts's test.use().
          testIgnore: CHROMIUM_ONLY_IGNORE,
        },
        {
          name: "webkit",
          use: { ...devices["Desktop Safari"], baseURL: `http://localhost:${PORTS.webkit}` },
          testIgnore: CHROMIUM_ONLY_IGNORE,
        },
      ]
  ).filter((p) => selected(p.name as keyof typeof PORTS)),
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : (Object.keys(PORTS) as (keyof typeof PORTS)[]).filter(selected).map((b) => demoServer(PORTS[b])),
});
