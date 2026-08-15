# ashurbanipal (node-express)

A Node.js/TypeScript port of [Ashurbanipal](../../readme.md), targeting
Express — implements the same `spec/protocol.md` + `spec/openapi.yaml`
contract as the Rust reference and the Go/Spring Boot ports.

```sh
npm install ashurbanipal-node-express
```

```ts
import express from "express";
import { Pool } from "pg";
import { createRouter, PostgresSource } from "ashurbanipal-node-express"; // or a relative import to src/index.ts

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// createRouter throws ProductionEnabledError for a production-like
// enabledFor value (spec/protocol.md §4) — fail-closed, at construction.
const viewer = createRouter({ environment: "dev", enabledFor: ["dev"] }, new PostgresSource(pool));

const app = express();
app.use(viewer); // paths already include the mount (default /__ashurbanipal)
app.listen(3000);
```

An empty/undefined `Config` is disabled by construction: `enabledFor` is
undefined, so no environment ever matches. A host that forgets to
configure anything gets a 404'd viewer, never one silently enabled with
defaults.

## Database support

| Backend | Type | Status |
|---|---|---|
| Postgres (`PostgresSource`) | default, always available from the package's main barrel (`ashurbanipal-node-express`) | Conformant — the reference implementation `spec/protocol.md` is written against; covered by the full conformance suite (below) plus a live-Postgres integration suite (`test/schema.integration.test.ts`). |
| MySQL/MariaDB (`MySqlSource`, [`mysql2`](https://github.com/sidorares/node-mysql2)) | opt-in — import directly from `ashurbanipal-node-express/dist/db/mysql.js` (not re-exported from the main barrel; see "Backend selection" below) | Reviewed and supported, with the same known degraded features as the Rust reference — `common_values` has no reliable cross-version statistics equivalent and is always empty; table counts and comments come from `information_schema`. Detects MySQL vs. MariaDB at runtime (`SELECT VERSION()`, cached) since the two forks need different query-timeout SQL — see `docs/adapter-decisions.md` §6. Not run through `conformance/runner` (that suite targets Postgres); has its own unit test suite instead (`test/db/mysql.test.ts`), requiring live instances via `MYSQL_TEST_URL`/`MARIADB_TEST_URL`. |
| SQLite (`SqliteSource`, [`sqlite3`](https://github.com/TryGhost/node-sqlite3)) | opt-in — import directly from `ashurbanipal-node-express/dist/db/sqlite.js` | Reviewed and supported, with the same known degraded features as the Rust reference — comments and `common_values` have no SQLite equivalent and degrade to omitted/empty; table counts are always the "no estimate" sentinel. Uses `sqlite3` (mapbox/node-sqlite3), not the built-in `node:sqlite` or `better-sqlite3` — both of those execute fully synchronously with no query-cancellation hook, confirmed empirically (see `docs/adapter-decisions.md` §6). Not run through `conformance/runner`; has its own unit test suite instead (`test/db/sqlite.test.ts`), no external infrastructure needed. |

### Backend selection

Explicit by construction, never driver auto-detection: the host imports
whichever `DbSource` implementation it wants and passes an instance to
`createRouter`. `SqliteSource`/`MySqlSource` are deliberately not
re-exported from the package's main entry point, so a Postgres-only
consumer's module graph never loads `sqlite3`/`mysql2` — the closest
Node/npm analog to the Rust reference's Cargo feature gating, which has
no direct npm equivalent.

```ts
import { createRouter } from "ashurbanipal-node-express";
import { SqliteSource } from "ashurbanipal-node-express/dist/db/sqlite.js";
import { MySqlSource } from "ashurbanipal-node-express/dist/db/mysql.js";
import { Database } from "sqlite3";
import { createPool } from "mysql2/promise";

const sqliteViewer = createRouter(config, new SqliteSource(new Database("app.db")));
const mysqlViewer = createRouter(config, new MySqlSource(createPool(process.env.MYSQL_URL!)));
```

`demo/main.ts` demonstrates all three via a `DB_BACKEND=postgres|sqlite|mysql`
env var (see "Running the demo" below).

## Layout

- `src/config.ts` — `Config`/`Limits`/`Sibling`, the fail-closed kill switch.
- `src/db/types.ts` — the `DbSource` seam (interface + shared wire types)
  route handlers depend on; mirrors `implementations/rust/core/src/db/mod.rs`'s
  `DbSource` trait.
- `src/db/postgres.ts` — `PostgresSource`, the default backend; ported
  against `implementations/rust/core/src/db/postgres.rs`'s catalog SQL (also
  cross-checked against `implementations/go-nethttp/postgres.go`).
- `src/db/sqlite.ts` — `SqliteSource`, opt-in; ported against
  `implementations/rust/core/src/db/sqlite.rs`.
- `src/db/mysql.ts` — `MySqlSource`, opt-in; ported against
  `implementations/rust/core/src/db/mysql.rs`, including the MySQL-vs-MariaDB
  runtime variant detection for the query-timeout mechanism.
- `src/filter.ts` — the filter AST's structural validation and
  Postgres-dialect WHERE-clause builder, ported against
  `implementations/rust/core/src/filter.rs`; `db/sqlite.ts`/`db/mysql.ts` each
  carry their own dialect-specific WHERE-clause builder (placeholder
  style, cast syntax, `ILIKE` mapping all differ per backend).
- `src/siblings.ts` — health fan-out via `Promise.all` + `AbortController`.
- `src/routes.ts` — `createRouter(config, dbSource)` and the six HTTP handlers.
- `src/embed.ts` — the vendored `frontend/dbviewer.html`, sha256-reverified
  on every process start (see `PORTING.md`'s vendoring contract).
- `demo/main.ts` — the runnable example host, `pnpm run demo`.

## Vendoring

`frontend/dbviewer.html` is copied from this repository's own working-tree
copy (sha256 `3fc87a2ede9b10f546981015451f820d36e27208e4bbf14e645de9db6592d93b`),
since no tagged `frontend/dbviewer.html` release currently exists to vendor
from — same caveat the Go and Spring Boot ports document. `src/embed.ts`
re-verifies the hash on every process start (module load), not just once
at vendoring time, so a build step that mangles the file fails loudly.

## Tests

```sh
pnpm install
pnpm test              # fixture + kill-switch + db/sqlite tests always run; db/mysql and the
                        # live-Postgres integration suite skip cleanly without their env vars
pnpm run typecheck
pnpm run lint           # biome check .; pnpm run lint:fix applies safe fixes
```

`test/filter-fixture.test.ts` consumes
`spec/fixtures/filter-builder-tests.json` directly from the repo root.
`test/killswitch.test.ts` covers the two kill-switch properties conformance
can't observe over HTTP (spec/protocol.md §4): the no-config-means-disabled
case, and production-alias rejection at construction.
`test/schema.integration.test.ts` needs `DATABASE_URL`;
`test/db/mysql.test.ts` needs `MYSQL_TEST_URL`/`MARIADB_TEST_URL` (each
variant's describe block skips independently if its own var is absent).
`test/db/sqlite.test.ts` needs no external infrastructure (in-memory db).

`sqlite3`'s prebuilt native binary is built against a newer glibc baseline
than some Linux hosts ship (observed on this devcontainer's Debian
bookworm image: `GLIBC_2.38' not found`) — if `pnpm install` reports that
error at require-time, `pnpm rebuild sqlite3` forces a from-source build
via `node-gyp` (needs `python3`, `make`, `g++`) against the host's actual
glibc.

## Running the demo

```sh
pnpm install
pnpm run demo   # DB_BACKEND=postgres (default); DATABASE_URL must point at a seeded Postgres instance
# then open http://localhost:4000/__ashurbanipal
```

To run against SQLite or MySQL/MariaDB instead:

```sh
DB_BACKEND=sqlite SQLITE_PATH=./app.db pnpm run demo
DB_BACKEND=mysql MYSQL_URL="mysql://user:pass@host:3306/db" pnpm run demo
```

To demo sibling health-polling, run a second instance:

```sh
PORT=4001 SIBLING_PORT=4000 pnpm run demo
```

## Conformance

```sh
pnpm run demo &
ASHURBANIPAL_CONFORMANCE_URL=http://localhost:4000/__ashurbanipal bash ../../conformance/runner/report.sh
ASHURBANIPAL_CONFORMANCE_URL=http://localhost:4000/__ashurbanipal bash ../../conformance/runner/schema-check.sh
```

Both layers pass: 40/40 behavior-conformance requirements and a clean
schemathesis run (346/346 generated cases) against `spec/openapi.yaml`.

## Method handling

Express's `app.get()` alone leaves every other HTTP verb on a registered
path unmatched, falling through to a generic 404 — indistinguishable from
a nonexistent path. `src/routes.ts`'s `registerGet` wraps each of the six
routes in `router.all()` with an explicit method check instead, returning
405 + `Allow: GET, HEAD` for any other verb — this is what schemathesis's
`unsupported_methods`/RFC 9110 check expects, and what the Rust/Go ports'
underlying routers already give for free by matching path before method.

## CSP note

Per `PORTING.md`, this port takes the same option the Rust reference, Go,
and Spring Boot ports take: it sets no `Content-Security-Policy` header and
injects no nonce. A host running under a strict CSP forbidding inline
scripts must extend it for the mount path before the UI's inline
`<script type="module">` will execute client-side.

## Query timeout mechanism

Every query (catalog and data alike, spec/protocol.md §6) runs inside its
own short transaction with `SET LOCAL statement_timeout = <ms>` — `pg`'s
connection pool reuses sessions across requests, and `SET LOCAL` is
transaction-scoped, so this is the only way to bound one query's timeout
without leaking a changed `statement_timeout` onto whichever request
borrows the connection next.
