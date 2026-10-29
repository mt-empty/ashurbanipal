import { defineConfig, devices } from "@playwright/test";
import { perfCertificateSpki } from "./perf/tls";

// The start-up timing experiment (perf/README.md), not a test suite: one
// Chromium worker so runs never compete, against a release build so the
// numbers aren't a debug build's.
const CRATE_ROOT = "../../implementations/rust/axum";
export const PERF_DEMO_PORT = 4330;

export default defineConfig({
  testDir: "./perf",
  testMatch: /\.perf\.ts$/,
  outputDir: "./perf-results/playwright",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    // HTTPS by default (perf/README.md): trust the proxy's own certificate the way a
    // company's users trust its CA, rather than ignoring certificate errors.
    launchOptions:
      process.env.PERF_HTTP1 === "1"
        ? {}
        : { args: [`--ignore-certificate-errors-spki-list=${perfCertificateSpki()}`] },
  },
  webServer: {
    command: "exec cargo run --release -p ashurbanipal-axum --example demo",
    cwd: CRATE_ROOT,
    url: `http://localhost:${PERF_DEMO_PORT}/health`,
    // A debug demo already on the port would skew every number.
    reuseExistingServer: false,
    timeout: 600_000,
    env: { ...process.env, PORT: String(PERF_DEMO_PORT), SIBLING_PORT: "", MOUNT_PREFIX: "" },
  },
});
