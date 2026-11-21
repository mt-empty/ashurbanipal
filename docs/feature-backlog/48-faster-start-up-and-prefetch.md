# Faster start-up and prefetch, from measured timings

> **Status:** DONE · **Area:** frontend, ports, docs · **Ref:** PR #221; a `/bootstrap` route and minification not pursued

**Ask:** make the page quick to start, and use prefetch where it pays,
decided from measurements. Same-region and cross-region links matter most;
a poor link is a reference point, and heavy database load is out of scope.

## What shipped

- Start-up sends `/sources`, `/schemas`, `/tables`, `/table-counts` and
  `/tables/data` together. An early answer is used only when it matches the
  scope start-up settles on (story 45, "Send both on every request").
- A browser Back or Forward step that stays in one source and schema keeps
  the table list and fetches only the data.
- Page one of a table is prefetched when the pointer rests on its chip
  (mouse only: keyboard focus does not prefetch, so tabbing past chips sends
  no queries). The next page is prefetched once the user has paged.
- Every port sends the page gzipped when the request accepts it.
- `mise run frontend:perf` measures start-up and view switches under
  simulated network and server delay. `tools/e2e-tests/perf/README.md` owns
  the method; the page's timing marks are in `frontend/src/core/perf-marks.ts`.

## Not pursued

Measured, then left out. Revisit only with new numbers.

- **A combined `/bootstrap` route** (sources, schemas and tables in one
  response). Over HTTPS + HTTP/2 it matched the shipped start-up to the
  millisecond and needs a protocol change in five ports.
- **Minifying the page** (`minify: false` in `frontend/bundle-options.mjs`):
  0–5% faster start-up on top of gzip.
- **`ETag` or `Cache-Control` on the page.** The page URL is fixed, so a
  cached copy still costs a revalidation round trip; gzip gets most of the
  saving.
- **Dropping the view transition** to save its one frame (~17 ms). The
  saving is below what users notice.
- **Prefetch on FK cells, every chip, common values or joins.** Low hit
  rate, real database cost, and a join can run up to the query timeout.
- **A service worker.** It needs a separate script file, which breaks the
  single-file page (`CLAUDE.md`), and risks stale data.
