import { defineConfig, devices } from "@playwright/test";

// One-off config for recording the showcase.spec.ts walkthrough to video.
// Separate from playwright.config.ts so the main suite's video setting
// (none — see git history around 157fc12 on screenshot-diff flakiness)
// isn't touched just to support this.
const CRATE_ROOT = "../../implementations/rust/axum";
const PORT = 4320;
const SECOND_PORT = 4321;

// A labelled dev/int pair so Other services shows a switchable environment.
function demoServer(port: number, env: Record<string, string>) {
  return {
    command: "cargo run -p ashurbanipal-axum --example demo",
    cwd: CRATE_ROOT,
    url: `http://localhost:${port}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { ...process.env, PORT: String(port), SIBLINGS_UP: "1", ...env },
  };
}

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
  webServer: [
    demoServer(PORT, { INSTANCE_LABEL: "dev", SIBLING_PORT: String(SECOND_PORT), SIBLING_LABEL: "int" }),
    demoServer(SECOND_PORT, { INSTANCE_LABEL: "int", SIBLING_PORT: String(PORT), SIBLING_LABEL: "dev" }),
  ],
});
