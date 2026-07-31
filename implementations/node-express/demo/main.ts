// The living usage example and conformance harness for the node-express
// port — the host service embedding Ashurbanipal, mirroring
// implementations/rust/examples/demo.rs and the Go port's cmd/demo/main.go.
//
// Run against the devcontainer's seeded Postgres:
//
//   npm run demo
//   # then open http://localhost:4000/__ashurbanipal
//
// To demo sibling health-polling, run a second instance:
//
//   PORT=4001 SIBLING_PORT=4000 npm run demo
import express from "express";
import { Pool } from "pg";
import { createRouter, type Config } from "../src/index.js";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set (the devcontainer sets it automatically)");
  }
  const port = envInt("PORT", 4000);

  const pool = new Pool({ connectionString: databaseUrl, max: 5 });

  const config: Config = { environment: "dev", enabledFor: ["dev"] };
  const siblingPort = process.env.SIBLING_PORT;
  if (siblingPort) {
    config.siblings = [
      {
        name: `demo-${siblingPort}`,
        dbviewerUrl: `http://localhost:${siblingPort}/__ashurbanipal`,
        healthPath: "/health",
      },
    ];
  }

  // createRouter throws for a production-like enabledFor value
  // (spec/protocol.md §4) — the fail-closed guarantee is only real if a
  // host's own startup actually observes and acts on it, so this demo
  // does exactly what a real host must: let it propagate and refuse to
  // start, rather than silently swallowing it.
  const viewer = createRouter(config, pool);

  const app = express();
  app.get("/health", (_req, res) => res.send("ok"));
  app.get("/", (_req, res) => res.redirect(307, "/__ashurbanipal"));
  app.use(viewer);

  app.listen(port, "0.0.0.0", () => {
    console.log(
      `demo host on http://localhost:${port} — browser at http://localhost:${port}/__ashurbanipal`,
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
