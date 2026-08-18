# Ashurbanipal Protocol — v1

Status: normative, but a work in progress — subject to change at any time.
Companions: `spec/openapi.yaml` (machine-readable shapes),
`spec/filter-dsl.md` (the frontend's filter grammar), `docs/design.md`
(rationale and history — non-normative), `docs/adapter-decisions.md`
(per-backend mechanism for each clause below that names a property
without prescribing how a specific database engine satisfies it —
non-normative, but read it before porting to a non-Postgres engine).

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
- **Resolved schema** — the namespace of tables one operation browses, for
  engines that have a schema concept above a single database. Every
  route that takes a `schema` parameter (§5.2–§5.5) resolves it the same
  way:
  - **Absent** — resolves to the connection's own default (on Postgres:
    `current_schema()`).
  - **Present** — MUST match an entry from §5.7's live list exactly
    (case-sensitive); otherwise 400. An implementation MUST NOT accept a
    schema name that hasn't been validated against that same live list,
    whether the name came from the request or from resolving the
    connection's default.
  All table listing, validation, metadata, and data queries for one
  operation MUST be scoped to that operation's resolved schema, never
  hardcoded to a default such as `public`. An operation that performs
  multiple queries to produce one response (such as `/tables/data` or
  `/tables/common-values`) MUST resolve the schema once and use that same
  resolved value for every query in the operation, even when its
  connection pool uses sessions with different `search_path` settings.
  Engines with no schema concept above a single database (e.g. SQLite)
  satisfy this trivially — see `docs/adapter-decisions.md`.

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
- Every API response (§5.2–§5.7), success or error, MUST carry the
  protocol version header (§7).

## 3. Mount contract

- The UI is served at `{mount}`; the six API routes live at
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

- Configuration MUST expose a single on/off switch, and it MUST default to
  off: absent, empty, or malformed configuration MUST result in disabled,
  never enabled.
- An implementation MUST NOT infer or police which environment the host
  process is running in (by name, hostname, or any other signal). Where
  and whether to enable the viewer is entirely the host's decision.
- When disabled, all seven routes MUST behave exactly as if the viewer
  were never mounted: 404, indistinguishable from an absent
  implementation.
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

Lists the base tables of the resolved schema (§1). This list is also the
allow-list every other route validates `table` parameters against, scoped
to that same resolved schema.

| Param    | Required | Rules                                             |
|----------|----------|----------------------------------------------------|
| `schema` | no       | See §1's resolution rules; unrecognized value → 400. |

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

Approximate row counts for every table in the resolved schema (§1).

| Param    | Required | Rules                                             |
|----------|----------|----------------------------------------------------|
| `schema` | no       | See §1's resolution rules; unrecognized value → 400. |

Response:

```json
{ "counts": [{ "table": "users", "approx_rows": 108234 }] }
```

- `approx_rows` MUST come from the cheapest mechanism the engine offers for
  a whole-table cardinality figure, and MUST NOT cost a full table scan
  when the engine maintains a catalog estimate that avoids one (on
  Postgres: `pg_class.reltuples`, never `COUNT(*)`). It MAY be stale, and
  MAY be `-1` either for a table the engine has no estimate for yet (e.g.
  never analyzed or vacuumed) or for an engine that maintains no such
  estimate mechanism at all — clients MUST tolerate both. An engine with no
  such catalog MAY return `-1` unconditionally rather than pay a full-table
  scan to produce an exact count — see `docs/adapter-decisions.md` for the
  per-backend choice.

### 5.4 `GET {mount}/api/tables/data`

Paginated, filtered, sorted rows for a single table.

| Param    | Required | Rules                                                         |
|----------|----------|---------------------------------------------------------------|
| `schema` | no       | See §1's resolution rules; unrecognized value → 400.          |
| `table`  | yes      | MUST match a table from §5.2 (resolved against the same `schema`) exactly (case-sensitive); otherwise 400. |
| `filter` | no       | URL-encoded JSON AST, see §5.4.2.                             |
| `limit`  | no       | Clamped, never an error — see below.                          |
| `offset` | no       | Clamped, never an error — see below.                          |
| `sort`   | no       | Single column name; MUST be validated against the table's real columns; unknown column → 400. |
| `order`  | no       | `asc` \| `desc`, default `asc`; any other value → 400.        |

- **`limit` clamping**: the effective limit is the requested value clamped
  to `[1, max_page_size]` (`max_page_size` is configuration; reference
  default 100; default when the param is absent is `default_page_size`,
  reference default 50). Out-of-range values MUST be clamped, never
  rejected.
- **`offset` clamping**: the effective offset is the requested value
  clamped to a minimum of 0 (no upper bound — an offset beyond the
  table's row count is valid and simply yields zero rows, not an error or
  a second clamp point). Out-of-range values (negative, or larger than
  the implementation's integer type can represent) MUST be clamped, never
  rejected, same as `limit`.
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

- `key` — `"pk"` or `"fk"`. A column that is simultaneously its own
  table's primary key *and* a foreign key (the 1:1 "detail table" shape,
  e.g. `order_extra.order_id integer primary key references orders(id)`)
  reports `key: "pk"` — primary-key-ness wins the single-value field —
  but see `references` below, which is populated regardless.
- `references` — `{table, column}`, present whenever the column is a
  foreign key, independent of what `key` reports (so it MUST be present
  for `key: "fk"`, and MAY also be present alongside `key: "pk"` for a
  PK+FK column). Plus an optional `schema`: present only when the
  referenced table lives in a schema other than the referencing column's
  own (a cross-schema FK); omitted for the common same-schema case. Both
  of these are additive relaxations of an already-optional field, so
  existing clients that ignore `references` when `key` isn't `"fk"` see
  no change (§7 versioning policy — additive, no version bump).
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
  table; client-supplied text is never used as an operator. The wire-level
  operator set (§5.4.2's list) is fixed regardless of engine; an engine
  MAY map two distinct wire operators to the same SQL fragment when its
  native semantics already collapse them (e.g. `ILIKE`, meaning
  case-insensitive `LIKE`, may map to plain `LIKE` on an engine whose
  `LIKE` is already case-insensitive) as long as the *observable* behavior
  each operator promises still holds — see `docs/adapter-decisions.md`.
- Each `value` MUST be bound as a query parameter, never concatenated
  into SQL text.
- Comparison is applied to the column cast to text in the query itself
  (Postgres: `column::text OP $n`; see `docs/adapter-decisions.md` for
  other engines' cast syntax), so one filter works uniformly across
  `uuid`, `timestamptz`, `jsonb`, etc. Known consequence: `>`/`<`/`>=`/`<=`
  are lexicographic, wrong for numerics (`"10" < "9"`) — deliberate v1
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
numerics, timestamps, `jsonb`: all strings (the engine's own text
rendering, i.e. the result of casting the column to text *in the query*).
SQL `NULL` is JSON `null`. A value that cannot be decoded as text MUST be
replaced by the sentinel string `"<undecodable>"` rather than failing the
request.

A port that returns JSON numbers for numeric columns is **non-conformant**
— the frontend's type-aware rendering keys off column *type metadata*
(§5.4.1), not JSON value types.

The text cast MUST happen in the query text itself (each engine's own cast
syntax — see `docs/adapter-decisions.md`), not by decoding a column into a
native type and then formatting it in application code. An engine's own
cast is locale- and timezone-independent; a driver-level
decode-then-restringify step can silently diverge from it (e.g. a JVM
default locale using `,` as a decimal separator, or a timestamp formatted
without the engine's own timezone-offset suffix) while still technically
satisfying "every value is a JSON string" — the shape is right but the
*content* drifts from what every other implementation renders for the same
row. This applies to every column-value read (`/tables/data`'s rows,
`/tables/common-values`'s `value` field), not just numerics.

#### 5.4.4 `total_approx`

- MUST be the same whole-table cardinality figure as §5.3's `approx_rows`
  for this table (same mechanism, same per-backend trade-offs — see
  `docs/adapter-decisions.md`).
- MUST NOT be affected by `filter` (it is not a filtered count).
- MAY be stale, and MAY be `-1` either when the engine has no estimate yet
  (on Postgres: before the table's first ANALYZE/VACUUM) or when the engine
  maintains no such estimate mechanism at all.

### 5.5 `GET {mount}/api/tables/common-values`

Most-common values for one column, from planner statistics.

| Param    | Required | Rules                                             |
|----------|----------|---------------------------------------------------|
| `schema` | no       | See §1's resolution rules; unrecognized value → 400. |
| `table`  | yes      | Validated against §5.2's list (resolved against the same `schema`); unknown → 400. |
| `column` | yes      | Validated against the table's real columns; unknown → 400. |

Response:

```json
{ "values": [{ "value": "active", "freq": 0.62 }, { "value": "closed", "freq": 0.31 }] }
```

- Values SHOULD come from pre-computed catalog/planner statistics where the
  engine maintains them (on Postgres:
  `pg_stats.most_common_vals`/`most_common_freqs`) — never an unbounded
  `SELECT DISTINCT`. An engine with no such statistics MAY compute
  frequencies via a bounded, capped aggregate query instead, as a
  documented per-backend trade-off (see `docs/adapter-decisions.md`) —
  the cap MUST still be applied, and the query MUST remain subject to
  §6's timeout invariant like any other query.
- A column with no statistics available (never analyzed, or all-unique)
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

### 5.7 `GET {mount}/api/schemas`

Lists the schema names selectable as the `schema` parameter on §5.2–§5.5.
This is the live allow-list §1's "present" case validates against.

Response:

```json
{ "schemas": ["public", "reporting"] }
```

- MUST list every schema §1's default-resolution case could ever resolve
  to, so the implicit and explicit paths never diverge on what counts as
  valid — an implementation MUST NOT accept, via either path, a schema
  this list doesn't contain.
- MUST exclude the engine's own system/internal namespaces (on Postgres:
  `pg_catalog`, `information_schema`, and any `pg_toast`/`pg_temp`
  namespace) — this route lists browsable schemas, not every namespace
  the engine happens to expose.
- SHOULD exclude any schema the connected role cannot access, so nothing
  offered here would be rejected by §5.2–§5.5's schema check for lack of
  privilege.
- Engines with no schema concept above a single database (e.g. SQLite)
  MUST return exactly one entry — see `docs/adapter-decisions.md`.
- Schemas SHOULD be returned in a stable order (the Rust implementation
  sorts by name).

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
- **Single-table data queries.** A data response MUST retrieve rows from
  exactly one browsed table and MUST NOT combine user rows from multiple
  tables. FK navigation in the UI is two sequential single-table queries.
  Catalog and metadata queries MAY join system catalogs when needed to
  satisfy this protocol.
- **Schema scoping.** Every catalog and data query MUST be scoped to the
  operation's resolved schema (§1), not a hardcoded default such as
  `'public'`, and MUST reject a `schema` value that isn't on §5.7's live
  list before it reaches SQL text — same allow-list-before-splice
  discipline as this section's first bullet, applied to schema names, not
  just table/column names. On engines with no schema concept this is
  trivially satisfied — see `docs/adapter-decisions.md`.
- **Statelessness.** No server-side session or cache is required by the
  protocol; all request handling is self-contained.

## 7. Protocol version

- Every API response (§5.2–§5.7) MUST carry the header
  `x-ashurbanipal-protocol: 1`.
- **Versioning policy**: adding an optional response field, an optional
  request parameter, or a wholly new route is still the same version —
  none of these change what an existing caller that ignores them
  observes. Anything else — removing or renaming a field, changing a
  type or serialization rule, changing an *existing* route or parameter's
  semantics — bumps the version. The policy applies to changes made
  *after* a version ships, measured from this document's shape forward.
  §5.7 and the `schema` parameter on §5.2–§5.5 are the first instance of
  this: purely additive, so v1 stands.
- **v1 baseline**: v1 is the first protocol version ever emitted; nothing
  shipped a `x-ashurbanipal-protocol` header before it. The pre-spec
  reference's DSL-text `filter` parameter was an implementation detail,
  never a versioned wire contract, so v1 bakes in the JSON-AST filter
  representation (§5.4.2) as its baseline — there is no prior "v1 with
  DSL text" that the AST format bumped away from.
