# Request length budget

> **Status:** OPEN · **Area:** spec, ports, conformance, frontend, docs

## 1. The ask

Bound the whole API query string with one shared budget, measured the same
way by every port, so a long request gets a clear 400 from Ashurbanipal
instead of a 414, 431 or HTML 400 from whatever HTTP server the host runs.

## 2. Why

`spec/protocol.md` §5.4.2 suggests 8192 bytes of URL-decoded JSON for
`filter`, and §5.11.1 fixes the same bound for `join`. Percent-encoding
makes JSON about 1.6× longer for ASCII and 3× longer for non-ASCII, so a
value inside the bound can make a URL of 13–25 KB. Measured against the
Node demo with Node's default 16 KB header limit:

| Request | Decoded | URL | Node |
|---|---|---|---|
| ASCII filter, 16,000 characters | 16 KB | 16.1 KB | 400 |
| ASCII filter, 17,000 characters | 17 KB | 17.1 KB | 431 |
| `é` × 2,600 as UTF-8 | 5,233 B | 15.7 KB | 400 |
| `é` × 4,000 as UTF-8 (inside the bound) | 8,033 B | 24 KB | 431 |

No host is guaranteed to carry that. RFC 9110 §4.1 only recommends
supporting URIs of at least 8,000 octets. nginx answers 414 once the request
line passes its 8 KB buffer. Tomcat's 8 KiB default covers the request line
and every header, and it answers with its own HTML 400 (`PORTING.md`,
"Request-boundary rejections"; `docs/adapter-decisions.md`, "§5.4.2 —
request size limits").

### What real requests need

Measured with the frontend's parser and `URLSearchParams`:

| Request | Decoded JSON | Encoded |
|---|---|---|
| 10-condition filter on email addresses | 907 B | 1,457 B |
| 10-condition filter on Chinese text | 1,087 B | 2,777 B |
| 4-table join, no column list | 301 B | 577 B |
| 4-table join, 40 listed columns | 1,783 B | 3,029 B |
| 4-table join, 120 listed columns | 4,763 B | 7,929 B |

## 3. Design

### One budget for the whole query string

- **Bound:** the query string's encoded length MUST NOT exceed **7,168
  bytes**. That leaves about 800 bytes for the method, path, mount prefix and
  `HTTP/1.1`, under RFC 9110's 8,000.
- **Measure:** count from the decoded parameters, never the raw query
  string. For each `name=value` pair, count every UTF-8 byte of the name and
  value as 1 if it is an RFC 3986 unreserved character
  (`A–Z a–z 0–9 - . _ ~`) and 3 otherwise, plus 1 for each `=` and `&`. The
  result is the same for every client, whatever its encoder does, and no
  port needs raw query access.
- **Scope:** every `/api` route, not just the two with JSON parameters. A
  long `table`, `schema`, `sort` or `source` counts too.
- **Order:** check it first, before parsing any parameter, so an oversize
  request is never partly parsed.
- **Error:** 400 with a new code, `request_too_long`. Neither
  `invalid_filter` nor `invalid_join` fits when the two together are too
  long, and the frontend routes those two codes to different UI.
- **What it refuses:** a 4-table join listing about 110 or more columns
  (120 columns is 7,929 B above) no longer fits, even with no filter. The
  frontend message tells the user to untick columns. A join with no column
  list, or one that selects whole tables, stays near 600 B. An `IN` list of
  more than about 500 short values no longer fits either (each value costs
  about 14 encoded bytes); the frontend's 1,024-byte filter text cap already
  keeps its own lists far below that.
- **Replaces** the 8192-byte decoded bounds on `filter` and `join`. The
  structural limits stay: 10 conditions, 1,000 `IN` values, 4 tables, 3
  pairs per `ON`.

### Why one shared budget and not a limit per parameter

The URL's total length is what breaks. A shared budget lets a join with no
column list leave almost 6.5 KB for the filter, and lets a wide join use most
of it with a short filter. It also covers parameters a per-parameter limit
would miss. The cost: whether a filter fits depends on the rest of the
request, so a filter that works on a table can be refused on a join of that
table. The frontend's pre-check (below) makes that visible before sending.

### Spec

- `spec/protocol.md`: the budget, the measure and `request_too_long` in §2
  (the `code` list) and a new short section referenced from §5.4.2 and
  §5.11.1; remove the two 8192-byte bounds.
- `spec/openapi.yaml`: add `request_too_long` to the problem `code` enum;
  update the `filter` and `join` descriptions, and the comment on `IN`'s
  missing `maxItems`.
- `spec/CHANGELOG.md`.
- **Breaking for `filter` and `join`:** `join`'s 8192-byte bound is a MUST
  today, and `filter`'s is the suggested value every port uses. An ASCII
  filter of about 4.5 KB or more decoded, or a wide join (see "What it
  refuses"), will now be refused. §4 holds the version question.
- A normative number also gives `max_json_bytes` its home.

### Ports

One shared helper per port (`encoded_len` or the local idiom), checked once
at the API router's entry (an axum layer and an actix wrap over a `core/`
helper; middleware in Express, Flask, Spring and Go), so a new route can't
forget it. It replaces the two existing bound checks:

| Port | Where today |
|---|---|
| Rust core | `core/src/filter.rs` `MAX_FILTER_BYTES`, `core/src/join.rs` `MAX_JOIN_BYTES` |
| Go | `filter.go` `MaxFilterBytes`, `join.go` `MaxJoinBytes` |
| Node | `src/filter.ts` `MAX_FILTER_BYTES`, `src/join.ts` `MAX_JOIN_BYTES` |
| Flask | `ashurbanipal/filter.py` `MAX_FILTER_BYTES`, `ashurbanipal/join.py` `MAX_JOIN_BYTES` |
| Spring | `FilterValidator.kt` `MAX_FILTER_BYTES`, `JoinSupport.kt` `MAX_JOIN_BYTES` |

Unit tests per port: the count for ASCII, non-ASCII and unreserved
characters; just under and just over the bound.

### Frontend

- A pure `encodedLength(params: URLSearchParams)` in `frontend/src/lib/`,
  with unit tests that match the spec's counting rule.
- Check before every data request. Replace the join-only check in
  `bootstrap/controller.ts` (`JOIN_MAX_BYTES` from `lib/join-dsl.ts`) with
  this one. Message names the cause: "This filter and join together are too
  long. Shorten the filter or untick some columns." On a table view: "This
  filter is too long."
- Handle `request_too_long` from the server with the same message, for
  clients that skip the pre-check.
- Update `features/api-reference.ts`: `max_json_bytes` in the filter
  `limits`, the filter note on 8192 bytes, and the `join` parameter's
  "at most 8192 bytes".
- The filter text's own 1024-byte cap (`FILTER_MAX_DSL_BYTES`,
  `lib/filter-dsl.ts`) stays.

### Docs

Hosts own their HTTP servers, so:

- Each port's README states the host requirement: allow at least 8 KB of
  request line plus headers, which the budget guarantees is enough.
- The Spring known deviation goes away once the budget fits Tomcat's 8 KiB
  default. Update `PORTING.md` ("Request-boundary rejections"),
  `docs/adapter-decisions.md` ("§5.4.2 — request size limits") and the
  Spring README's "Large filters return Tomcat's own 400 page".

## 4. Open questions

- Protocol version bump for the `filter` change: minor or major?
- Is 7,168 right? Tomcat's 8 KiB covers headers too, so it leaves about
  1 KB for cookies and other headers. Should the budget leave more room for
  long mount prefixes and cookies on the host?

## 5. Tests

- **Conformance** (`conformance/runner/`):
  - a query just under the budget is not refused for length;
  - just over → 400 `request_too_long`;
  - non-ASCII counts 3 per byte: `é` × 1,300 in `filter` (about 7.8 KB
    encoded, 2.6 KB decoded) → `request_too_long`;
  - a short filter plus a long join, and the reverse, both over → refused;
  - one oversize query against every `/api` route → `request_too_long`,
    so a route that skips the gate fails; a long `table` value gives
    `request_too_long`, not `unknown_table`;
  - update `P5.4.2-OVERSIZE-BOUND` and `P5.11-JOIN-BOUND` in
    `conformance/runner/COVERAGE.md`.
- **Frontend unit:** `encodedLength` against the spec's rule.
- **Playwright:** a filter plus join over the budget shows the message and
  sends no request; a server `request_too_long` shows the same message.
