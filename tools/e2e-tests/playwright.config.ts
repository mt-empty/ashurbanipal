import { defineConfig, devices } from "@playwright/test";

// The app is read-only by architecture invariant, so there's no cross-test
// mutation to isolate against — one `demo` server per *browser project* is
// enough (not per test/worker). Each project's tests all share their one
// instance; three projects means three instances so a full three-browser
// run doesn't triple the request load on a single server. `siblings.spec.ts`
// is the one exception and spawns its own second instance directly on top
// of whichever per-project server it's already using (see
// tests/support/second-server.ts).
const REPO_ROOT = "../..";
const PORTS = { chromium: 4310, firefox: 4311, webkit: 4312 };
// Playwright's per-project `testIgnore` replaces the root one rather than
// merging with it, so every project-level `testIgnore` below must include
// this or showcase.spec.ts leaks back into that project's run.
const SHOWCASE_IGNORE = /showcase\.spec\.ts/;

function demoServer(port: number) {
  return {
    command: "cargo run --example demo",
    cwd: REPO_ROOT,
    url: `http://localhost:${port}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      PORT: String(port),
      SIBLING_PORT: "",
    },
  };
}

export default defineConfig({
  testDir: "./tests",
  // Not a correctness test — a scripted walkthrough recorded to video for
  // a showcase clip. Run via `mise run showcase` (playwright.showcase.config.ts),
  // never as part of this suite.
  testIgnore: SHOWCASE_IGNORE,
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  use: {
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${PORTS.chromium}` },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"], baseURL: `http://localhost:${PORTS.firefox}` },
      // Playwright's clipboard-read/clipboard-write context permissions are
      // Chromium-only — see inspection-affordances.spec.ts's test.use().
      testIgnore: [SHOWCASE_IGNORE, /inspection-affordances\.spec\.ts/],
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], baseURL: `http://localhost:${PORTS.webkit}` },
      testIgnore: [SHOWCASE_IGNORE, /inspection-affordances\.spec\.ts/],
    },
  ],
  webServer: Object.values(PORTS).map(demoServer),
});
