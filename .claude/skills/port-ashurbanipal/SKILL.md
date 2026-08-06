---
name: port-ashurbanipal
description: Scaffold a new-language port of Ashurbanipal (a protocol.md-conformant Postgres-browsing web UI backend). Invoke as /port-ashurbanipal <language/framework>, e.g. "Elixir/Phoenix" or "Node/Express". If no argument is given, ask which language/framework before proceeding — this is multi-hour scaffolding work, not something to guess.
---

Port `spec/protocol.md` to the target language/framework given as the
argument. If no argument was given, ask the user which language/framework
before doing anything else — do not guess.

This skill operationalizes `PORTING.md`, which is the source of truth.
Read it in full before starting; this file is a checklist, not a
replacement.

## 0. Orient (read, don't skim)

- `PORTING.md` — what a port is, what's reused vs. implemented, vendoring,
  conformance, listing bar, governance. Read in full.
- `spec/protocol.md` — normative HTTP contract. Read in full, especially
  §5 (routes) and §6 (server invariants).
- `spec/filter-dsl.md` — filter grammar. Frontend-only parser; you only
  need §5.4.2's JSON AST shape from `protocol.md`, not this grammar.
- `docs/adapter-decisions.md` — per-backend mechanism registry for the
  clauses already relaxed away from Postgres-only wording (row counts,
  common-values, text casting, ILIKE mapping, schema scoping).
- Skim (don't exhaustively read) one or two existing implementations as
  worked examples of file layout and the `DbSource`-equivalent seam:
  `implementations/rust/src/db/postgres.rs` (the trait + reference impl),
  `implementations/go-nethttp/` (`catalog.go`, `filter.go`, `routes.go`,
  `embed.go`), `implementations/spring-boot-starter/src`. Note how each
  embeds `frontend/dbviewer.html` and wires its conformance CI
  (`.github/workflows/go-conformance.yml` or
  `spring-boot-conformance.yml`), since yours will copy that pattern.
- `conformance/` — `conformance/seed/seed.sql`, `conformance/runner`,
  `conformance/runner/schema-check.sh`. This is what you'll run at the
  end; know the invocation now (`PORTING.md` "How to run conformance
  locally" has the exact commands).

## 1. Confirm target and stack

State back to the user, or decide directly if unambiguous:
- Target language/framework (from the argument).
- Idiomatic web framework for that language (e.g. Phoenix for Elixir,
  Express for Node) — pick the ecosystem-standard choice, not something
  exotic.
- Postgres driver for that language. **Postgres first** — a SQLite/other
  non-Postgres backend is a stretch goal, not the default target, even
  though the Rust port's `SqliteSource` is reviewed and supported (see
  `docs/adapter-decisions.md`). Don't build a multi-backend abstraction
  unless asked.

## 2. Scaffold layout

Mirror the shape of the existing ports, not their exact file names:
`implementations/<lang>-<framework>/` at the repo root, containing:
- Config module: fail-closed kill switch (§4 of protocol.md). A
  production-like `environment`/`enabled_for` value MUST be
  unrepresentable at config-parse time, not request time. Absent/malformed
  config MUST mean disabled.
- The `DbSource`-equivalent seam: one interface/trait/behaviour, one
  Postgres implementation. Route handlers never touch the DB driver
  directly.
- Route handlers for all 6 routes (§5.1–§5.6 of protocol.md).
- Vendored `frontend/dbviewer.html` (see step 4).
- Conformance CI workflow copied from `go-conformance.yml` or
  `spring-boot-conformance.yml`, adapted to your toolchain/start-command.

## 3. What you reuse — do not reimplement

- The filter grammar *parser* — frontend-only, lives in `dbviewer.html`
  already. Your backend only validates and executes the JSON filter AST
  (protocol.md §5.4.2), never parses DSL text.
- `spec/fixtures/filter-builder-tests.json` — the AST → WHERE-fragment
  cases. Build your filter-to-SQL mapping against this table, not ad hoc
  cases.
- `conformance/seed/seed.sql` and `conformance/runner` — apply/invoke as-is,
  don't rewrite.
- `frontend/dbviewer.html` itself, vendored per PORTING.md's "Vendoring
  the frontend" section: pin a release tag, record its sha256, ship
  `NOTICE` if vendored standalone, re-verify the hash in your own CI on
  every build (not just once).

## 4. What you implement — keyed to protocol.md §5

1. Config + fail-closed kill switch (§4).
2. HTML route (§5.1, vendored frontend) + five API routes (§5.2–§5.6),
   response shapes exactly per `spec/openapi.yaml`.
3. Catalog queries — table/column introspection, PK/FK metadata
   (composite FKs omitted, §5.4.1), schema scoping throughout (§1),
   row-count and common-values mechanisms per your engine (§5.3, §5.5 —
   check `docs/adapter-decisions.md` first, see step 6 below).
   **Text-cast trap** (§5.4.3): every selected column MUST be cast to
   text in the SQL itself, never decode-then-restringify in application
   code — this is the single most common port bug (locale/timezone
   drift).
4. Filter AST validation + WHERE-clause building (§5.4.2) — JSON-AST-in,
   WHERE-fragment-out. Columns validated against the live schema
   allow-list exactly like `sort`; operators mapped through a hardcoded
   allow-listed table; values always bound parameters, never
   concatenated. Verify against `spec/fixtures/filter-builder-tests.json`.
5. A timeout on every query (§6) — catalog queries included, not just
   `tables/data`.
6. `x-ashurbanipal-protocol` header on every API response (§7).

### Non-negotiable invariants (protocol.md §6) — do not violate any of these

- No unvalidated identifier ever reaches SQL text — every table/column
  name (from `table`, `sort`, `column`, filter conditions) matched
  case-sensitively against a live catalog lookup before splicing;
  everything else is a bound parameter.
- Read-only: only `SELECT`s (plus timeout config), no writes ever.
- Every query — catalog and data alike — bounded by a timeout.
- Single table per query, no joins ever.
- Every catalog/data query scoped to the connected schema, never a
  hardcoded default.
- Statelessness — no server-side session/cache required.

## 5. What you MUST NOT do

- Add authentication (perimeter security is the host's job).
- Add write endpoints (every route is read-only `GET`).
- Add extra endpoints under the mount — new functionality needs a
  `spec/protocol.md` proposal PR (spec + fixtures + implementations +
  runner together), not a port-local extension.
- Fork the frontend — vendor it as-is; UI changes go upstream.

## 6. Adapter decisions — when your engine can't match Postgres's mechanism

For each of these already-relaxed clauses, check `docs/adapter-decisions.md`
first for an existing row (Postgres and SQLite are both already there):
row counts (§5.3/§5.4.4), common-values (§5.5), text cast (§5.4.3), ILIKE
mapping (§5.4.2), schema scoping (§1), table/column comments (§5.2).

- If your language/engine needs a **different mechanism** for one of
  these already-relaxed clauses, add a new row to that table in
  `docs/adapter-decisions.md` — do not edit `spec/protocol.md`.
- If you hit a clause that would require relaxing a **protocol property
  itself** (not just swapping mechanism) and isn't already covered in
  `docs/adapter-decisions.md`, **stop and flag it to the user** — don't
  silently decide. Per `PORTING.md`'s governance section, a protocol
  change is a one-PR-touching-spec-fixtures-implementations-runner-together
  change, never a port-local workaround.

## 7. CSP and inline scripts

`dbviewer.html` ships its logic as an inline `<script type="module">`.
Document which of PORTING.md's two options your port takes: carve out a
CSP exception scoped to the mount route, or document the operator
requirement to extend their own CSP. Don't weaken the host's CSP globally.

## 8. Verify

1. Apply the seed: `psql "$YOUR_DSN" -f conformance/seed/seed.sql`.
2. Start the port's demo app.
3. Behavior conformance (needs `cargo` even though the port isn't Rust):
   ```sh
   ASHURBANIPAL_CONFORMANCE_URL=http://localhost:PORT/__ashurbanipal \
     bash conformance/runner/report.sh
   ```
4. Shape conformance (Python + schemathesis, no Rust needed):
   ```sh
   ASHURBANIPAL_CONFORMANCE_URL=http://localhost:PORT/__ashurbanipal \
     bash conformance/runner/schema-check.sh
   ```
5. Write the port's own kill-switch test (no-config-means-disabled case,
   not just the named-production-alias-rejection case) — conformance
   can't observe this over HTTP.
6. Wire both checks into public CI as reusable-workflow calls
   (`.github/workflows/_conformance-behavior.yml` /
   `_conformance-schema.yml`), copying `go-conformance.yml` or
   `spring-boot-conformance.yml`.

## 9. Before calling it done

Do not add the port to `readme.md`'s registry or `PORTING.md`'s sign-off
log yourself — `PORTING.md`'s listing bar requires a named human reviewer
to read and run the kill-switch test and confirm the cross-port hardening
checklist (7 items, `PORTING.md` "Cross-port hardening checklist").
Instead, report to the user: what's implemented, conformance results,
any new `docs/adapter-decisions.md` rows added, any protocol-relaxation
question flagged in step 6, and that human sign-off is the remaining
step before listing.
