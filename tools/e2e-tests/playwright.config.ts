import { defineConfig, devices } from "@playwright/test";

// Design: docs/superpowers/specs/2026-07-19-playwright-e2e-testing-design.md
//
// One shared `demo` server for the whole run (§3): the app is read-only by
// architecture invariant, so there's no cross-test mutation to isolate
// against — a single instance avoids ~50 pointless process spawns.
// `siblings.spec.ts` is the one exception and spawns its own second
// instance directly (see tests/support/second-server.ts).
const PORT = 4310;
const BASE_URL = `http://localhost:${PORT}`;
const REPO_ROOT = "../..";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "cargo run --example demo",
    cwd: REPO_ROOT,
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      PORT: String(PORT),
      SIBLING_PORT: "",
    },
  },
});
