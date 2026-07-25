# Ashurbanipal Protocol — v1

Status: normative
Companions: `spec/openapi.yaml` (machine-readable shapes),
`spec/filter-dsl.md` (the frontend's filter grammar), `docs/design.md`
(rationale and history — non-normative).

This document defines the HTTP contract every Ashurbanipal implementation
— the Rust reference and any port — must satisfy. The shared frontend
(`dbviewer.html`) is written against exactly this contract and nothing
else.

## 1. Terminology

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described in RFC 2119.

- **Implementation** — a server (the Rust reference or a port) exposing
  the routes in §5 under a mount point.
- **Mount** — the URL path prefix under which an implementation serves the
  UI and API (see §3).
- **Connected schema** — the Postgres schema the implementation browses:
  the result of `current_schema()` on the connection in use. All table
  listing, validation, metadata, and data queries MUST be scoped to the
  connected schema, never hardcoded to `public`.

## 2. Transport

- The protocol is plain HTTP. Every endpoint is `GET`; implementations
  MUST NOT accept writes of any kind on any route.
- Success responses are `application/json`, except the UI route (§5.1),
  which is `text/html`.
- Error responses are plain-text bodies (`text/plain`), not JSON:
  - **400** — client error: unknown table or column, invalid filter,
    invalid `order` value.
  - **500** — database failure.
  The body is a short human-readable reason. Its exact wording is
  implementation-defined; clients MUST NOT parse it. (A structured error
  envelope would be a protocol v2 change.)
- Every API response (§5.2–§5.6), success or error, MUST carry the
  protocol version header (§7).

## 3. Mount contract

- The UI is served at `{mount}`; the five API routes live at
  `{mount}/api/...`.
- `{mount}` is implementation-defined. `/__ashurbanipal` is the Rust
  implementation's default, not a requirement.
- The frontend derives its API base from its own URL
  (`location.pathname + "/api"`), so an implementation MAY serve the
  unmodified frontend artifact at any mount, including behind a
  reverse-proxy prefix.
- Implementations MUST NOT expose additional endpoints under `{mount}`
  (extensions go through spec revisions), and MUST NOT add authentication
  inside the mount — access control is a perimeter concern.

## 4. Kill switch

- Configuration MUST name the environment the host process is running in
  and an allow-list of environments the viewer is enabled for.
- **Production-like names** are `production`, `prod`, `prd`, `live`,
  compared case-insensitively.
- A production-like name in the allow-list MUST be rejected **at config
  load** — startup fails, not a runtime 404.
- When the running environment is production-like, the viewer MUST be
  disabled regardless of the allow-list (including `any`).
- The allow-list vocabulary is otherwise **open**: any non-production-like
  token is a valid environment name (`int`, `uat`, `sit`, ...). The
  special token `any` matches every environment except production-like
  ones. Environment matching is case-insensitive.
- When disabled, all six routes MUST behave exactly as if the viewer were
  never mounted: 404, indistinguishable from an absent implementation.
  The enabled check is a startup-time decision, not per-request.

## 5. Routes

Paths below are relative to `{mount}`. Parameters are query parameters.
JSON field order is not significant. Optional response fields are omitted
when absent, never `null`.

### 5.1 `GET {mount}` — UI

Serves the Ashurbanipal frontend (`dbviewer.html`) as `text/html`.
Implementations MUST serve the released frontend artifact unmodified
(no forks).

### 5.2 `GET {mount}/api/tables`

Lists the base tables of the connected schema. This list is also the
allow-list every other route validates `table` parameters against.

Response:

```json
{
  "tables": [
    { "name": "users", "comment": "Registered accounts." },
    { "name": "sessions" }
  ]
}
```

- `name` — the table name.
- `comment` — the table's `COMMENT ON TABLE` text; MUST be omitted when
  the table has none.
- Tables SHOULD be returned in a stable order (the Rust implementation
  sorts by name).

### 5.3 `GET {mount}/api/table-counts`

Approximate row counts for every table in the connected schema.

Response:

```json
{ "counts": [{ "table": "users", "approx_rows": 108234 }] }
```

- `approx_rows` MUST come from catalog statistics
  (`pg_class.reltuples`), never `COUNT(*)`. It MAY be stale, and MAY be
  `-1` for a table never yet analyzed or vacuumed — clients MUST tolerate
  both.

### 5.4 `GET {mount}/api/tables/data`

Paginated, filtered, sorted rows for a single table.

| Param    | Required | Rules                                                         |
|----------|----------|---------------------------------------------------------------|
| `table`  | yes      | MUST match a table from §5.2 exactly (case-sensitive); otherwise 400. |
| `filter` | no       | URL-encoded JSON AST, see §5.4.2.                             |
| `limit`  | no       | Clamped, never an error — see below.                          |
| `offset` | no       | Non-negative integer, default 0.                              |
| `sort`   | no       | Single column name; MUST be validated against the table's real columns; unknown column → 400. |
| `order`  | no       | `asc` \| `desc`, default `asc`; any other value → 400.        |

- **`limit` clamping**: the effective limit is the requested value clamped
  to `[1, max_page_size]` (`max_page_size` is configuration; reference
  default 100; default when the param is absent is `default_page_size`,
  reference default 50). Out-of-range values MUST be clamped, never
  rejected.
- **Sort semantics**: ordering MUST use the column's native type ordering
  (e.g. numeric columns sort numerically), not the text rendering of the
  serialized values.

Response:

```json
{
  "columns": [
    { "name": "id", "type": "uuid", "key": "pk" },
    { "name": "user_id", "type": "uuid", "key": "fk",
      "references": { "table": "users", "column": "id" } },
    { "name": "status", "type": "text", "comment": "Order lifecycle state." },
    { "name": "created_at", "type": "timestamp with time zone" }
  ],
  "rows": [
    { "id": "7d9…", "user_id": "18d…", "status": "completed",
      "created_at": "2016-01-01 12:00:00+00" }
  ],
  "total_approx": 108234
}
```

#### 5.4.1 Column metadata

Each `columns` entry is `{name, type}` plus optional fields, all sourced
from schema catalogs (never data queries):

- `key` — `"pk"` or `"fk"`.
- `references` — `{table, column}`, present only when `key` is `"fk"`.
- `comment` — `COMMENT ON COLUMN` text, omitted when absent.
- **Composite foreign keys MUST be omitted** from `key`/`references`
  entirely (the columns appear with no key metadata) rather than risk
  mislabeling which referencing column pairs with which referenced
  column.

None of this metadata is used to build SQL — it is informational, for the
frontend.

#### 5.4.2 Filter: JSON AST

The `filter` parameter carries a URL-encoded JSON **array of condition
objects** — never DSL text. Grammar parsing (DSL text → AST) is a
frontend-only concern, specified in `spec/filter-dsl.md`; no
implementation parses filter text. Decoded example:

```json
[
  {"column": "status", "op": "=", "value": "completed"},
  {"logic": "AND", "not": true, "column": "created_at", "op": ">", "value": "2016-01-01"},
  {"column": "deleted_at", "op": "IS NULL"}
]
```

Structural rules (violations → 400):

- `op` MUST be one of `=`, `!=`, `>`, `<`, `>=`, `<=`, `LIKE`, `ILIKE`,
  `IS NULL`, `IS NOT NULL` — exactly this set, exactly these spellings.
- `logic` (`"AND"` or `"OR"`) MUST be absent on the first element and
  present on every subsequent element.
- `not` is optional and defaults to `false`.
- `value` MUST be present (a JSON string) for every op except
  `IS NULL`/`IS NOT NULL`, for which it MUST be absent.
- At most **10** conditions; more → 400.
- Implementations MUST bound the byte length of the JSON-encoded filter
  parameter and reject oversize filters with 400, never a truncated
  query. The Rust implementation's bound is 8192 bytes on the URL-decoded JSON text —
  derived by measuring the JSON-over-DSL inflation of every valid case in
  `spec/fixtures/parser-tests.json` (worst case 5.67x, so the DSL era's
  1024 bytes of expressiveness needs ~5803 JSON bytes; 8192 is the
  nearest clean power of two above).
- An empty array MUST be treated identically to an absent `filter`.

Evaluation rules:

- Each condition's `column` MUST be validated against the table's real
  columns before appearing in SQL; unknown column → 400. (This is the
  server-side half of what was historically the filter grammar's §3 —
  identifiers can't be parameterized, so exact-match validation against
  the live schema is what makes splicing them safe.)
- Each `op` MUST be mapped through a hardcoded operator→SQL-fragment
  table; client-supplied text is never used as an operator.
- Each `value` MUST be bound as a query parameter, never concatenated
  into SQL text.
- Comparison is applied to the column cast to text
  (`column::text OP $n`), so one filter works uniformly across `uuid`,
  `timestamptz`, `jsonb`, etc. Known consequence: `>`/`<`/`>=`/`<=` are
  lexicographic, wrong for numerics (`"10" < "9"`) — deliberate v1
  behavior.
- `not: true` wraps the condition's mapped fragment in `NOT (...)`; it
  MUST NOT have its own operator table.
- Conditions are joined by their `logic` tokens with SQL's native
  precedence: `AND` binds tighter than `OR`. No grouping/nesting exists
  in the AST.
- Contradictory conditions are legal and simply return zero rows.

#### 5.4.3 Value serialization

Every cell value crosses the wire as a **JSON string or `null`** — no JSON
numbers, booleans, or nested objects, regardless of column type. `uuid`,
numerics, timestamps, `jsonb`: all strings (the Postgres text rendering,
i.e. the result of casting the column to `text`). SQL `NULL` is JSON
`null`. A value that cannot be decoded as text MUST be replaced by the
sentinel string `"<undecodable>"` rather than failing the request.

A port that returns JSON numbers for numeric columns is **non-conformant**
— the frontend's type-aware rendering keys off column *type metadata*
(§5.4.1), not JSON value types.

#### 5.4.4 `total_approx`

- MUST be the whole-table estimate from `pg_class.reltuples`.
- MUST NOT be affected by `filter` (it is not a filtered count).
- MAY be stale, and MAY be `-1` before the table's first
  ANALYZE/VACUUM.

### 5.5 `GET {mount}/api/tables/common-values`

Most-common values for one column, from planner statistics.

| Param    | Required | Rules                                             |
|----------|----------|---------------------------------------------------|
| `table`  | yes      | Validated against §5.2's list; unknown → 400.     |
| `column` | yes      | Validated against the table's real columns; unknown → 400. |

Response:

```json
{ "values": [{ "value": "active", "freq": 0.62 }, { "value": "closed", "freq": 0.31 }] }
```

- Values MUST come from catalog statistics only
  (`pg_stats.most_common_vals`/`most_common_freqs`) — never
  `SELECT DISTINCT` or any data query.
- A column with no planner statistics (never analyzed, or all-unique)
  MUST yield an empty `values` list, not an error.
- `freq` is the fraction of rows (0–1], most frequent first.
- `value` strings SHOULD match the §5.4.3 rendering of the same data
  (the Rust implementation normalizes boolean `t`/`f` from the stats array's text
  form to `true`/`false` for this reason), so a value can round-trip
  into an equality filter.

### 5.6 `GET {mount}/api/siblings`

Configured sibling services with live health status.

Response:

```json
{
  "siblings": [
    { "name": "billing", "dbviewer_url": "https://billing.internal.vpn/__ashurbanipal", "healthy": true },
    { "name": "notifications", "dbviewer_url": "https://notifications.internal.vpn/__ashurbanipal", "healthy": false }
  ]
}
```

- The sibling list is static configuration; an empty configuration yields
  `{"siblings": []}`.
- Health checks are performed synchronously per request: an HTTP GET to
  each sibling's configured health path, resolved against the sibling's
  **origin** (scheme + host + port of `dbviewer_url`), not against the
  `dbviewer_url` path.
- `healthy` is `true` iff the check returned a 2xx status. Any failure —
  non-2xx, network error, timeout, unresolvable URL — is `false`, never
  an error response.
- Checks SHOULD run in parallel and MUST be individually bounded by a
  timeout (reference: 3 s) so one dead sibling can't stall the response.

## 6. Server invariants

These hold across all routes:

- **No unvalidated identifier ever reaches SQL text.** Table and column
  names — from `table`, `sort`, `column`, and every filter condition —
  MUST be matched exactly (case-sensitive) against a live schema-catalog
  lookup before being spliced into a query. Everything else MUST be a
  bound parameter.
- **Read-only.** The only statements an implementation may execute are
  `SELECT`s (data and catalog) and the statement-timeout setting below.
- **Every database query MUST be bounded by a timeout** (configuration;
  reference default 5 s) — catalog and metadata queries included, not
  just row fetches — so a pathological query can't hold a host-pool
  connection indefinitely. A timed-out query is a 500.
- **Single table per query, no joins ever.** FK navigation in the UI is
  two sequential single-table queries; no response mixes rows from two
  tables.
- **Schema scoping.** Every catalog and data query MUST be scoped to the
  connected schema (§1), i.e. `current_schema()`, not a hardcoded
  `'public'`.
- **Statelessness.** No server-side session or cache is required by the
  protocol; all request handling is self-contained.

## 7. Protocol version

- Every API response (§5.2–§5.6) MUST carry the header
  `x-ashurbanipal-protocol: 1`.
- **Versioning policy**: adding an optional response field is still the
  same version. Anything else — removing or renaming a field, changing a
  type or serialization rule, changing a route or parameter's semantics —
  bumps the version. The policy applies to changes made *after* a version
  ships, measured from this document's shape forward.
- **v1 baseline**: v1 is the first protocol version ever emitted; nothing
  shipped a `x-ashurbanipal-protocol` header before it. The pre-spec
  reference's DSL-text `filter` parameter was an implementation detail,
  never a versioned wire contract, so v1 bakes in the JSON-AST filter
  representation (§5.4.2) as its baseline — there is no prior "v1 with
  DSL text" that the AST format bumped away from.
