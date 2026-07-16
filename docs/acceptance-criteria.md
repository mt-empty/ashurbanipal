# v1 acceptance criteria

Status: agreed, pre-implementation
Derived from: `design.md` (scope), `filter-dsl.md` (parser test table)

The unambiguous stopping point for v1. Every item is checkable by running
something — no "feels done" criteria. When all boxes tick, v1 ships and
anything else goes through `design.md` §9 (deferred list).

## 1. Routes (the 4+1)

- [ ] `GET /__ashurbanipal` serves the embedded `dbviewer.html`
      (`include_str!` — verified by a test that the response body is
      non-empty HTML and the binary has no runtime file dependency).
- [ ] `GET /__ashurbanipal/api/tables` returns the seed database's tables
      (`users`, `orders`) from `information_schema`.
- [ ] `GET /__ashurbanipal/api/table-counts` returns `reltuples`-based
      approximate counts; against the freshly seeded dev db it reports the
      real counts (5/15), not `-1`.
- [ ] `GET /__ashurbanipal/api/tables/data` returns paginated, sorted,
      filtered rows with the `columns`/`rows`/`total_approx` shape from
      `design.md` §4.
- [ ] `GET /__ashurbanipal/api/siblings` returns the configured siblings
      with live health status.

## 2. Kill switch

- [ ] Routes return 404 (indistinguishable from "not mounted") when the
      current environment is not in `enabled_for`.
- [ ] All five routes are gated — including the HTML route.
- [ ] Config with a production-like value in `enabled_for` (`production`,
      `prod`, `PROD`, `Production`) **fails at startup**, not at request
      time. Test asserts the constructor/parse returns an error.
- [ ] `enabled_for = ["any"]` works and still excludes production (the
      `any` wildcard expands to non-production environments only).

## 3. Query safety (`/tables/data`)

- [ ] `table` param not in the schema allow-list → 400; never interpolated.
- [ ] `sort` column not in the table's columns → 400.
- [ ] `limit` clamped to `[1, 100]` server-side regardless of request.
- [ ] Per-query statement timeout (~5s) is set; a test with `pg_sleep`
      via a deliberately slow query confirms the query is cancelled, not
      the pool exhausted.
- [ ] Only `SELECT` is ever issued (code-review criterion: the crate
      contains no other verbs; grep-able).

## 4. Filter DSL

- [ ] The parser passes the **entire test table** in `filter-dsl.md` §5:
      15 valid, 14 rejected, 9 adversarial cases, as written.
- [ ] Query-builder companion tests: known column, unknown column, known
      column on the wrong table (per `filter-dsl.md` A8 note).
- [ ] Until the parser lands (it's last in build order), any non-empty
      `filter` param → 400 from the stub — never silently ignored.

## 5. Siblings

- [ ] Health checks run in parallel per request; one dead sibling doesn't
      delay or fail the others (test with one unreachable URL).
- [ ] Frontend polls `/siblings` on ~10s cadence and re-renders status
      dots without a page reload.
- [ ] Demo proof: two instances of `examples/demo.rs` on different ports,
      each configured as the other's sibling, both show green; kill one,
      the survivor shows red within one poll cycle.

## 6. Frontend

- [ ] Table list with approximate counts renders; clicking a table loads
      rows.
- [ ] Pagination, single-column sort (asc/desc toggle), and the filter
      input work against the seed db.
- [ ] `jsonb` cells render via the JSON tree viewer (`@alenaksu/json-viewer`,
      per `cdn-research.md`); uuid/timestamptz/boolean cells render as
      plain text.
- [ ] The page works when the CDN is unreachable: degraded (raw JSON text,
      no tree), but browsing still functions — CDN libs are enhancement,
      not dependency.
- [ ] Inspection affordances (`design.md` §3.1): payload button shows the
      raw JSON response for the current view in a `<dialog>`; every
      non-null cell has a hover copy button that puts the cell's text on
      the clipboard; clicking a `jsonb` or visually-truncated cell opens a
      light-dismiss popover with the full (pretty-printed if JSON) content.
- [ ] UI state persistence (`localStorage` key `ashurbanipal_ui`, per
      `design.md` §3.1): reload the page → previously selected table (and
      sort/page-size) is restored; stored state naming a since-dropped
      table → default view, no error; malformed stored JSON → discarded
      and rewritten, no error.

## 7. Packaging / integration

- [ ] `cargo run --example demo` against the devcontainer's `DATABASE_URL`
      is the only command needed to get a working browser on the seed db.
- [ ] Host integration is the one-liner from `design.md` §3.2:
      `app.merge(ashurbanipal::router(config, db_source))` — the example
      itself uses exactly this line, proving it.
- [ ] `cargo test` runs the full suite (unit + integration against the dev
      Postgres) green; `cargo clippy -- -D warnings` and `cargo fmt --check`
      pass.
- [ ] The published crate's dependency list contains no demo-only deps
      (`tracing-subscriber` etc. confined to `[dev-dependencies]`).
