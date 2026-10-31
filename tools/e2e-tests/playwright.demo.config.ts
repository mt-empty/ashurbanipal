import { defineConfig, devices } from "@playwright/test";

// The GitHub Pages demos (docs/demo/ and the uncommitted docs/demo/live/),
// not dbviewer.html against a port: `mise run frontend:test-demo` builds both first.
const PORT = 4003;

export default defineConfig({
  testDir: "./demo",
  testMatch: /\.demo\.ts$/,
  outputDir: "./test-results/demo",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: "line",
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  use: { baseURL: `http://localhost:${PORT}`, trace: "on-first-retry" },
  projects: [
    { name: "chromium", use: devices["Desktop Chrome"] },
    { name: "firefox", use: devices["Desktop Firefox"] },
    { name: "webkit", use: devices["Desktop Safari"] },
  ],
  webServer: {
    command: "node ../../frontend/demo-preview.mjs",
    url: `http://localhost:${PORT}/demo/`,
    reuseExistingServer: !process.env.CI,
    env: { ...process.env, PORT: String(PORT) },
  },
});
