---
description: 'Instructions for writing TypeScript/Node.js code for the Express + node-postgres port of Ashurbanipal'
applyTo: 'implementations/node-express/**/*.ts,implementations/node-express/**/*.js,implementations/node-express/package.json'
---

# Node/Express Port Instructions

`implementations/node-express/` is the Node.js/TypeScript port of Ashurbanipal,
targeting Express and [`pg`](https://node-postgres.com/) — it implements the
same `spec/protocol.md` + `spec/openapi.yaml` contract as the Rust reference
and the Go/Spring Boot ports (see `PORTING.md`). Treat the Rust implementation
(`implementations/rust/src/`) as the reference to port against when a design
choice isn't already settled here; cross-check `implementations/go-nethttp/`
for a second opinion when in doubt.

## Layout (don't restructure without reason)

- `src/config.ts` — `Config`/`Limits`/`Sibling` types and the fail-closed kill
  switch (`isEnabled`, `validateConfig`, `withDefaults`).
- `src/catalog.ts` — the one seam to `pg.Pool`; route handlers never import
  `pg` directly.
- `src/filter.ts` — filter AST structural validation and WHERE-clause
  building, ported against `implementations/rust/src/filter.rs`.
- `src/siblings.ts` — health fan-out via `Promise.all` + `AbortController`.
- `src/routes.ts` — `createRouter(config, pool)` and the six HTTP handlers.
- `src/embed.ts` — the vendored `frontend/dbviewer.html`, sha256-reverified
  on every process start.
- `demo/main.ts` — the runnable example host (`npm run demo`).

## Architecture invariants (mirror the Rust crate's)

- **`Catalog` is the only seam to the database.** Never call `pool.query`
  directly from `routes.ts`; add methods to `Catalog` instead.
- **Kill switch is fail-closed, checked once at router construction.**
  `createRouter` throws `ProductionEnabledError` for a production-like
  `enabledFor` value at construction time, not per-request. An
  empty/undefined `Config` (`enabledFor` undefined) must be disabled by
  construction — never default it to enabled. When disabled, return a
  router that 404s every request under `basePath`, indistinguishable from
  the viewer never having been mounted.
- **No unvalidated identifier ever reaches SQL text.** Table/column names
  are only spliced into a query after being matched against a live
  `information_schema` lookup; everything else is a bound (`$1`, `$2`, ...)
  parameter. Filter DSL columns follow the same rule — never trust a
  parsed column name from `filter.ts` directly.
- **The six routes only ever accept GET/HEAD.** Use the `registerGet`
  pattern (route registered with `router.all`, explicit method check
  returning 405 with an `Allow` header) rather than `router.get`, so a
  wrong-verb hit on a real path returns 405, not a generic 404.
- **`PROTOCOL_VERSION` must track the Rust reference's constant** and every
  other port's own copy (`spec/protocol.md` §7) — bump only for
  non-additive wire changes, and update it everywhere at once.
- **Frontend vendoring is re-verified at runtime, not just at copy time.**
  `src/embed.ts` re-hashes `dbviewer.html` on every process start so a
  build step that mangles the file fails loudly instead of silently
  serving corrupt HTML.

## TypeScript/Node conventions

- Use ESM (`"type": "module"` in `package.json`); import local files with
  explicit `.js` extensions (TypeScript's NodeNext resolution requirement),
  even though the source files are `.ts`.
- Prefer `type`-only imports (`import type { Foo } from "./x.js"`) for
  types-only usage — keeps emitted JS import lists accurate.
- Strict mode is on (`tsconfig.json`); don't add `any` to work around a
  type error — narrow or model the type properly instead.
- Use `async`/`await` over raw Promise chains; propagate errors via
  `Result`-like discriminated unions or thrown custom errors
  (`src/errors.ts`) rather than sentinel return values.
- Run `npm run typecheck` and `npm test` (vitest) before considering a
  change done; `npm run build` also copies `frontend/dbviewer.html` into
  `dist/frontend/` — don't hand-edit `dist/`.
- Comments follow the same discipline as the Rust crate (see `CLAUDE.md`):
  a comment earns its place only by stating a non-obvious *why* — a
  protocol/security invariant, an Express/Node quirk, a bug it guards
  against — never a *what* the name already says, and never a
  citation-heavy restatement of a design doc.
