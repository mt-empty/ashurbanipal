import { defineConfig, devices } from "@playwright/test";

// One-off config for recording the showcase.spec.ts walkthrough to video.
// Separate from playwright.config.ts so the main suite's video setting
// (none — see git history around 157fc12 on screenshot-diff flakiness)
// isn't touched just to support this.
const CRATE_ROOT = "../../implementations/rust";
const PORT = 4320;

export default defineConfig({
  testDir: "./tests",
  testMatch: /showcase\.spec\.ts/,
  outputDir: "./showcase-results",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    video: { mode: "on", size: { width: 1280, height: 720 } },
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "cargo run --example demo",
    cwd: CRATE_ROOT,
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { ...process.env, PORT: String(PORT), SIBLING_PORT: "" },
  },
});
