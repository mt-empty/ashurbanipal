# ashurbanipal (node-express)

A Node.js/TypeScript port of [Ashurbanipal](../../readme.md), targeting
Express — implements the same `spec/protocol.md` + `spec/openapi.yaml`
contract as the Rust reference and the Go/Spring Boot ports.

```sh
npm install ashurbanipal-node-express pg
```

`pg`/`sqlite3`/`mysql2` are optional peer dependencies — install whichever
driver(s) your `DbSource` backend needs (see "Database support" below).
Most hosts only need one backend — if that's not Postgres, skip installing
`pg`.

## Usage

```ts
import express from "express";
import { Pool } from "pg";
import { createRouter, PostgresSource } from "ashurbanipal-node-express";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const viewer = createRouter({ enabled: true }, new PostgresSource(pool));

const app = express();
app.use(viewer); // paths already include the mount (default /__ashurbanipal)
app.listen(3000);
```

An empty/undefined `Config` is disabled by construction: `enabled` is
undefined, which means disabled. Ashurbanipal has zero opinion on what
environment it's running in — that decision is entirely the host's. A
host that forgets to configure anything gets a 404'd viewer, never one
silently enabled with defaults.

The optional fields, shown here at their defaults/example values:

```ts
const viewer = createRouter(
  {
    enabled: true,
    basePath: "/__ashurbanipal", // undefined also means this
    limits: { defaultPageSize: 50, maxPageSize: 100, queryTimeoutSecs: 5 },
    siblings: [
      { name: "billing", dbviewerUrl: "https://billing.internal.vpn/__ashurbanipal", healthPath: "/health" },
    ],
  },
  new PostgresSource(pool),
);
```

Express's `app.get()` alone leaves every other HTTP verb on a registered
path unmatched (a generic 404, indistinguishable from a nonexistent
path), so `createRouter` registers each of the six routes with an
explicit method check instead, returning 405 + `Allow: GET, HEAD` for any
other verb — same behavior the other ports' underlying routers give for
free by matching path before method.

## Database support

Postgres by default (`PostgresSource`, the package's main barrel export).
MySQL/MariaDB and SQLite are supported with the same known degraded
features as the Rust reference (see `docs/adapter-decisions.md`) —
deliberately *not* re-exported from the main entry point, so a
Postgres-only consumer's module graph never loads `sqlite3`/`mysql2`:

```ts
import { createRouter } from "ashurbanipal-node-express";
import { SqliteSource } from "ashurbanipal-node-express/dist/src/db/sqlite.js";
import { MySqlSource } from "ashurbanipal-node-express/dist/src/db/mysql.js";
import { Database } from "sqlite3";
import { createPool } from "mysql2/promise";

const sqliteViewer = createRouter(config, new SqliteSource(new Database("app.db")));
const mysqlViewer = createRouter(config, new MySqlSource(createPool(process.env.MYSQL_URL!)));
```

`demo/main.ts` demonstrates all three via a `DB_BACKEND=postgres|sqlite|mysql`
env var — `pnpm install && pnpm run demo`.

Full API/config reference:
[docs/design.md](https://github.com/mt-empty/ashurbanipal/blob/main/docs/design.md).
