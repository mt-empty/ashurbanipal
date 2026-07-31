# ashurbanipal (node-express)

A Node.js/TypeScript port of [Ashurbanipal](../../readme.md), targeting
Express and [`pg`](https://node-postgres.com/) (node-postgres) — implements
the same `spec/protocol.md` + `spec/openapi.yaml` contract as the Rust
reference and the Go/Spring Boot ports. Postgres only, per
`docs/adapter-decisions.md`'s stretch-goal framing for other engines.

```ts
import express from "express";
import { Pool } from "pg";
import { createRouter } from "ashurbanipal-node-express"; // or a relative import to src/index.ts

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// createRouter throws ProductionEnabledError for a production-like
// enabledFor value (spec/protocol.md §4) — fail-closed, at construction.
const viewer = createRouter({ environment: "dev", enabledFor: ["dev"] }, pool);

const app = express();
app.use(viewer); // paths already include the mount (default /__ashurbanipal)
app.listen(3000);
```

An empty/undefined `Config` is disabled by construction: `enabledFor` is
undefined, so no environment ever matches. A host that forgets to
configure anything gets a 404'd viewer, never one silently enabled with
defaults.

## Layout

- `src/config.ts` — `Config`/`Limits`/`Sibling`, the fail-closed kill switch.
- `src/catalog.ts` — the one seam to `pg.Pool`; ported against
  `implementations/rust/src/db.rs`'s catalog SQL (also cross-checked
  against `implementations/go-nethttp/catalog.go`).
- `src/filter.ts` — the filter AST's structural validation and
  WHERE-clause builder, ported against `implementations/rust/src/filter.rs`.
- `src/siblings.ts` — health fan-out via `Promise.all` + `AbortController`.
- `src/routes.ts` — `createRouter(config, pool)` and the six HTTP handlers.
- `src/embed.ts` — the vendored `frontend/dbviewer.html`, sha256-reverified
  on every process start (see `PORTING.md`'s vendoring contract).
- `demo/main.ts` — the runnable example host, `npm run demo`.

## Vendoring

`frontend/dbviewer.html` is copied from this repository's own working-tree
copy (sha256 `57c0a2aa5487e66533950e170c63d4c1bf57609f557a8b47b213823f208a0991`),
since no tagged `frontend/dbviewer.html` release currently exists to vendor
from — same caveat the Go and Spring Boot ports document. `src/embed.ts`
re-verifies the hash on every process start (module load), not just once
at vendoring time, so a build step that mangles the file fails loudly.

## Tests

```sh
npm install
npm test              # fixture + kill-switch tests, no database needed
npm run typecheck
```

`test/filter-fixture.test.ts` consumes
`spec/fixtures/filter-builder-tests.json` directly from the repo root.
`test/killswitch.test.ts` covers the two kill-switch properties conformance
can't observe over HTTP (spec/protocol.md §4): the no-config-means-disabled
case, and production-alias rejection at construction.

## Running the demo

```sh
npm install
npm run demo   # DATABASE_URL must point at a seeded Postgres instance
# then open http://localhost:4000/__ashurbanipal
```

To demo sibling health-polling, run a second instance:

```sh
PORT=4001 SIBLING_PORT=4000 npm run demo
```

## Conformance

```sh
npm run demo &
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
