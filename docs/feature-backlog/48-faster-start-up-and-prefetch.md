# Faster start-up and prefetch, from measured timings

> **Status:** PARTIAL · **Area:** frontend, ports, docs · **Ref:** 4.1 (full version), 4.3, 4.4 (mouse hover only) and 4.5 shipped with the timing marks and `mise run frontend:perf`; 4.2 compression and minification undecided

## 1. The ask

Make the page quick to start, and use prefetch where it pays. Decide
from measurements, not guesses. Most users have a good connection, so
same-region and cross-region links matter most. A poor link is a
reference point, not a target. Heavy database load is out of scope: a
development database is rarely busy.

## 2. How it was measured

`mise run frontend:perf` runs the experiment in
`tools/e2e-tests/perf/` (its `README.md` has the method and limits). In
short:

- The page sets User Timing marks (`frontend/src/core/perf-marks.ts`).
  `ashurbanipal:rows-rendered` carries why the load ran: boot, chip,
  page, history, refresh, auto or other.
- A delay proxy adds the network round trip to every request, one more
  round trip for the first request on a new connection, and simulated
  server time: 20 ms per catalog call and 150 ms per data call in the
  "typical" profile. Chromium throttles bandwidth only.
- 20 runs per cell after a warm-up, release build of the axum demo,
  Chromium 156, seed database.

Two traps were found and fixed while building it:

- Chromium's own latency setting is a *minimum* time to response
  headers, not an added delay, so simulated server time hid inside it.
  The round trip now comes from the proxy, and a sanity test fails the
  run if round trip and server time don't add up.
- Without a cost for opening a connection, firing requests in parallel
  would look better than it is. The proxy now charges the TCP handshake.

Not modelled: TLS handshakes, HTTP/2, large tables.

## 3. Findings

Baseline of 2026-10-28, medians in ms. Networks: local (0 ms),
same-region (20 ms, 50 Mbps), cross-region (100 ms, 20 Mbps). Server:
no delay, or typical.

Start-up from a deep link (S2), from navigation start:

| Network | Server | Page downloaded | Scope settled | Table list | Last API response | Rows shown |
|---|---|---|---|---|---|---|
| local | no delay | 2 | 35 | 39 | 43 | 59 |
| local | typical | 2 | 64 | 87 | 241 | 258 |
| same-region | no delay | 84 | 142 | 165 | 191 | 209 |
| same-region | typical | 84 | 180 | 224 | 400 | 429 |
| cross-region | no delay | 306 | 529 | 634 | 742 | 773 |
| cross-region | typical | 306 | 564 | 690 | 949 | 973 |

A fresh visit (S1) and a reload (S3) are within 30 ms of S2, except
that a reload reuses its connections and saves one handshake.

View switches, from the user's action to rows shown:

| Network | Server | Chip (S4) | Next page (S5) | Back (S6) |
|---|---|---|---|---|
| local | no delay | 47 | 47 | 27 |
| same-region | no delay | 46 | 47 | 75 |
| same-region | typical | 197 | 198 | 241 |
| cross-region | no delay | 132 | 130 | 241 |
| cross-region | typical | 284 | 279 | 409 |

What the numbers say:

1. **Start-up waits on four request waves in a row.** `/sources`, then
   `/schemas`, then `/tables` with `/table-counts`, then
   `/tables/data` (`bootstrap/main.ts:83-93`,
   `features/table-chips.ts:139`). Each waits for the one before, even
   when the URL already names the schema and table. At cross-region
   the waves take about 440 of the 773 ms.
2. **The page itself is the next biggest cost.** 255 KB, sent
   uncompressed by every port and demo host (about 69 KB gzipped).
   It takes 306 ms to arrive at cross-region, and most of a poor
   link's 3.2 s start-up.
3. **A click has a floor of about 45 ms** before rows show, whatever
   the network. About 17 ms is the view transition waiting one frame
   (`bootstrap/controller.ts:319`); with transitions off a chip switch
   drops to 29 ms. The rest is the browser lining up with its frames
   after input. So prefetch only pays where the network plus server
   time is well above 45 ms.
4. **Back re-fetches the table list** even when the scope is unchanged
   (`features/view-history.ts:113`): two waves, three requests. That is
   why Back is slower than a chip click.
5. **Server time adds straight on.** The typical 150 ms data call adds
   about 150 ms to every start-up and every switch.

## 4. Recommendations, in order

Each saving below is an estimate from the measured phases. The
experiment must confirm it before the change ships.

### 4.1 Start every start-up request at once

Send `/sources`, `/schemas`, `/tables`, `/table-counts` and
`/tables/data` together, using the scope and view the URL or storage
names. An absent `source` or `schema` already means the default
(`spec/protocol.md` §1).

- **Saves:** about 200 ms of 773 at cross-region, about 35 ms of 209 at
  same-region. Start-up becomes one wave after the page, plus one
  handshake for the extra connections.
- **Cost:** frontend only, no protocol change.
- **Care:**
  - An early response counts only if the scope that is finally
    resolved matches the one it asked for; otherwise it is dropped and
    the normal chain runs (R5).
  - A connection with no default schema answers 400 `unknown_schema`
    to a request without one (`spec/protocol.md` §1;
    `state.noDefaultSchema`, `core/store.ts:18`); that request is then
    wasted, not harmful.
  - A failed `/table-counts` currently loses the table list too,
    because both share one `Promise.all` (`table-chips.ts:139`). Fix
    that in the same change: counts are optional.

### 4.2 Compress the page

The page is the same 255 KB on every start-up. Gzip brings it to about
69 KB.

- **Saves:** about 30 ms at same-region, about 75 ms at cross-region,
  about 1 s on a poor link.
- **Cost:** small. The library is mounted inside the host's app, so
  compression is usually the host's middleware or proxy. Measure first
  by letting the delay proxy gzip the page. Then decide between a host
  note in each port's README and compressing the UI route in each port.
- **Care:** no doc mentions compression today.

### 4.3 Reuse the table list on the browser's Back and Forward

When a history step (the browser's Back or Forward; the app has no
buttons of its own) stays in the same source and schema, keep the
table list already on screen and fetch only the data.

- **Saves:** about 110 ms at cross-region (241 → about 130), about
  28 ms at same-region.
- **Cost:** small, frontend only.
- **Care:** the counts can be slightly stale; Refresh still reloads
  everything (R10).

### 4.4 Prefetch a table on chip hover or focus

Fetch page one when the pointer rests on a chip or the chip gets
keyboard focus, and use it if the click follows soon.

- **Saves:** at most the network plus server part of a switch: about
  240 of 284 ms at cross-region with a typical server, but nothing at
  same-region with a fast server (the 45 ms floor). The real saving
  depends on how long the pointer rests before the click.
- **Cost:** medium. A small cache that Refresh and auto-refresh clear,
  held only a few seconds, never shown as fresh data (R10). No hover on
  touch screens.
- **Care:** each hover is a query on the host's pool. Add a "hover,
  then click" scenario to the experiment first, with a realistic wait.

### 4.5 Prefetch the next page, but only once the user pages

After the first Next click, fetch the page after the one shown.

- **Saves:** like 4.4, only on slow servers or links.
- **Cost:** medium, and it doubles queries while paging. Deep offsets
  are the slow case on big tables.
- **Care:** use it only if filter, sort and scope are unchanged; drop it
  on Refresh and on every auto-refresh tick.

## 5. Not recommended now

- **One combined `/sources` + `/schemas` + `/tables` endpoint.** It
  saves two waves but needs a protocol change in five ports.
  Recommendation 4.1 saves more without one. Revisit only if
  server-side scope resolution is wanted for its own sake.
- **`ETag` or `Cache-Control` on the page.** The page URL is fixed, so
  a cached copy still needs one revalidation round trip. Compression
  (4.2) gets most of the transfer saving for less work.
- **Dropping the view transition** to save its ~17 ms frame. It is part
  of the designed feel (R15); the saving is below what users notice.
- **Prefetch on FK cells, every chip, every column's common values, or
  joins.** Low hit rate, real database cost, and joins can run up to
  the query timeout.
- **A service worker.** It needs a separate script file, which breaks
  the single-file page (`CLAUDE.md`), and risks stale data.

## 6. Measured results (2026-10-28)

All five were built and measured one at a time, each on top of the last,
with the experiment of §2. The experiment gained two scenarios for this:
S7, a second Next (page 2 → 3), and S8, the pointer resting 300 ms on a
chip before the click. The baseline was re-taken with them. Medians in
ms; `node perf/compare.mjs` gives every cell.

**4.1 start-up requests together, two versions.**

- *Full*: everything goes out at once, before the scope is known, with
  the server's own defaults deciding whether an answer matches. It
  breaks story 45's rule that every request names a resolved source and
  schema, and two specs that hold that rule
  (`scope-params.spec.ts`, `loading-and-errors.spec.ts`).
- *Rule-keeping*: waits for `/sources`, then sends the rest together,
  naming the confirmed source and the schema the URL or storage names.
  It keeps the source rule, but sends that schema before `/schemas` has
  confirmed it; story 45 sends only resolved names when `/schemas`
  fails, and no spec covers that case. Every spec passes. A fresh visit,
  which names no schema, gains nothing.
- The full version is kept as a patch against the rule-keeping tree:
  `tools/e2e-tests/perf-results/variant-4.1-full.patch` (git-ignored).

| Scenario | Network | Baseline | Full | Rule-keeping |
|---|---|---|---|---|
| Fresh visit | same-region | 197 | 179 | 212¹ |
| Fresh visit | cross-region | 746 | 646 | 746 |
| Deep link | same-region | 208 | 174 | 191 |
| Deep link | cross-region | 758 | 558 | 643 |
| Reload | same-region | 188 | 121 | 138 |
| Reload | cross-region | 655 | 339 | 439 |

¹ One display frame later, not slower: the last API response is
unchanged (191 → 192 ms); both runs land on either of two frames.

Neither version sends more requests. The steps below were stacked on the
rule-keeping version.

**4.3 Back/Forward keeps the table list.** Back goes from 3 requests to 1:
76 → 46 at same-region, 240 → 131 at cross-region, 407 → 276 at
cross-region with typical server time.

**4.4 hover prefetch, 4.5 next-page prefetch.** Each switch still sends
one request; it just leaves before the click.

| Scenario | Network | Server | Before | After |
|---|---|---|---|---|
| S8 hover, then chip | same-region | no delay | 38 | 38 |
| S8 hover, then chip | same-region | typical | 188 | 38 |
| S8 hover, then chip | cross-region | no delay | 121 | 38 |
| S8 hover, then chip | cross-region | typical | 272 | 55 |
| S7 second Next | same-region | no delay | 44 | 45 |
| S7 second Next | same-region | typical | 194 | 45 |
| S7 second Next | cross-region | no delay | 127 | 44 |
| S7 second Next | cross-region | typical | 275 | 43 |

A plain chip click (S4) and the first Next (S5) are unchanged, as
designed.

**4.2 gzip** (simulated by the proxy, no port change), on top of all of
the above: start-up a further 13–17% faster at same-region (deep link
189 → 157), 9–18% at cross-region (658 → 575), and about 1 s on the poor
link.

**Everything together**, against the baseline:

| Scenario | same-region | cross-region | poor |
|---|---|---|---|
| Fresh visit | 197 → 176 | 746 → 678 | 3229 → 2245 |
| Deep link | 208 → 157 | 758 → 575 | 3275 → 1953 |
| Reload | 188 → 120 | 655 → 372 | 2969 → 1343 |
| Back | 75 → 47 | 240 → 124 | 706 → 341 |

Reading the numbers:

- Untouched scenarios move by about ±2 ms between runs.
- Render times are bimodal, one display frame (~16 ms) apart, so a
  median can jump by a frame with no real change; the last-API-response
  column separates network effects from that.
- Keyboard focus no longer starts a prefetch (removed 2026-10-29): tabbing
  at a normal pace rests on every chip it passes, one query each. A focus
  from a click had also asked for the table a second time.

Not measured:

- S8 always clicks after a 300 ms rest. A rest that ends without a click
  costs one wasted query; a shorter rest saves less.
- S7 counts the saving of next-page prefetch, not the wasted query when
  the user stops paging.

**HTTPS + HTTP/2** (2026-10-29), the usual deployment: a company domain
behind a VPN with a company-signed certificate. Measured in the worktree
`.claude/worktrees/bootstrap-endpoint` (branch `perf/bootstrap-endpoint`),
with the proxy serving HTTP/2 over TLS 1.3 and charging a new connection
two round trips (TCP, then TLS). Each variant is a saved page served to the
same axum backend:

- *full+bootstrap* adds an experimental axum-only `GET /api/bootstrap`
  (outside the spec) that answers `/sources`, `/schemas` and `/tables` in
  one response, resolving unlisted names to the defaults and reporting
  the names it used. Counts and rows stay separate requests.

| Scenario | Network | Server | Baseline | Rule-keeping | Full | Full + bootstrap |
|---|---|---|---|---|---|---|
| Fresh visit | same-region | no delay | 227 | 228 | 180 | 192 |
| Fresh visit | same-region | typical | 432 | 430 | 360 | 374 |
| Fresh visit | cross-region | no delay | 848 | 848 | 644 | 644 |
| Fresh visit | cross-region | typical | 1062 | 1061 | 823 | 840 |
| Deep link | same-region | no delay | 240 | 191 | 174 | 174 |
| Deep link | cross-region | no delay | 864 | 657 | 558 | 557 |
| Deep link | cross-region | typical | 1073 | 824 | 707 | 706 |
| Reload | same-region | no delay | 189 | 138 | 122 | 122 |
| Reload | cross-region | no delay | 657 | 455 | 338 | 338 |
| Reload | cross-region | typical | 870 | 620 | 488 | 489 |

Start-up requests: 5, 5, 5 and 3. Back, Next and hover behave as over
HTTP/1.1 in every variant.

- **HTTPS costs one more round trip on a first visit.** The page arrives
  100 ms later at cross-region than over plain HTTP/1.1 (406 vs 306 ms),
  for the TLS handshake; a reload reuses the connection and matches.
- **The full version gains most:** 20–24% on a fresh visit, 27–35% on a
  deep link, 35–49% on a reload. The rule-keeping version gains nothing
  on a fresh visit, 21–24% on a deep link and 27–31% on a reload.
- **`/bootstrap` adds no speed.** Deep link and reload match the full
  version to the millisecond; a fresh visit with server time is 16 ms
  slower at the last response, because its two catalog reads run one
  after the other. Its gains are 2 fewer requests and one place that
  resolves the scope. With the experimental route, 8 existing specs fail:
  they intercept or count `/sources`, `/schemas` or `/tables`, or hold
  story 45's scope rule.
- Minifying the page (measured over HTTP/1.1): 4–12% faster start-up
  without gzip, 0–5% on top of gzip.

## 7. Next steps

1. Decided 2026-10-29: the full version of 4.1, with `/bootstrap` not
   pursued. Start-up's early requests are exempt from story 45's rule that
   every request names a resolved source and schema; an early answer is
   used only when it matches the scope start-up settles on.
   `scope-params.spec.ts` and `loading-and-errors.spec.ts` hold the rule
   for every request after start-up. 4.3, 4.4 (mouse hover only) and 4.5
   are kept.
2. Rerun the baseline (now HTTPS + HTTP/2 by default) so its results name
   a commit.
3. Decide on compression (4.2): a host note or port code. Minifying the
   page (built with `minify: false`, `frontend/bundle-options.mjs`) saves
   4–12% of start-up without gzip and 0–5% with it.
