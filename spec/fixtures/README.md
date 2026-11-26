# Shared fixtures

Machine-readable fixture sets, generated from the normative docs they
mirror (`spec/filter-dsl.md` §5, `spec/join-dsl.md` §5 and
`spec/protocol.md` §3, §3.1, §5.4.2 and §5.11). The docs
remain the human-readable source of truth; a change to a doc and its
fixture file ships in the same PR.

## `parser-tests.json` — frontend DSL parser (DSL text → AST)

Consumed only by the frontend's fixture runners
(`frontend/test/filter-dsl.test.ts` for the parser,
`frontend/test/filter-tokens.test.ts` for the highlighting tokenizer), since
DSL parsing exists only in the frontend. Not part of backend conformance.

Each entry in `cases`:

- `name` — the `spec/filter-dsl.md` §5 case ID (`V*`/`R*`/`A*`; A9 is
  split into its at-limit and over-limit halves).
- `input` — the DSL text fed to the parser, verbatim (R13/R14/A9's
  generated long inputs are materialized here in full).
- `aliases` — optional. A join view's table aliases in position order; the
  parser runs in join mode (`spec/filter-dsl.md` §3), so qualified names
  resolve and every condition in `expect` carries `join`. Absent means a
  single-table view.
- `expect` — the exact AST array the parser must emit
  (`spec/protocol.md` §5.4.2 conditions), compared by deep equality:
  optional fields (`logic` on the first condition, `not` when false,
  `value` for `IS [NOT] NULL`) must be *absent*, not null/false-filled.
- `expect_error` — the case must be rejected client-side. When
  `position` is present, the error's byte offset (UTF-8 bytes into
  `input`) must equal it; when absent, only the rejection itself is
  asserted (exact offsets for mid-string failures are parser-internal
  detail, pinned only where they're unambiguous).

Exactly one of `expect`/`expect_error` is present.

## `join-parser-tests.json` — frontend join parser (join text → `JoinDef`)

Consumed only by `frontend/test/join-dsl.test.ts` and
`frontend/test/join-tokens.test.ts`. Not part of backend
conformance. Top-level `catalog` maps seed-schema table names to their
column names, for unqualified names. Top-level `schemas` maps a schema name
to its tables in the same shape, for `schema.table` names; a `null` schema or
table means its tables or columns are not loaded. Cases run against both
unless `no_catalog` is `true`.

Each entry in `cases`:

- `name` — the `spec/join-dsl.md` §5 case ID.
- `input` — the join text, verbatim.
- `expect` — the exact `JoinDef` (`spec/join-dsl.md` §3), compared by deep
  equality. With it, `canonical` — the text `print(def)` must write, which
  must itself parse back to the same `JoinDef`.
- `expect_error` — the case must be rejected. `code` is a
  `spec/join-dsl.md` §4 code; `line` and `column` (1-based) are asserted
  when present; `suggest` is the closest catalog name when the message
  offers one. Message text is not pinned.

Exactly one of `expect`/`expect_error` is present.

## `catalogs.json` — engine-native catalogs for the builder fixtures

Shared by `filter-builder-tests.json` and `join-builder-tests.json`. Each
runner turns a catalog row into a column the way that backend's catalog
lookup does, calling the engine's own type-to-class and typed-comparison
functions and the port's tie-break-key choice. The row assembly itself is
copied into each runner, so a backend-only adjustment to it (MariaDB's JSON
columns) is not covered by either fixture.

Top-level `catalogs` has one entry per engine (`postgres`, `mysql`,
`sqlite`), standing in for the live catalog lookup:

- `schemas` — the §5.7 list; `default_schema` — the request's schema when a
  case names none. SQLite's only schema is `main`, never spliced into SQL.
- `tables`, keyed `schema.table`. Each has `columns` in catalog order, as the
  engine's catalog query returns them, and `unique_keys` (`name`, `primary`,
  `columns`) as that query reports them: already limited to keys whose parts
  are plain `NOT NULL` columns. Column fields are engine-native:
  - `postgres`: `name`, `data_type`, `udt_schema`, `udt_name`, `is_enum`,
    `type` (the full spelling, from `format_type`), optional `collation`
    (absent for the default collation).
  - `mysql`: `name`, `data_type`, `column_type`, optional `collation`.
  - `sqlite`: `name`, `declared` (may be empty).
- Tables mirror the conformance seeds (`conformance/seed/`). A table the
  seeds lack, kept for a shape no seed table has (a collation clash, no
  unique key, a label collision), carries `"synthetic": true`.

## `filter-builder-tests.json` — backend AST validation + table-route WHERE building, per engine

Consumed by every backend's unit runner, once per engine (Postgres, SQLite,
MySQL/MariaDB), with no database, and over HTTP by the black-box suite
(`conformance/runner/filter_dsl.rs`), which JSON-encodes each case into a
real `filter` query param and asserts 200 where the engine under test builds
it and 400 where it rejects it. A unit runner builds the case's table from
the engine's catalog in `catalogs.json`, parses the conditions with the
port's filter parser and builds the WHERE clause with the engine's dialect.

Each entry in `cases`:

- `name` — stable case ID.
- `table` — the table the case is validated against, looked up as
  `<default_schema>.<table>` in each engine's catalog.
- `conditions` — the decoded filter AST (the usual input), **or** `raw` —
  a literal pre-URL-encoding `filter` param value, for cases that aren't
  a valid conditions array at all (malformed JSON, DSL text).
- `expect_error` — every engine rejects the case. The kind names *why*,
  and implies the stage:
  - `unknown_column` — structurally valid AST, column fails the schema
    allow-list (builder stage).
  - `invalid_value` — the builder's own 400 `invalid_filter` on a known
    column, here a `path` on a column whose class is not `json` (builder
    stage).
  - `malformed`, `bad_op`, `bad_logic`, `missing_value`,
    `unexpected_value`, `bad_value` (wrong value shape for the op: an
    array where a string belongs, or a bad `IN`/`BETWEEN` list),
    `missing_logic`, `unexpected_logic`, `too_many_conditions`,
    `oversize`, `bad_path` (a `path` that breaks the step rules) —
    structural validation, rejected before any schema access. A unit
    runner asserts only that the parse fails, not which kind; error
    message text is implementation-defined (`spec/protocol.md` §2).

  **Or** `expect` — one entry per engine the case applies to, either
  `{"error": "invalid_value"}` (the column compares typed there and a value
  does not match its class's form; SQLite skips the check) or:
  - `where` — the fragment after ` where `, exactly as built: the engine's
    identifier quoting and casts, a text comparison's cast on the column, a
    typed comparison's cast (or none) on the placeholder, and its native
    placeholders — Postgres `$3` onward, because limit and offset bind
    first; SQLite and MySQL `?`. `IN` and `BETWEEN` take one placeholder
    per item. A runner whose driver uses another placeholder spelling
    (`%s`, `?` on Postgres) substitutes it before comparing; everything
    else is normative. An empty `where` means no WHERE clause. A
    condition with a `path` wraps the column in the engine's JSON path
    expression (`docs/adapter-decisions.md`); the `path-hostile-keys-…`
    case must build the same `where` as `path-plain-keys`.
  - `values` — the bind values, in placeholder order, including each
    path step (Postgres) or the path string, once per placeholder
    (MySQL, SQLite).

  An engine missing from `expect` doesn't run the case (no such column
  there).

## `join-builder-tests.json` — backend join planning + SQL building, per engine

Consumed by every backend's unit runner, once per engine (Postgres, SQLite,
MySQL/MariaDB), with no database. Each runner builds every table from the
engine's catalog in `catalogs.json`, then runs the case through the port's
join parser, filter parser, schema resolution, planner and SQL builder.

Each entry in `cases`:

- `name` — stable case ID.
- `join` — the decoded `join` object, **or** `join_raw` — a literal string,
  for a value that isn't valid JSON or exceeds the byte bound.
- Optional `filter` (the decoded array, §5.11.3), `sort`, `sort_join` (an
  integer), `order` (`asc`/`desc`), `schema` (the request's). Request-level
  checks (`order` spelling, a non-integer `sort_join`, limit clamping) are
  left to the HTTP conformance suite.
- `expect_error` — every engine rejects the case with this
  `spec/protocol.md` §2 code (`invalid_join`, `invalid_filter`,
  `invalid_parameter`, `unknown_column`); **or**
- `expect` — one entry per engine the case applies to, either
  `{"error": code}` or:
  - `sql` — the statement after `select`, exactly as built: generated
    `t{n}` table and `c{n}` column aliases, the engine's quoting and casts,
    and its native placeholders — Postgres `$1`/`$2` for limit and offset
    with filter values from `$3`; SQLite and MySQL `?`, filter values first.
    A runner whose driver uses another placeholder spelling (`%s`, `?` on
    Postgres) substitutes it before comparing; everything else is
    normative.
  - `values` — the filter's bind values in placeholder order (limit and
    offset are not listed).
  - `labels` — the response column labels, in order (§5.11.4).

  An engine missing from `expect` doesn't run the case (no such table
  there, or a type that engine lacks).

## `host-allow-list-tests.json` — `Host` allow-list matching

Consumed by every port's allow-list unit tests. Mirrors `spec/protocol.md`
§3.1; the HTTP side is `conformance/runner/host_allow_list.rs`.

Each entry in `cases`:

- `name` — what the case shows.
- `allowed_hosts` — the configured list; `[]` turns the check off.
- `host` — the request's `Host` (or HTTP/2 `:authority`); `null` means
  none was sent.
- `allowed` — whether the request passes.

## `host-routes-untouched.json` — the viewer never changes a host route

Consumed by every port's routing tests. Mirrors `spec/protocol.md` §3 and
§3.1: only a `GET` or `HEAD` to `{mount}` or an API route is the viewer's,
with the `Host` check on or off.

- `viewer_paths` — the viewer's own paths, relative to `{mount}` (`""` is
  the UI).
- `host_routes` — routes the test registers on the host app next to the
  viewer, each answering with its own marker body. `{mount}` stands for
  wherever the test mounted the viewer. Each must get the host's own
  response from a listed host, an unlisted host, and with the check off.
- `unrouted` — requests no one routes. Each must get the host's own 404,
  identical from a listed host, an unlisted host, and with the check off.
