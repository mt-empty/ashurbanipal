# Ashurbanipal — Design Doc

Status: draft
Scope: v1 (Rust / Axum / Postgres)

## 1. Summary

Ashurbanipal is a self-contained, embeddable, read-only database browser for
development, integration, and staging environments. A service embeds the
Ashurbanipal crate, mounts its routes, and gets a web UI for browsing its own
database tables — no separate DB client, no extra credentials, no build step.

v1 targets Rust services built on Axum, backed by Postgres.

## 2. Goals / Non-goals

**Goals**

- Zero-setup table browsing for engineers working in lower environments.
- No new credentials or infrastructure — reuse the host service's DB pool.
- Safe by construction: read-only, schema-validated, parameterized.
- Single compiled artifact — no static file deployment, no CDN build step for
  the core UI.
- Quick navigation across a multi-service architecture via sibling links.

**Non-goals (v1)**

- Cross-table joins or multi-table queries. One table at a time. (Surfacing
  a foreign key as a clickable UI link that switches tables is not an
  exception to this — it's two sequential single-table queries triggered by
  a click, never a join, and no response ever mixes rows from two tables.)
- Multi-column sort (single column only; multi-column is a future addition).
- Writes of any kind.
- Dynamic sibling discovery (service registry, k8s, etc.) — static config only.
- Diff viewer (Monaco / `@pierre/diffs`) — deferred to a later iteration.
- Non-Postgres backends beyond SQLite and MySQL — the DB layer is
  trait-based so these are additive changes later, not a rewrite. A SQLite
  `DbSource` (`implementations/rust/src/db/sqlite.rs`, opt-in `sqlite`
  Cargo feature) and a MySQL/MariaDB `DbSource`
  (`implementations/rust/src/db/mysql.rs`, opt-in `mysql` Cargo feature)
  have both been reviewed and merged; see `docs/adapter-decisions.md` for
  the per-clause decisions each makes where Postgres-specific catalog/stats
  mechanisms have no equivalent.
- In-app authentication/authorization — access control is perimeter-based
  (see §6).

## 3. Architecture

Two components, same as the original concept:

### 3.1 Frontend — `dbviewer.html`

- Single static HTML file: markup, CSS, and JS in one file, framework-agnostic.
  Generated (`mise run frontend:build`) from TypeScript/CSS sources in
  `frontend/src/`, bundled with esbuild and inlined back into one file —
  the shipped artifact and everything downstream of it (vendoring, CSP,
  the release checksum) sees no difference from a hand-edited file; see
  `docs/frontend-style-guide.md` §1 for the source layout.
- No CDN dependency is wired in. `jsonb` tree rendering (collapsible via
  native `<details>`/`<summary>`) and per-type coloring (JSON scalars, plus
  `uuid`/`boolean`/numeric/date columns) are hand-rolled directly in
  `dbviewer.html` rather than pulled from a CDN — the original
  `@alenaksu/json-viewer`/Prism.js plan was superseded once building a
  working plain-text fallback (required anyway by `ui-guidelines.md` R3)
  turned out to be most of the implementation work either way.
  Monaco's diff editor is a separate, further-out deferral (see §9) and is
  the one place a CDN dependency is still under consideration.
- Embedded into the Rust binary at compile time via `include_str!`, so the
  crate ships as one artifact — no separate static file to build, deploy, or
  whitelist per environment.
- Served by the backend as the 6th route, gated by the same kill switch as
    the six API routes.
- Talks to the backend exclusively through the REST endpoints in §4.
- **Inspection affordances** (native elements, no library):
  - *Raw payload viewer* — a "payload" button opens a native `<dialog>`
    (`showModal()`: backdrop, Esc-to-close, focus trap for free) showing the
    pretty-printed JSON response for the current table view.
  - *Per-cell copy* — a small copy button on the right of every non-null
    cell, revealed on hover; Clipboard API with an `execCommand` fallback
    for plain-http internal hosts (Clipboard API needs a secure context).
  - *Cell preview* — clicking a `jsonb` cell, or any cell truncated by the
    max cell width (~24rem), opens a native Popover API popup
    (`popover` attribute: non-modal, light-dismiss) near the cell with the
    full content; JSON-shaped values pretty-print.
  - *Record / vertical view* — a per-row button opens that row as a stacked
    `column: value` list, reusing the same `<dialog>` chrome as the payload
    viewer. Per-field copy buttons plus a whole-row-as-JSON copy button.
  - *API reference for AI agents* — a fixed "?" button in the corner opens
    a native `<dialog>` (same chrome as the payload viewer) showing a
    static, hand-maintained JSON document describing every route in §4
    (method, params, an example request/response) plus the filter DSL
    grammar (including its 10-condition/1024-byte limits), with a copy
    button. Deliberately not its own endpoint — the
    doc doesn't vary per request, so it's meant for a human to copy and
    paste into an agent's context, not to be machine-fetched. Lives in the
    frontend JS and must be kept in sync with §4 by hand.
- **Navigation and filtering affordances**:
  - *Click-to-filter* — a button on a cell (or a dedicated button for null
    cells) composes an exact-match `column = value` (or `IS NULL`) clause
    into the filter box and submits it. Always **replaces** the current
    filter for now — composing with an already-applied filter is a known
    open design question, not yet built
    (`docs/feature-backlog/01-click-to-filter-compose-vs-replace.md`).
  - *Common-values dropdown* — a header affordance lists a column's most
    frequent values, fetched on demand from `/tables/common-values` (§4),
    as one-click filter shortcuts; empty when the column has no planner
    statistics yet.
  - *Foreign-key navigation* — a cell in an FK column (per the `key`/
    `references` column metadata, §4) is clickable: it switches to the
    referenced table and filters it to the matching row. Per §2's
    non-goal carve-out, this is two sequential single-table queries, never
    a join.
  - *Filter autocomplete* — the filter input suggests column names via a
    native `<datalist>` at condition-start boundaries (empty input, or
    right after `AND `/`OR `/`NOT `). No value- or operator-level
    autocomplete, and no *as-you-type* parsing of the filter text — both
    would require understanding where the cursor sits in the grammar.
    (The submit-time client-side parser — `spec/filter-dsl.md`,
    `frontend-style-guide.md` §7 — is separate: it runs on the full text
    once, cursor-free.) (An earlier
    version of this also highlighted the typed clause's tokens via a
    transparent-input-plus-overlay; removed after three rounds of
    increasingly subtle scroll/stacking bugs made it too bug-prone to
    maintain — if revisited, do it as a `contenteditable`-based rewrite,
    not a transparent-input-plus-overlay.)
  - *Table/column comments* — `COMMENT ON TABLE`/`COMMENT ON COLUMN` text
    (§4) is surfaced as native `title` tooltips on the sidebar table
    buttons and column headers.
  - *PK/FK header icons* — a column's `key` role (§4) gets a small icon in
    its header, with a text alternative (not color-only).
- **Grid customization**:
  - *Column show/hide* — a header popover toggles per-column visibility,
    scoped per table (hiding a column on one table never hides a
    same-named column on another); a hidden-count indicator shows in the
    toolbar. Column reorder/resize are researched but not built
    (`docs/feature-backlog/09-column-reorder-and-resize.md`).
  - *Sticky table header* — the header row stays pinned while scrolling a
    long result set vertically.
  - *Sidebar table search* — a search box above the table list filters it
    live, client-side, as the user types.
- **UI state persistence**: `localStorage` remembers lightweight UI state
  across visits — currently selected table, sort column/direction, page
  size, and per-table hidden-column sets — and the same state (except
  hidden columns) is mirrored into the URL's query params via
  `history.replaceState`, so the address bar is always a shareable link
  for the current view. Properties:
  - One `localStorage` key, `ashurbanipal_ui`, value is a small JSON
    object. Nothing sensitive ever goes in it — table/column names only,
    no row data, no filters (filters can contain data values, so the
    *applied* filter is deliberately excluded from both `localStorage` and
    the URL, never just one of the two).
  - A URL's query params win over `localStorage` on load, so opening a
    shared/bookmarked link reproduces that link's view rather than the
    visitor's own saved preferences.
  - Read and written entirely by the frontend JS; nothing is transmitted
    to the backend, so it adds no server-side attack surface or parsing
    obligation. (localStorage over a cookie precisely because the server
    never needs it.)
  - Scope caveat: localStorage is per-origin, not per-path — siblings on
    different hosts each get their own state, but if two services were
    ever served from one origin they'd share the key. Acceptable for v1.
  - On load: if the stored state names a table that no longer exists in
    `/tables`, fall back to the default view silently (stale state must
    never wedge the UI). Malformed JSON in the key → discard and rewrite.
  Detailed behavioral rules for all of the above (what may/may not be
  persisted, how affordances must degrade, no-client-parsing constraints)
  live in `ui-guidelines.md` and `frontend-style-guide.md` — this section
  specs *what* exists, those spec the rules a change to it must not break.

### 3.2 Backend — Rust crate

- Built for Axum: exposes a `Router` (self-prefixed, not relative) that the
  host service merges into its own app, e.g.:

  ```rust
  app.merge(ashurbanipal_axum::router(config, db_source));
  ```

- Does not open its own DB connection. Takes a `DbSource` (see §5) backed by
  the host's existing `sqlx::PgPool`.
- Stateless beyond the injected config and pool — no background tasks, no
  caches (health check polling is per-request; see §4's `GET /siblings`).

### 3.3 Routes

All routes live under the fixed `/__ashurbanipal` prefix, so the crate owns
its full path space and the host doesn't need to pick a mount point.

| Method | Path                          | Purpose                                              |
|--------|-------------------------------|-------------------------------------------------------|
| GET    | `/__ashurbanipal`              | Serves the embedded `dbviewer.html`.                   |
| GET    | `/__ashurbanipal/api/schemas`      | List selectable schema names.                          |
| GET    | `/__ashurbanipal/api/tables`       | List table names in the resolved schema.               |
| GET    | `/__ashurbanipal/api/table-counts` | Approximate row counts via `pg_class.reltuples`.       |
| GET    | `/__ashurbanipal/api/tables/data`  | Paginated, filtered, sorted rows for a single table.   |
| GET    | `/__ashurbanipal/api/tables/common-values` | Most-common values for one column, from `pg_stats`. |
| GET    | `/__ashurbanipal/api/siblings`     | Sibling services with live health status.              |

## 4. API contract

> **Now normative elsewhere:** the endpoint contract lives in
> `spec/protocol.md`. `spec/openapi.yaml` is hand-maintained prose, same
> as `spec/protocol.md` — not generated from any implementation's own
> route/type annotations. Every implementation, Rust included, implements
> against both as a fixed target; none of them generates either file.
> Where this section and the spec disagree, the spec wins; this section
> stays as rationale and background. See §4.2 for how the schema is kept
> binding on every implementation, and for the tradeoff hand-maintaining
> it (rather than generating it) reintroduces.

Paths below are shorthand for the full routes in §3.3 (e.g. `/tables` means
`/__ashurbanipal/api/tables`).

### `GET /tables`

Returns table names in the resolved schema (`schema` param, `spec/protocol.md`
§1), validated against
`information_schema` at request time (also doubles as the allow-list used by
`/tables/data`). `comment` is each table's `COMMENT ON TABLE` text and is
omitted when the table has none.

```json
{
  "tables": [
    { "name": "users", "comment": "Registered accounts." },
    { "name": "sessions" },
    { "name": "orders" }
  ]
}
```

### `GET /table-counts`

```json
{ "counts": [{ "table": "users", "approx_rows": 108234 }, ...] }
```

Backed by `pg_class.reltuples` — approximate, not `COUNT(*)`, to stay cheap
on large tables.

### `GET /tables/data`

Query params:

| Param     | Required | Notes                                                        |
|-----------|----------|---------------------------------------------------------------|
| `table`   | yes      | Must match an entry from `/tables` (schema allow-list).       |
| `filter`  | no       | Filter DSL, see §4.1.                                         |
| `limit`   | no       | Default 50, max 100 (hard cap, server-enforced).               |
| `offset`  | no       | Default 0.                                                     |
| `sort`    | no       | Single column name.                                            |
| `order`   | no       | `asc` \| `desc`, default `asc`.                                |

```json
{
  "columns": [
    { "name": "id", "type": "uuid", "key": "pk" },
    { "name": "user_id", "type": "uuid", "key": "fk", "references": { "table": "users", "column": "id" } },
    { "name": "status", "type": "text", "comment": "Order lifecycle state." },
    { "name": "created_at", "type": "timestamptz" }
  ],
  "rows": [ { "id": "...", "user_id": "...", "status": "...", "created_at": "..." } ],
  "total_approx": 108234
}
```

Each column entry is `{name, type}` plus optional metadata, all schema-catalog
reads (never data queries, same cost class as `/table-counts`): `key`
(`"pk"` \| `"fk"`) and, for `"fk"`, `references` (the target table/column) —
sourced from `information_schema.table_constraints`/`key_column_usage`;
composite foreign keys are omitted rather than risk mislabeling which
referencing column pairs with which referenced column. `comment` is that
column's `COMMENT ON COLUMN` text, omitted when absent. None of this is used
to build SQL — it's informational metadata for the frontend only (§3.1).

Server enforces:
- `limit` clamped to `[1, 100]`.
- `table` validated against the live schema (not just the request-supplied
  string) before being interpolated into SQL — never trusted raw.
- Statement timeout applied per query (target ~5s) so a pathological filter
  can't hold a connection from the host's pool indefinitely.

#### 4.1 Filter DSL

`[NOT] column OP value [AND|OR [NOT] column OP value ...]`

Operators: `=`, `!=`, `>`, `>=`, `<`, `<=`, `LIKE`, `ILIKE`, `IS NULL`,
`IS NOT NULL`.

- Operators are allow-listed, not interpolated as arbitrary SQL.
- Values are always parameterized, never string-concatenated. Bare values
  run to the next whitespace; values containing spaces/quotes/keywords are
  single-quoted with SQL-style `''` escaping.
- Columns are cast to `text` before comparison, so the same DSL works
  uniformly across `uuid`, `timestamptz`, `jsonb`, etc.
- Flat `AND`/`OR` chain; `AND` binds tighter than `OR` (SQL convention).
  `NOT` is a prefix on a single condition only (`NOT status = active`),
  never a general boolean operator over a compound expression — so it
  doesn't reopen parentheses/nesting, which stay out of scope, same as
  cross-table conditions.

Full grammar (EBNF), semantics, and the parser's test table live in
`spec/filter-dsl.md`. The parser is hand-written (RSQL-inspired shape, no
parser dependency) and is a **frontend** concern: `dbviewer.html` parses
the DSL text client-side and submits the resulting JSON AST as the
`filter` param; the server contract is defined purely in terms of that
AST (`spec/protocol.md` §5.4.2). (Historically the parser was built
server-side, in `src/filter.rs`, last in the server build order.)

Example:

```
status = completed AND created_at > 2016-01-01
session_id = 18d852af-77ae-4a95-9f7d-e37a77fda2fd
```

### 4.2 Guaranteeing the contract across implementations

Three independent layers exist so "the spec says X" reliably means every
implementation does X — no implementation, Rust included, gets special
treatment. Each catches a drift failure mode the others structurally
can't:

1. **Schema, hand-maintained, governed rather than generated.**
   `spec/openapi.yaml` is hand-maintained prose, same as
   `spec/protocol.md` — not compiled from any implementation's own
   route/type annotations. This makes the drifts-from-its-own-spec
   failure mode a governance property, not a structural one: a spec
   change is one PR touching `spec/protocol.md` + `spec/openapi.yaml` +
   fixtures together, the same one-PR rule `implementation.md` §6.3
   already applies to an implementation + its fixtures + the conformance
   runner, generalized here rather than reinvented. Honest tradeoff this
   reintroduces: without generation, drift between the hand-written
   schema and actual behavior is no longer *prevented by construction* —
   it's *caught after the fact*, by layer 2 below, whenever some
   implementation's CI run first exercises the diverged case. No
   implementation generates this file; every implementation implements
   against the published `spec/openapi.yaml` as a fixed target, same as
   it implements against `spec/protocol.md`'s prose.
2. **Shape conformance — schema fuzzing, every implementation, every CI
   run, no exemptions.** Property-based schema testing (schemathesis or
   an equivalent for the implementation's language) runs in CI against
   every implementation's own build — the Rust implementation runs this
   in its own CI exactly like any other implementation would, with no
   structural exemption — firing requests generated from
   `spec/openapi.yaml` and asserting every response actually matches its
   documented type, nullability, and status code. This is what makes the
   schema *binding* on an implementation rather than merely descriptive:
   returning a JSON number for a numeric column (violating §4's
   all-values-as-strings rule, §5.4.3 of `spec/protocol.md`) or omitting
   a required field fails CI automatically — the fuzzer explores the
   schema's cases, not whatever a human thought to hand-write.
3. **Behavior conformance — golden fixtures over seeded data.** Schema
   fuzzing only proves a response has the right *shape*; it can't catch
   wrong *logic* — AND/OR precedence inverted, `total_approx` reacting to
   `filter` when §4's contract says it must not, off-by-one pagination.
   For that, the conformance kit (`conformance/`, `spec/fixtures/`)
   replays fixed request → expected-response pairs against seeded known
   data, comparing *decoded values*, per field, against a rule chosen for
   what that field actually promises — never raw response bytes. Byte
   equality isn't just impractical, it's incompatible with the spec:
   JSON key order isn't guaranteed to match across serializers (Rust's
   `serde_json` vs Jackson), HTTP framing differs by server stack, and
   §2 already makes error body text implementation-defined ("MUST NOT
   parse it"). Instead:
   - **exact match** — row data, column metadata, pagination, filter
     evaluation results: everything the spec makes deterministic against
     fixed fixture data. This is what actually catches wrong logic.
   - **type/range only** — `total_approx` (non-negative integer or `-1`,
     never a specific number — §5.4.4 already allows staleness),
     `common-values` frequencies (a float in `[0,1]`, not an exact value
     — `pg_stats` sampling isn't reproducible run to run).
   - **status code only** — error responses: assert 400 vs 500, never
     assert the body text.
   - **not checked** — HTTP-layer framing beyond headers the spec
     actually requires (e.g. `Date`, `Server`).

   `spec/fixtures/parser-tests.json` and `filter-builder-tests.json` are
   the first instance of this pattern, scoped to the filter DSL; the
   conformance kit generalizes it to every route.

Even all three together don't cover everything a port must get right —
notably, none of them can prove the *absence* of a SQL-injection vector a
fixture doesn't happen to exercise, or observe config-time kill-switch
rejection at all (it's process-startup behavior, not an HTTP response).
`implementation.md` §5.5 tracks these and other non-automatable
requirements (cast-in-SQL discipline, fail-closed-by-default, vendoring
integrity, CSP/inline-script) as an explicit reviewer checklist, separate
from the three CI-automatable layers above — conflating "green CI" with
"conformant" would quietly drop exactly the properties that matter most.

No layer is sufficient alone: (1) without (2) still lets a port drift
from the schema unnoticed; (2) without (3) lets a port satisfy every type
and status code while getting the actual query logic wrong; (3) without
(1)/(2) only covers whatever cases someone thought to write down by hand.
A "conformant" listing in `PORTING.md` requires a green run of all three,
not just the behavioral suite Phase 2 already plans.

### `GET /tables/common-values`

Query params: `table`, `column` — both validated against the live schema
allow-list, same as `/tables/data`.

```json
{ "values": [{ "value": "active", "freq": 0.62 }, { "value": "closed", "freq": 0.31 }] }
```

Backed by `pg_stats.most_common_vals`/`most_common_freqs` (populated by
`ANALYZE`) — a catalog-only read, never `SELECT DISTINCT`, matching the same
"approximate and cheap over exact and expensive" philosophy as
`/table-counts`. Empty when the column has no planner statistics yet (never
an error). Fetched on demand for one column at a time, not folded into
`/tables/data`'s response — it's only needed when a user opens that column's
dropdown.

### `GET /siblings`

```json
{
  "siblings": [
    { "name": "billing", "dbviewer_url": "https://billing.internal.vpn/__ashurbanipal", "healthy": true },
    { "name": "notifications", "dbviewer_url": "https://notifications.internal.vpn/__ashurbanipal", "healthy": false }
  ]
}
```

The backend performs the health checks (parallel HTTP GET to each sibling's
configured health path) synchronously when this endpoint is called. The
frontend polls `/siblings` every ~15s and re-renders status dots; no
server-side background polling or caching in v1 (see §9 for revisit
criteria if this gets expensive).

## 5. DB integration

```rust
pub trait DbSource: Send + Sync + 'static {
    async fn list_schemas(&self) -> Result<Vec<String>, DbError>;
    async fn list_tables(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError>;
    async fn table_counts(&self, schema: Option<&str>) -> Result<Vec<(String, i64)>, DbError>;
    async fn query_table(&self, schema: Option<&str>, table: &str, opts: QueryOpts) -> Result<TableData, DbError>;
    async fn common_values(&self, schema: Option<&str>, table: &str, column: &str) -> Result<Vec<(String, f32)>, DbError>;
}
```

Native async-fn-in-trait — no `async_trait` macro. The router is generic
over `S: DbSource` (no `dyn`), which is all v1 needs with a single
implementation.

- v1 ships exactly one implementation: `PgPoolSource(sqlx::PgPool)`.
- The trait boundary exists so a `deadpool-postgres` or `tokio-postgres`
  adapter can be added later without touching route handlers — this is
  intentionally the only piece of the crate designed for a hypothetical
  future backend; everything else stays concrete to v1's scope.
- `schema: None` resolves to `current_schema()`; an explicit value is
  checked against the same live `pg_namespace` allow-list (excluding
  catalog/toast/temp schemas and anything the connected role lacks `USAGE`
  on) that the implicit path is also checked against, so neither path can
  reach a schema the other would reject. Resolved once per operation, as
  the first statement in that operation's transaction, so every later
  query in the same transaction reuses the same value even under pool
  session drift (`tests/schema_isolation.rs`).
- `TableInfo` (§4's `/tables` shape: `name` + optional `comment`) and
  `common_values` (§4's `/tables/common-values`) both read schema catalogs
  (`pg_description`/`pg_stats`), never table data beyond what `query_table`
  itself fetches.

## 6. Access control

No authentication or authorization inside Ashurbanipal itself. Access is
controlled entirely by:

1. **Kill switch** — config-driven, keyed by (application, environment).
   Disabled unless explicitly enabled for a given app + env combination.
   Environments: `dev`, `integration`, `staging`, `any`. `production` (and
   recognized variants/aliases — `prod`, `PRODUCTION`, etc.) is rejected at
   config-parse time: startup fails fast if `enabled_for` contains a
   production-like value, rather than relying on operators never making the
   mistake.
2. **Network perimeter** — the host services are only reachable from inside
   the company VPN. There is no additional bearer token, session, or login
   inside Ashurbanipal.

This is a deliberate v1 choice, not an oversight: it trades defense-in-depth
for zero setup cost. If that tradeoff changes (e.g. VPN perimeter loosens,
or lower environments start holding sensitive data), the natural next step
is a bearer-token check the host app injects, not a rewrite.

## 7. Configuration (TOML)

```toml
[ashurbanipal]
# the environment this host process is currently running in
environment = "dev"
# per (app, environment) kill switch: which environments the browser is
# enabled for. "production"/"prod" (any casing) is rejected at parse time
# for either field — see §6. "any" matches every environment except
# production-like ones.
enabled_for = ["dev", "integration", "staging"]

[ashurbanipal.limits]
default_page_size = 50
max_page_size = 100
query_timeout_secs = 5

[[ashurbanipal.siblings]]
name = "billing"
dbviewer_url = "https://billing.internal.vpn/__ashurbanipal"
health_path = "/health"

[[ashurbanipal.siblings]]
name = "notifications"
dbviewer_url = "https://notifications.internal.vpn/__ashurbanipal"
health_path = "/health"
```

- `health_path` is resolved against the sibling's own base URL (not the
  `dbviewer_url` path) to hit its conventional health endpoint.
- Config is loaded once at startup; sibling list is static for v1 (no
  service-registry integration).

## 8. Safety properties (carried over from the original concept)

- Read-only: `SELECT` only; uses a read replica/data source where the host
  app provides one.
- SQL-injection safe: table names validated against live schema, filter
  operators allow-listed, all values parameterized.
- Embedded: runs inside the host process, no sidecar, no separate
  container, no separate credentials.
- Single artifact: frontend is compiled into the binary; nothing to deploy
  or version separately.

## 9. Deferred / explicitly out of scope for v1

- **Diff viewer**: Monaco's diff editor, as originally scoped, for comparing
  two whole rows against each other, column by column — `jsonb` columns are
  the main reason a real diff tool is needed at all, since a `jsonb` value
  only becomes comparable once pretty-printed. `@pierre/diffs` was initially
  evaluated and ruled out for declaring `react`/`react-dom` as peer
  dependencies, but that finding is now stale — the package has since split
  into a vanilla-JS core (Web Components, no React) plus optional React
  bindings, so it's back in play as a candidate (see
  `docs/feature-backlog/04-diff-viewer-for-rows.md`). Do the Monaco vs.
  `@pierre/diffs` bake-off when implementation is actually revisited, once
  the core browser is in use.
- **Multi-column sort.**
- **Dynamic sibling discovery.**
- **Non-Postgres `DbSource` implementations beyond SQLite and MySQL** — a
  SQLite adapter and a MySQL/MariaDB adapter are now in (§2,
  `docs/adapter-decisions.md`); further backends remain deferred.
- **Health check caching/background polling** — if per-request parallel
  health checks on `/siblings` turn out to be too chatty or slow with many
  siblings, move to a background-polled cache with the same 15s cadence
  instead of doing it inline per request.
- **Column reorder/resize** — the remaining two items from the grid-
  customization family (show/hide is built, §3.1); lowest priority of the
  bunch (`docs/feature-backlog/09-column-reorder-and-resize.md`).

Finer-grained, still-undecided frontend ideas (click-to-filter compose
semantics, per-table filter history, cross-environment jump links, etc.)
are tracked as they come up, one file per idea, under
`docs/feature-backlog/`, not duplicated here — this section stays the
stable, agreed-scope list.
