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
//
// DB_BACKEND selects which DbSource to construct — postgres (default),
// sqlite, or mysql/mariadb — always an explicit choice, never inferred
// from which env vars happen to be set (spec/protocol.md's "explicit, not
// implicit" principle, per PORTING.md's hardening checklist).
import express from "express";
import { createPool as createMysqlPool } from "mysql2/promise";
import { Pool } from "pg";
// Default import + property access, not `import { Database } from "sqlite3"`:
// sqlite3 is CommonJS, and Node's native ESM loader's static export
// detection (cjs-module-lexer) doesn't always see its named exports —
// confirmed at runtime (`tsx demo/main.ts` threw "does not provide an
// export named 'Database'" with the named-import form even though it
// type-checks fine, since TS's own module resolution is more lenient
// than Node's actual runtime interop).
import sqlite3 from "sqlite3";
import { MySqlSource } from "../src/db/mysql.js";
import { PostgresSource } from "../src/db/postgres.js";
import { SqliteSource } from "../src/db/sqlite.js";
import type { DbSource } from "../src/db/types.js";
import { type Config, createRouter } from "../src/index.js";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set for DB_BACKEND=${process.env.DB_BACKEND}`);
  }
  return value;
}

function buildDbSource(backend: string): DbSource {
  switch (backend) {
    case "postgres":
      return new PostgresSource(new Pool({ connectionString: requireEnv("DATABASE_URL"), max: 5 }));
    case "sqlite":
      return new SqliteSource(new sqlite3.Database(requireEnv("SQLITE_PATH")));
    case "mysql":
      return new MySqlSource(createMysqlPool(requireEnv("MYSQL_URL")));
    default:
      throw new Error(`unknown DB_BACKEND "${backend}" (expected "postgres", "sqlite", or "mysql")`);
  }
}

async function main(): Promise<void> {
  const backend = process.env.DB_BACKEND ?? "postgres";
  const dbSource = buildDbSource(backend);
  const port = envInt("PORT", 4000);

  const config: Config = { enabled: true };
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

  const viewer = createRouter(config, [{ name: backend, source: dbSource }]);

  const app = express();
  app.get("/health", (_req, res) => res.send("ok"));
  app.get("/", (_req, res) => res.redirect(307, "/__ashurbanipal"));
  app.use(viewer);

  app.listen(port, "0.0.0.0", () => {
    console.log(
      `demo host (backend=${backend}) on http://localhost:${port} — browser at http://localhost:${port}/__ashurbanipal`,
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
