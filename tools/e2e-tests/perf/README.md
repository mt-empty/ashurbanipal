# Start-up timing experiment

Measures how long the page takes to show rows, under simulated network and
server delay, so a start-up or prefetch change can be compared with the
baseline it replaces. By default it simulates the usual deployment: HTTPS
over HTTP/2, on a VPN in the same region, in another region, and on a poor
link.

```sh
mise run frontend:perf                                  # every profile, 20 runs per cell
PERF_RUNS=5 PERF_NETWORKS=same-region,cross-region mise run frontend:perf
PERF_LABEL=after-change PERF_GZIP=1 mise run frontend:perf
node perf/compare.mjs perf-results/startup-before-….json perf-results/startup-after-change-….json
```

| Variable | Effect |
|---|---|
| `PERF_RUNS` | Runs per cell (default 20) |
| `PERF_NETWORKS` | Comma-separated subset of `local`, `same-region`, `cross-region`, `poor` (default: all but `local`) |
| `PERF_LABEL` | Names the run in its file name and heading |
| `PERF_GZIP=1` | The proxy gzips JSON and a `PERF_PAGE` page, standing in for a host that compresses its API responses. The demo gzips its own page (`spec/protocol.md` §5.1), so the page arrives compressed either way |
| `PERF_HTTP1=1` | Plain HTTP/1.1 with no TLS, instead of HTTPS + HTTP/2 |
| `PERF_PAGE` | Serve this saved page build instead of the demo's own, so builds can be compared on one backend without rebuilding it |

Results go to `perf-results/startup-<label>-<time>.{json,md}`
(git-ignored). The Markdown file is the summary table; the JSON file keeps
every sample. `perf/compare.mjs` prints the median change per cell between
two JSON files, with the API request count before and after.

## What it measures

The page sets User Timing marks (`frontend/src/core/perf-marks.ts`):
`ashurbanipal:scope-settled`, `tables-listed`, `load-start` and
`rows-rendered`, the last two tagged with why the load ran.

| Scenario | Start | End |
|---|---|---|
| S1 fresh visit (no URL state, empty storage) | navigation | `rows-rendered` |
| S2 deep link (`?schema=warehouse&table=shipment_events`) | navigation | `rows-rendered` |
| S3 reload of S2 | navigation | `rows-rendered` |
| S4 click the `shipments` chip | the click | `rows-rendered` |
| S5 Next page (page 1 → 2) | the click | `rows-rendered` |
| S7 Next page again (page 2 → 3) | the click | `rows-rendered` |
| S6 the browser's Back (page 3 → 2) | `popstate` | `rows-rendered` |
| S8 rest the pointer on the `carriers` chip for 300 ms, then click | the click | `rows-rendered` |

S4's click comes straight after the pointer arrives, so it measures a
switch with no hover time; S8 measures the same switch with some.

Each row also gives when the last API response arrived, on the same clock,
so the gap to "rows rendered" is the page's own work. For start-up it counts
the API requests that ran before the rows rendered, and the waves among
them: a request that waited for every earlier one to finish starts a new
wave. `/api/siblings` is left out; it never delays the grid.

## How it simulates delay

- **Round trip and server time:** `perf/delay-proxy.ts` sits between the
  browser and the demo and holds each request before passing it on: the
  network's round trip for every request, plus `catalogMs` for catalog
  routes or `dataMs` for `/tables/data` and `/tables/join`.
- **Connections:** the first request on a new connection also pays its
  handshake: two round trips over HTTPS (TCP, then TLS 1.3), one over plain
  HTTP/1.1. Over HTTP/2 every request shares the page's one connection;
  over HTTP/1.1 parallel requests open more, up to six.
- **Certificate:** `perf/tls.ts` makes a self-signed certificate once
  (`perf-results/tls/`, needs `openssl`), and Chromium is started trusting
  that one key, the way a company's users trust its CA. It is trusted, not
  ignored, so Chromium's HTTP cache stays on.
- **Bandwidth:** Chromium's own throttling
  (`Network.emulateNetworkConditions`). Its latency setting is left at 0:
  Chromium treats it as a minimum time to response headers, so server time
  would overlap it instead of adding to it.
- Each run uses a new browser context, so storage, HTTP cache and
  connections start cold. Run 0 of each cell is a warm-up and is dropped.

## Limits

- Chromium only. TLS session resumption and HTTP/3 are not modelled.
- Server time is a fixed delay per route. It does not grow with the number
  of database queries, and it does not model a busy connection pool.
- Seed-sized tables: deep offsets and unindexed sorts on large tables are
  not exercised.
- The first test checks that every request takes at least its round trip
  plus its server time; if it fails, no timing is recorded.
