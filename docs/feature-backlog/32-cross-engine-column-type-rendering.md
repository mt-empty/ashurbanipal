# Cross-engine column-type rendering

Status: implemented 2026-09-06 (Option A). Frontend-only. §§1–7 are the
plan as proposed; §8 records what actually shipped and where it diverged.

`frontend/dbviewer.html` is one shared artifact across five ports and three
DB engines (Postgres, MySQL, SQLite), but its type-aware rendering was
written Postgres-first and keyed off Postgres `information_schema.columns.
data_type` spellings — exact, case-sensitive `===` / object-key lookups.
On MySQL and SQLite most columns fell through to undifferentiated plain
text. The backend already sends the type (`columns[].type`,
`spec/protocol.md` §5.4.1); the frontend just didn't understand any
vocabulary but Postgres's.

## 1. Decision — Option A (frontend-only, no protocol change)

Two ways to close the gap were weighed:

- **A — frontend fix.** Keep the raw engine `type` on the wire; make the
  frontend's type bucketing tolerant (case-insensitive, substring/regex)
  and back it with value-shape fallback. No `spec/` change,
  backwards-compatible with every existing port.
- **B — normalised `class` field in `spec/protocol.md` §5.4.1** (closed
  vocabulary `number|bool|datetime|date|uuid|json|text|binary|unknown`,
  each port maps its own catalog types, conformance schema-tests assert
  the mapping).

**Going with A.** It fixes the real degradation now, reuses a pattern the
codebase already trusts (`lib/json-tree.ts` value-pattern detection,
`features/record-view.ts` `NUMERIC_TYPE_RE`), and needs no five-port
coordination. Escalate to B (its conformance schema-tests are the real
drift guard the alias map lacks) when any port emits a column-type
spelling `TYPE_ALIASES` doesn't cover, or the team wants a hard
cross-engine consistency guarantee. This supersedes the open question in
`docs/feature-backlog/23-inline-column-type-nullable-default-enum.md` §4
("Raw engine type string, or a normalised label?") for rendering purposes
— fold any revisit into item 23.

## 2. Broken sites — pre-fix audit (line numbers are from the pre-fix tree)

- **`frontend/src/lib/format.ts:22-31,43`** — `CELL_TYPE_CLASSES` map,
  keys `boolean uuid smallint integer bigint numeric real "double
  precision"`; plain case-sensitive lookup. MySQL matches only
  `bigint`/`smallint` by coincidence; `int` `decimal` `double`
  `tinyint` `mediumint` `float` miss, and there is no `uuid`/`boolean`
  type. SQLite matches only if the DDL happens to be lowercase; the
  `"unknown"` fallback (`implementations/rust/core/src/db/sqlite.rs`,
  `docs/adapter-decisions.md` §"CAST … AS TEXT") always misses.
- **`frontend/src/lib/format.ts:36`** — `<time>` + `cell-type-date` gate
  is `col.type === "timestamp with time zone" || col.type === "date"`.
  MySQL `datetime`/`timestamp` miss (bare `date` survives); SQLite has no
  date affinity so all miss. Incomplete even for Postgres —
  `timestamp without time zone`, `time` miss.
- **`frontend/src/features/grid.ts:190,191,194` and
  `frontend/src/features/record-view.ts:21,51`** — JSON-tree render, the
  `expandable` class, and copy-row JSON re-nesting all gate on
  `col.type === "jsonb"`. MySQL's JSON type reports `json`; SQLite has
  none. Record view: MySQL `json` / SQLite JSON columns render flat and
  copy-row emits an escaped string. Grid is narrower — `showCellPop`
  (`grid.ts:96-99`) already detects JSON structurally and the rAF pass
  (`grid.ts:271-275`) marks any *overflowing* cell `expandable`, so the
  gap there is only **short, non-overflowing** JSON values (no expand
  cue, click is a no-op).

## 3. Not a defect — leave alone

`ILIKE` in `frontend/src/lib/filter-dsl.ts:130,138` and
`frontend/src/features/api-reference.ts:125` is the **normative wire
operator** (`spec/protocol.md` §5.4 operator table; mapping blessed in
`docs/adapter-decisions.md`). The frontend is required to accept and
advertise it; results are correct on all three engines.

## 4. Work items

1. **One tolerant type-bucketing function** in `frontend/src/lib/format.ts`
   — `columnTypeClass(type: string): "number"|"bool"|"date"|"uuid"|"json"|
   null`. Case-folded, length/precision-suffix-stripped lookup against a
   **closed alias set** — not substring matching, which would mis-bucket
   Postgres `interval`/`point`/`inet`/`int4range` on the `int` substring.
   Buckets:
   - number ← `int integer int2 int4 int8 smallint bigint mediumint tinyint
     serial smallserial bigserial decimal numeric double "double precision"
     real float number`
   - date ← `date timestamp timestamptz datetime "timestamp with time zone"
     "timestamp without time zone"` (one bucket — nothing renders a plain
     date differently from a timestamp)
   - bool ← `bool boolean`. MySQL `TINYINT(1)` booleans are **not**
     detectable — `information_schema.COLUMNS.DATA_TYPE` is bare `tinyint`,
     so they bucket as `number` (accepted gap, noted in
     `docs/adapter-decisions.md` §5.4.3 table).
   - uuid ← `uuid`
   - json ← `json jsonb`
   Replace the `CELL_TYPE_CLASSES` lookup, the `format.ts` date gate,
   and the `col.type === "jsonb"` checks in `grid.ts` / `record-view.ts`
   with calls to it.
2. **Value-shape fallback** for the ambiguous engines — reuse
   `lib/json-tree.ts:29,49` (UUID by regex) and `grid.ts:96-99` (JSON by
   `JSON.parse`) so a MySQL/SQLite column whose declared type is opaque
   (`unknown`, `TEXT`) still renders a UUID/JSON value correctly. Decide
   and document the precedence (declared type wins over value shape, or
   vice versa) — a `text` column of numeric-looking strings picking up
   number styling is the accepted trade-off.
3. **Render the column type as code.** `frontend/src/features/grid.ts:22`
   builds the header label as `${col.name} (${col.type})` plain text.
   Wrap the type in a `<code>` element (markdown-inline-`code` style) —
   monospace, subtle background, so an engine-native spelling like
   `character varying` or `TIMESTAMP` reads as a literal, not prose. Add
   the matching `code` rule to `frontend/src/styles.css`. Apply the same
   treatment wherever else the raw type is surfaced (record view, and the
   header popover if `docs/feature-backlog/23-…` lands). Keep the
   `aria-label` at `grid.ts:41` readable — the `<code>` is visual only.
4. **Fix the Postgres-flavoured comments** (cosmetic, same cleanup
   family as the `implementations/rust` comment drift):
   `frontend/src/lib/format.ts:19` ("Postgres data_type strings …"),
   `frontend/src/lib/filter-dsl.ts:208-210` ("explicit `::text` cast" —
   `::` is Postgres-only syntax), `frontend/src/features/record-view.ts:26,45`
   ("the `::text` value" / "`::text`-cast JSON string"). State the
   engine-neutral fact (values are text-cast in-query) without the
   Postgres notation.
5. **Docs prose** — `frontend/src/features/api-reference.ts:131` uses
   `timestamptz`/`jsonb` in the filter note; either qualify as "e.g. on
   Postgres" or drop the engine-specific spellings. Same Postgres-first
   framing in `spec/openapi.yaml`: the `info.description`, the file header
   comment, `ColumnInfo.type.description` ("Postgres data type name …"),
   and `TableDataResponse.rows.description` ("the Postgres text
   rendering …") all predate the MySQL/SQLite backends and now name one
   engine where `spec/protocol.md` §5.4.1/§5.4.3 is already
   engine-neutral. Reword to match — description-only, no contract change.
6. **`frontend/src/demo/demo-shim.ts:40-44`** — `isNumericType` /
   `isDateType` use Postgres-only spellings. No real-engine impact (static
   demo fake backend fed by `demo/demo-fixtures.ts`), but move it onto the
   same bucketing helper so the demo doesn't drift from app behaviour.

## 5. Tests

- **Unit** (`frontend/test/`) — a `format.test.ts` table over the
  bucketing function: the Postgres, MySQL, and SQLite spelling of each
  bucket, casing variants, `unknown`, and non-matches. Extend
  `json-tree` / value-shape fallback coverage if precedence logic lands
  there.
- **E2E** (`tools/e2e-tests/`) — the suite runs against
  `frontend/dbviewer.html` with fixture data; add a fixture column set
  using MySQL/SQLite type spellings and assert the rendered cell classes
  / `<time>` presence / `expandable` affordance, plus the `<code>`
  wrapper on the header type. Run the full suite at default parallelism
  before calling it done (per `CLAUDE.md`).

## 6. The pattern to follow

`frontend/src/lib/json-tree.ts:29,49` (UUID by value pattern),
`frontend/src/features/grid.ts:96-99` (structural JSON detection), and
`frontend/src/features/record-view.ts:68-86` (loose `NUMERIC_TYPE_RE` +
engine-aware `sqlLiteral` with an explicit bool `true`/`false` vs `1`/`0`
note) are already cross-engine. The INSERT-copy path was generalised;
`format.ts` was not. This story finishes that generalisation.

## 7. Related

- `docs/feature-backlog/23-inline-column-type-nullable-default-enum.md` —
  surfaces type/nullable/default/enum in the header popover + record
  view. Its §4 raw-vs-normalised question is settled here for rendering
  (ship the raw string, bucket it in the frontend); if it adds a popover
  it reuses `columnTypeClass` and the `<code>`-wrapped raw type.
- `docs/feature-backlog/30-show-ddl-source-viewer.md:64` — normalised
  type formatting via Postgres `format_type()`; a different surface, same
  raw-vs-normalised tension.

## 8. As shipped

Landed 2026-09-06 on top of the plan above, with two deviations settled
during a `/simplify` pass:

- **`date` and `datetime` collapsed to one `date` bucket.** The plan had
  both; nothing renders them differently (same `<time>` + `cell-type-date`),
  so `ColumnTypeClass` carries only `date`.
- **The "render as JSON?" rule is one shared predicate, not two.**
  `format.ts` exports `rendersAsJson(col, raw)` (declared JSON, or an
  unbucketed type whose value leads with `{`/`[`) and `warnBadJsonCell(col,
  err)` (self-gates on declared-JSON). `grid.ts` and `record-view.ts` both
  call them instead of open-coding the check; `record-view.ts` lost its
  local `jsonShape`/`NUMERIC_TYPE_RE` (item 6's generalisation, finished —
  `sqlLiteral` now uses `columnTypeClass(...) === "number"`).

Also done beyond §4:

- `<time>` no longer sets a `datetime` attribute (invalid on every
  engine's text cast, read nowhere); `docs/frontend-style-guide.md` §
  "Semantic elements" updated to match.
- Value-shape fallback covers UUID (`format.ts` local `UUID_RE`,
  duplicated from `json-tree.ts` because the `node --test` runner can't
  resolve a `.js`→`.ts` runtime import from a tested leaf) and JSON only —
  never number/bool/date. Precedence: declared type wins; shape only fires
  when `columnTypeClass` returns `null`.

Files: `frontend/src/lib/format.ts` (helper + consumers),
`frontend/src/features/{grid.ts,record-view.ts}`,
`frontend/src/demo/demo-shim.ts`, `frontend/src/features/api-reference.ts`,
`frontend/src/lib/filter-dsl.ts` (comment), `frontend/src/styles.css`
(`th code.col-type`). Docs: `docs/adapter-decisions.md` (MySQL `tinyint`
note), `docs/frontend-style-guide.md`, `spec/openapi.yaml` (§5 prose).
Tests: `frontend/test/format.test.ts` (table-driven),
`tools/e2e-tests/tests/cross-engine-types.spec.ts` (all three browsers).
