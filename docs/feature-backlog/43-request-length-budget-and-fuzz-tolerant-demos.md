# Request length budget and fuzz-tolerant demos

> **Status:** OPEN · **Area:** spec, ports, conformance, frontend, infra

## 1. The ask

Bound the whole API query string with one shared budget, measured the same
way by every port, so a long request gets a clear 400 from Ashurbanipal
instead of a 414 or 431 from whatever HTTP server the host runs. Then make
every port's demo accept requests up to that budget, so the schemathesis
job stops failing at random.

## 2. Why

### The schemathesis job on Node fails about 1 run in 8

Found 2026-10-19:

- Every Node failure in CI (runs 34750112287 and 38144404690) was
  `Received: 431` on `GET /tables/data`. Run 38539082592 was a real missing
  route, not this.
- 30 local runs against the Node demo, each with an empty `.hypothesis/`
  folder: 4 failed, all with 431. The same 30 runs against the Rust axum demo:
  none failed.
- Node refuses a request line plus headers over 16 KB
  (`http.maxHeaderSize` = 16384) before Ashurbanipal sees it. The spec
  documents only 200, 400 and 500, so schemathesis reports the 431 as a
  failure. It is seed-dependent, not a race.
- Locally, the failure becomes permanent after the first hit: schemathesis
  saves the failing example in `.hypothesis/` in the working directory and
  replays it on every later run. CI starts clean, so there it looks random.

### It is also a contract bug, not only test noise

`spec/protocol.md` §5.4.2 and §5.11.1 bound `filter` and `join` at 8192
bytes of URL-decoded JSON. Percent-encoding makes JSON about 1.6× longer for
ASCII and 3× longer for non-ASCII, so a value inside the bound can make a
URL of 13–25 KB. Measured against the Node demo:

| Request | Decoded | URL | Node |
|---|---|---|---|
| ASCII filter, 16,000 characters | 16 KB | 16.1 KB | 400 |
| ASCII filter, 17,000 characters | 17 KB | 17.1 KB | 431 |
| `é` × 2,600 as UTF-8 | 5,233 B | 15.7 KB | 400 |
| `é` × 4,000 as UTF-8 (inside the bound) | 8,033 B | 24 KB | 431 |

No host is guaranteed to carry that. RFC 9110 §4.1 only recommends
supporting URIs of at least 8,000 octets; nginx answers 414 once the request
line passes its 8 KB buffer, and Tomcat's default header limit is 8 KB.

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
  list, or one that selects whole tables, stays near 600 B.
- **Replaces** the 8192-byte decoded bounds on `filter` and `join`. The
  structural limits stay: 10 conditions, 4 tables, 3 pairs per `ON`.

### Why one shared budget and not a limit per parameter

The URL's total length is what breaks. A shared budget lets a join with no
column list leave almost 6.5 KB for the filter, and lets a wide join use most
of it with a short filter. It also covers parameters a per-parameter limit
would miss. The cost: whether a filter fits depends on the rest of the
request, so a filter that works on a table can be refused on a join of that
table. The frontend's pre-check (below) makes that visible before sending.

### Spec

- `spec/protocol.md`: the budget, the measure and `request_too_long` in §2
  (error codes) and a new short section referenced from §5.4.2 and §5.11.1;
  remove the two 8192-byte bounds.
- `spec/openapi.yaml`: add `request_too_long` to the problem codes; update
  the `filter` and `join` descriptions.
- `spec/CHANGELOG.md`.
- **Breaking for `filter`:** the 8192-byte decoded bound has been released.
  An ASCII filter of about 4.5 KB or more decoded will now be refused.
  Decide the protocol version bump before starting. `join` is not released
  yet if this lands before it is.

### Ports

One shared helper per port (`encoded_len` or the local idiom) and one check
at the top of each route, replacing the two existing bound checks:

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
- Check before every data request. Replace the join-only check at
  `bootstrap/controller.ts` (`JOIN_MAX_BYTES`) with this one. Message names
  the cause: "This filter and join together are too long. Shorten the filter
  or untick some columns." On a table view: "This filter is too long."
- Handle `request_too_long` from the server with the same message, for
  clients that skip the pre-check.
- Update the limits in `features/api-reference.ts` (`max_json_bytes`).
- The filter text's own 1024-byte cap (`lib/filter-dsl.ts`) stays.

### Demos that tolerate schemathesis

The budget makes Ashurbanipal refuse long requests itself, but the fuzzer
can still send a URL longer than a demo's HTTP server accepts, and that
server answers 414 or 431 before Ashurbanipal runs. Every demo must accept at
least 64 KB of request line plus headers, so Ashurbanipal's 400 is what the
fuzzer sees. The longest fuzzed URL seen so far was about 24 KB.

| Port | Demo change | Default today |
|---|---|---|
| Node | `demo/main.ts`: `http.createServer({ maxHeaderSize: 65536 }, app).listen(…)` in place of `app.listen` | 16 KB, answers 431 |
| Spring | demo `application.yml`: `server.max-http-request-header-size: 64KB` | 8 KB (Tomcat); check whether it answers 400 or 431, and whether a 7,168-byte query plus normal headers fits today |
| Flask | check the server the demo and CI use and its request-line limit | not measured |
| Go | none expected (`net/http` default is 1 MB); confirm | 1 MB |
| Rust axum, actix | none expected; confirm | not hit in 30 runs |

These are demo settings only. Hosts own their servers, so each port's
README states the requirement: allow at least 8 KB of request line, which
the budget guarantees is enough.

Also in `conformance/runner/schema-check.sh`: stop `.hypothesis/` replay from
making local runs fail forever after one hit. Either run schemathesis from a
fresh temporary directory or pass its option that disables the example
database (check the flag name for the pinned schemathesis version).

## 4. Open questions

- Protocol version bump for the `filter` change: minor or major?
- Is 7,168 right, or should the budget leave more room for long mount
  prefixes and cookies on the host?
- Does Tomcat answer an oversize request with 400 or 431? A 400 would have
  hidden this bug on Spring.

## 5. Tests

- **Conformance** (`conformance/runner/`):
  - a query just under the budget is not refused for length;
  - just over → 400 `request_too_long`;
  - non-ASCII counts 3 per byte: `é` × 1,300 in `filter` (about 7.8 KB
    encoded, 2.6 KB decoded) → `request_too_long`;
  - a short filter plus a long join, and the reverse, both over → refused;
  - a long `table` value → `request_too_long`, not `unknown_table`;
  - update `P5.4.2-OVERSIZE-BOUND` and `P5.11-JOIN-BOUND` in `COVERAGE.md`.
- **Schemathesis:** 30 runs against the Node demo, each from a fresh
  directory, all pass (today 4 of 30 fail). Repeat once for Spring and Flask.
- **Frontend unit:** `encodedLength` against the spec's rule.
- **Playwright:** a filter plus join over the budget shows the message and
  sends no request; a server `request_too_long` shows the same message.
