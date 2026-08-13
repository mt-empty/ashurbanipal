import { defineConfig, devices } from "@playwright/test";

// The app is read-only by architecture invariant, so there's no cross-test
// mutation to isolate against — one `demo` server per *browser project* is
// enough (not per test/worker). Each project's tests all share their one
// instance; three projects means three instances so a full three-browser
// run doesn't triple the request load on a single server. `siblings.spec.ts`
// is the one exception and spawns its own second instance directly on top
// of whichever per-project server it's already using (see
// tests/support/second-server.ts).
const CRATE_ROOT = "../../implementations/rust/axum";
const PORTS = { chromium: 4310, firefox: 4311, webkit: 4312 };
// Playwright's per-project `testIgnore` replaces the root one rather than
// merging with it, so every project-level `testIgnore` below must include
// this or showcase.spec.ts leaks back into that project's run.
const SHOWCASE_IGNORE = /showcase\.spec\.ts/;
const CHROMIUM_ONLY_IGNORE = [SHOWCASE_IGNORE, /inspection-affordances\.spec\.ts/];

// This suite is a frontend UI-regression suite (implementation.md §2.3), not
// part of the protocol conformance kit (conformance/runner) — but it's
// useful for a port to run the same shared-frontend smoke against its own
// instance, so PLAYWRIGHT_BASE_URL lets it skip spawning `examples/demo`
// entirely and point every project at an already-running implementation.
const EXTERNAL_BASE_URL = process.env.PLAYWRIGHT_BASE_URL;

function demoServer(port: number) {
  return {
    command: "cargo run -p ashurbanipal-axum --example demo",
    cwd: CRATE_ROOT,
    url: `http://localhost:${port}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
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
  testIgnore: SHOWCASE_IGNORE,
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  use: {
    trace: "on-first-retry",
  },
  projects: EXTERNAL_BASE_URL
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
      ],
  webServer: EXTERNAL_BASE_URL ? undefined : Object.values(PORTS).map(demoServer),
});
