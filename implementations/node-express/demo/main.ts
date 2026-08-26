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
//
// CONFORMANCE_SECOND_SOURCE=1 (postgres backend only) registers a second
// source, pinned to `other_schema`, for conformance/runner/two_source.rs
// — see that file's module doc.
import express from "express";
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

// Turns a missing-module or failed-to-load driver into an actionable error
// instead of a raw stack trace (same idea as Knex's per-dialect require()
// wrapping) — covers both "never installed" and "installed but broken",
// e.g. a native addon whose prebuilt binary doesn't match the host's glibc.
async function loadDriver<T>(pkg: string, importer: () => Promise<T>): Promise<T> {
  try {
    return await importer();
  } catch (cause) {
    throw new Error(
      `DB_BACKEND driver "${pkg}" isn't usable — run \`pnpm add ${pkg}\`, or if it's already installed, check it's compatible with this environment (native-addon ABI, glibc version, etc.)`,
      { cause },
    );
  }
}

// Each driver is imported only inside its own case, not at module scope:
// all three are optional peerDependencies, and pg/mysql2/sqlite3 loading
// unconditionally at startup means every backend pays for all three —
// harmlessly for the pure-JS pg/mysql2, but sqlite3 ships a native addon
// that dlopen()s on import, so an environment where its prebuilt binary
// doesn't match the system's glibc breaks postgres/mysql demo runs too.
async function buildDbSource(backend: string): Promise<DbSource> {
  switch (backend) {
    case "postgres": {
      const { Pool } = await loadDriver("pg", () => import("pg"));
      return new PostgresSource(new Pool({ connectionString: requireEnv("DATABASE_URL"), max: 5 }));
    }
    case "sqlite": {
      // Default import + property access, not `import { Database } from "sqlite3"`:
      // sqlite3 is CommonJS, and Node's native ESM loader's static export
      // detection (cjs-module-lexer) doesn't always see its named exports —
      // confirmed at runtime (`tsx demo/main.ts` threw "does not provide an
      // export named 'Database'" with the named-import form even though it
      // type-checks fine, since TS's own module resolution is more lenient
      // than Node's actual runtime interop).
      const { default: sqlite3 } = await loadDriver("sqlite3", () => import("sqlite3"));
      return new SqliteSource(new sqlite3.Database(requireEnv("SQLITE_PATH")));
    }
    case "mysql": {
      const { createPool } = await loadDriver("mysql2", () => import("mysql2/promise"));
      return new MySqlSource(createPool(requireEnv("MYSQL_URL")));
    }
    default:
      throw new Error(`unknown DB_BACKEND "${backend}" (expected "postgres", "sqlite", or "mysql")`);
  }
}

async function main(): Promise<void> {
  const backend = process.env.DB_BACKEND ?? "postgres";
  const dbSource = await buildDbSource(backend);
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

  const sources = [{ name: backend, source: dbSource }];
  if (process.env.CONFORMANCE_SECOND_SOURCE && backend === "postgres") {
    const { Pool } = await loadDriver("pg", () => import("pg"));
    // onConnect is awaited before a connection is handed out — unlike the
    // 'connect' event (fire-and-forget), which could race a query against
    // this SET on the same physical connection.
    const pinnedPool = new Pool({
      connectionString: requireEnv("DATABASE_URL"),
      max: 5,
      onConnect: (client) => client.query("SET search_path = other_schema"),
    });
    sources.push({ name: "other_schema", source: new PostgresSource(pinnedPool) });
  }

  const viewer = createRouter(config, sources);

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
