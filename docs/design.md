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
- Non-Postgres backends — deferred; the DB layer is trait-based so this is an
  additive change later, not a rewrite.
- In-app authentication/authorization — access control is perimeter-based
  (see §6).

## 3. Architecture

Two components, same as the original concept:

### 3.1 Frontend — `dbviewer.html`

- Single static HTML file: markup, CSS, and JS in one file, framework-agnostic.
- CDN-loaded Monaco Editor and JSON tree viewer (diff view is stubbed for a
  later iteration; see §9).
- Embedded into the Rust binary at compile time via `include_str!`, so the
  crate ships as one artifact — no separate static file to build, deploy, or
  whitelist per environment.
- Served by the backend as a 5th route, gated by the same kill switch as the
  four API routes.
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
- **UI state persistence**: `localStorage` remembers lightweight UI state
  across visits — currently selected table, and (same mechanism, near-free)
  sort column/direction and page size. Properties:
  - One key, `ashurbanipal_ui`, value is a small JSON object. Nothing
    sensitive ever goes in it — table names only, no row data, no filters
    (filters can contain data values).
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

### 3.2 Backend — Rust crate

- Built for Axum: exposes a `Router` (self-prefixed, not relative) that the
  host service merges into its own app, e.g.:

  ```rust
  app.merge(ashurbanipal::router(config, db_source));
  ```

- Does not open its own DB connection. Takes a `DbSource` (see §5) backed by
  the host's existing `sqlx::PgPool`.
- Stateless beyond the injected config and pool — no background tasks, no
  caches (health check polling is per-request; see §7.3).

### 3.3 Routes

All routes live under the fixed `/__ashurbanipal` prefix, so the crate owns
its full path space and the host doesn't need to pick a mount point.

| Method | Path                          | Purpose                                              |
|--------|-------------------------------|-------------------------------------------------------|
| GET    | `/__ashurbanipal`              | Serves the embedded `dbviewer.html`.                   |
| GET    | `/__ashurbanipal/api/tables`       | List table names in the connected schema.             |
| GET    | `/__ashurbanipal/api/table-counts` | Approximate row counts via `pg_class.reltuples`.       |
| GET    | `/__ashurbanipal/api/tables/data`  | Paginated, filtered, sorted rows for a single table.   |
| GET    | `/__ashurbanipal/api/siblings`     | Sibling services with live health status.              |

## 4. API contract

Paths below are shorthand for the full routes in §3.3 (e.g. `/tables` means
`/__ashurbanipal/api/tables`).

### `GET /tables`

Returns table names in the connected database's schema, validated against
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
  "columns": [{ "name": "id", "type": "uuid" }, { "name": "created_at", "type": "timestamptz" }],
  "rows": [ { "id": "...", "created_at": "..." } ],
  "total_approx": 108234
}
```

Server enforces:
- `limit` clamped to `[1, 100]`.
- `table` validated against the live schema (not just the request-supplied
  string) before being interpolated into SQL — never trusted raw.
- Statement timeout applied per query (target ~5s) so a pathological filter
  can't hold a connection from the host's pool indefinitely.

#### 4.1 Filter DSL

`column OP value [AND|OR column OP value ...]`

Operators: `=`, `!=`, `>`, `>=`, `<`, `<=`, `LIKE`, `IS NULL`, `IS NOT NULL`.

- Operators are allow-listed, not interpolated as arbitrary SQL.
- Values are always parameterized, never string-concatenated. Bare values
  run to the next whitespace; values containing spaces/quotes/keywords are
  single-quoted with SQL-style `''` escaping.
- Columns are cast to `text` before comparison, so the same DSL works
  uniformly across `uuid`, `timestamptz`, `jsonb`, etc.
- Flat `AND`/`OR` chain; `AND` binds tighter than `OR` (SQL convention).
  No parentheses, no `NOT`, no cross-table conditions in v1 — matches the
  single-table, no-join scope.

Full grammar (EBNF), semantics, and the parser's test table live in
`filter-dsl.md`. The parser is hand-written (RSQL-inspired shape, no
parser dependency) and is scheduled **last** in the server build order.

Example:

```
status = completed AND created_at > 2016-01-01
session_id = 18d852af-77ae-4a95-9f7d-e37a77fda2fd
```

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
frontend polls `/siblings` every ~10s and re-renders status dots; no
server-side background polling or caching in v1 (see §9 for revisit
criteria if this gets expensive).

## 5. DB integration

```rust
pub trait DbSource: Send + Sync {
    async fn list_tables(&self) -> Result<Vec<String>>;
    async fn table_counts(&self) -> Result<Vec<(String, i64)>>;
    async fn query_table(&self, table: &str, opts: QueryOpts) -> Result<TableData>;
}
```

Native async-fn-in-trait — no `async_trait` macro. The router is generic
over `S: DbSource` (no `dyn`), which is all v1 needs with a single
implementation; see `dependencies.md` for the reasoning and the upgrade
path if runtime polymorphism is ever needed.

- v1 ships exactly one implementation: `PgPoolSource(sqlx::PgPool)`.
- The trait boundary exists so a `deadpool-postgres` or `tokio-postgres`
  adapter can be added later without touching route handlers — this is
  intentionally the only piece of the crate designed for a hypothetical
  future backend; everything else stays concrete to v1's scope.
- Single schema assumption (`public`) for v1; not abstracted further.

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
# per (app, environment) kill switch
# "production"/"prod" (any casing) is rejected at parse time — see §6.
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
  `jsonb` values between rows. `@pierre/diffs` was evaluated and ruled out —
  it declares `react`/`react-dom` as peer dependencies, so it can't be used
  without pulling React into an otherwise framework-agnostic single-file
  frontend (see `cdn-research.md` §3). Revisit implementation once the core
  browser is in use.
- **Multi-column sort.**
- **Dynamic sibling discovery.**
- **Non-Postgres `DbSource` implementations.**
- **Health check caching/background polling** — if per-request parallel
  health checks on `/siblings` turn out to be too chatty or slow with many
  siblings, move to a background-polled cache with the same 10s cadence
  instead of doing it inline per request.
