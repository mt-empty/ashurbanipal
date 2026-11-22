# JSONB / JSON path filter

> **Status:** OPEN · **Area:** spec, ports, conformance, frontend

Read-only, but it widens the filter's SQL surface. Treat the security
rules and the cross-engine tests as the main body of work, not the SQL.

## 1. The ask

Feature work on a table with a `jsonb` / `json` column often needs "rows
where `data.status` is `failed`". Today a filter condition names a bare
column only, so the tool cannot do this.

```
metadata->status = failed
metadata->arr->0->'user id' = 42
o.metadata->status = failed          (join view: qualifier, then path)
```

Prior art: DBeaver and dbflux have no structured JSON filter. Their filter
box takes raw SQL WHERE text, so a user types `data->>'status' = 'failed'`
by hand. That cannot work here: the backend never accepts SQL or DSL text,
and it runs on the host's own pool (`spec/protocol.md` §5.4.2).

## 2. Why this is not just another operator

Each condition's column is matched exactly against the live catalog
before it reaches SQL. In Rust the shared seam is `FilterTerm` and
`filter_sql` (`implementations/rust/core/src/join.rs:826`, `:838`), used by
both §5.4 and the join route (§5.11.3). A JSON path adds keys that are not
catalog objects. The rules:

- **No key bytes in SQL text.** The SQL text depends only on the
  catalog-checked column, the kind of each step (key or index), and the
  operator. Every key and every value is a bound parameter.
- **No escaping function.** Keys that would need escaping are rejected
  instead (§4), so no port writes a quoting routine.
- **Always the quoted path form** on MySQL, MariaDB and SQLite (`$."k"`,
  never `$.k`). Tested: with an unquoted path, `$.*` returns every value in
  the document on MySQL 8.4 and MariaDB 11.8; `$."*"` reads only the key
  named `*` on every engine.

Path-language injection can only reshape what is read from a cell the user
can already see. It is a correctness and cost risk, not a data leak, but
the rules above close it anyway.

## 3. Wire format

A condition gains an optional `path` next to `column`:

```json
{"column": "metadata", "path": ["arr", 0, "user id"], "op": "=", "value": "42"}
```

- `path` is an array of 1–8 steps. A step is a JSON string (an object key)
  or a JSON number whose value is a whole number from 0 to 2³¹−1 (an array
  index). `1.0` counts as 1: JavaScript's and Python's JSON parsers cannot
  tell them apart. Strings alone could not tell key `"0"` from index 0.
- A key is 1–255 UTF-8 bytes, with no `"`, no `\`, and no U+0000–U+001F.
  SQLite cannot address a key containing `"` at all, and a NUL byte is a
  Postgres error (22021).
- `path` is allowed only on a column of class `json` (§5.11.2). Any other
  class, or a bad step, is 400 `invalid_filter`.
- A path condition still counts as one condition against the limit of 10.
- Every operator works on a path, including `IN`, `NOT IN` and `BETWEEN`
  (story 21). The comparison is text-only: the extracted value is compared
  as text, like a class `text` column.
- §5.11.3 join filters accept `path` too, alongside `join`. So do the
  planned count routes (stories 61 and 62), since they take the same AST.
- Rollout is fail-closed: every port already rejects an unknown condition
  field (`spec/fixtures/filter-builder-tests.json:1517`, `unknown-field`),
  so a port without `path` support returns 400 rather than ignoring it.

### 3.1 Semantics

- A missing key, a JSON `null`, an SQL NULL, and a step into the wrong kind
  of parent all give SQL NULL. `IS NULL` matches all of them; `!=` and
  `NOT` drop them, as for any NULL column.
- Keys are case-sensitive. Comparison operators and `IN` are case-sensitive
  on every engine. `LIKE` and `ILIKE` behave as on a text column: SQLite's
  `LIKE` ignores ASCII case, an existing gap (`docs/adapter-decisions.md`).
- A leaf that is an object or array compares as its JSON text.
- Booleans compare as `true` / `false` on every engine.

### 3.2 Accepted gaps (record in `docs/adapter-decisions.md`)

Measured on Postgres 18, MySQL 8.4, MariaDB 11.8 and SQLite 3.40:

| Case | Postgres jsonb | Postgres json | MySQL | MariaDB | SQLite |
|---|---|---|---|---|---|
| `1.50` stored | `1.50` | `1.50` | `1.5` | `1.50` | `1.5` |
| Index 0 on a scalar | the scalar | NULL | the scalar | the scalar | NULL |
| Object leaf text | `{"k": "V"}` | as stored | `{"k": "V"}` | as stored | `{"k":"V"}` |

Text comparison also means `'10' < '9'`. A typed (cast) form is a later
story.

## 4. Per-backend SQL

Each form below was run on the versions in §3.2 with bound parameters.
§7 has the floor-version runs.

- **Postgres (15+).** One bind per step, chained, with an explicit cast:
  `("metadata" -> $3::text -> $4::int ->> $5::text)`. The last step uses
  `->>`; a one-step path is `("metadata" ->> $3::text)`. Do not wrap it in
  `::text`; it already is text. `#>>`, `@>`, `@?`, `jsonb_path_*` and
  `JSON_VALUE` (Postgres 17) are out of scope: they either need a second
  quoting language, work on `jsonb` only, or need a version above the
  floor. A GIN index will not help; the §6 timeout bounds the cost.
- **MySQL (8.4+) and MariaDB (10.11+).** One bound path string,
  `$."arr"[0]."user id"`, built from the validated steps, bound twice:

  ```sql
  CASE WHEN JSON_TYPE(JSON_EXTRACT(col, ?)) = CONVERT('NULL' USING utf8mb4)
       THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(col, ?)) END
  ```

  - `JSON_EXTRACT` is the only form that takes a bound path: `->`, `->>`
    and MySQL's `JSON_VALUE` need a literal.
  - Without the `CASE`, a JSON `null` comes back as the text `'null'`.
  - The `CONVERT` is required: on MariaDB, `JSON_TYPE(...) = 'NULL'` fails
    with "Illegal mix of collations".
  - Do not apply the class `text` wrapper `CAST(x AS CHAR)`
    (`implementations/rust/core/src/db/mysql.rs:49`). The extracted value is
    `utf8mb4_bin`; the cast moves it to the connection collation, and
    `'failed' = 'FAILED'` turns true.
  - A malformed path is error 3143 on MySQL but a silent NULL on MariaDB.
    Validation (§3) means no malformed path is ever built.
- **SQLite (3.16+ with JSON1).** One bound path string, as for MySQL:

  ```sql
  CAST(CASE WHEN json_valid(col) THEN
         CASE json_type(col, ?) WHEN 'true' THEN 'true' WHEN 'false' THEN 'false'
              ELSE json_extract(col, ?) END
       END AS TEXT)
  ```

  - `json_valid` is required: SQLite does not enforce a declared JSON type,
    and `json_extract` on a non-JSON row raises "malformed JSON" (a 500).
  - The `json_type` branch makes booleans `true` / `false`; `json_extract`
    returns 1 / 0.
  - The `CAST` is required: `json_extract` returns INTEGER for a number, and
    `10 = '10'` is false.
  - Do not use `->>` (3.38) or `#-N` indexes (3.47). JSONB blobs (3.45+)
    fail `json_valid` and give NULL; accepted gap.
  - JSON is built in from 3.38 and was a common compile option before.
    Every port bundles a recent SQLite except Flask, which uses the Python
    build's own library. Without JSON1, map `no such function: json_*` to
    400 `invalid_filter` with a clear title. Do not probe: no port touches
    the database when the router is built, and a probe adds per-source
    state. Add "path filters need JSON1" to the supported-versions table.

## 5. Filter box syntax

- `->` starts a path step: `metadata->status`, `o.metadata->status`.
  `->>` is accepted as the same thing, so pasted Postgres works.
- A step is a bare name (`[A-Za-z_][A-Za-z0-9_]*`), bare digits (an index),
  or a `'quoted'` key with `''` for a quote. `'0'` is the key `"0"`.
- No whitespace inside the column-and-path part, the same rule as for `.`.
- Rejected forms: `data.status` (collides with `alias.column`, §2),
  `data["k"]` (`"` already quotes qualifiers), `data#>{a,b}` (a second
  quoting language).
- `->` and `->>` overlap the `>` operator. The parser takes the longest
  arrow first; fixtures pin `metadata->n>5`, `metadata->>n>5` and
  `metadata->'a b'>=5`.
- Colouring: path keys get their own token class, amber-brown
  (`#9a5b13` light, `#e0a96d` dark); the `->` arrow is grey like an
  operator.
- Suggestions: after `->`, suggest keys seen in that column on the rows
  already loaded, ordered by how many rows have them, with what each holds
  (text, object, array) and the row count. Accepting a key that holds an
  object in every loaded row writes `key->` and opens the next level; any
  other key gets a space. Values after the operator also come from the
  loaded rows, under a heading that says so: there are no planner
  statistics inside JSON. No server call.
- JSON tree: every leaf line (text, number, boolean, null) gets an `=`
  button on hover, as on a row; object and array lines get none. It writes
  `col->key = value` (`IS NULL` for a null; an index for an array item) and
  composes per story 01. A tooltip shows the filter before the click. Built
  in `frontend/src/lib/json-tree.ts`, so it appears in both the record view
  (`features/record-view.ts`) and the grid's cell popup
  (`features/grid.ts`, `#cell-pop`).
- Grid: while a path filter is active, the matched key and value are
  marked with a soft wash inside each JSON cell.
- Notice: after `<`, `>`, `<=`, `>=` or `BETWEEN` on a path, a neutral
  notice says the value is compared as text (`payload->n > 9` finds 90–99
  on the seed `events` table, not 10–399). Never shown for `=`.
- Empty result: when a loaded value differs from the typed one only by
  case, the empty state names it and points to `ILIKE`.

Design: the "Ashurbanipal UI" canvas, round 21. Chosen 2026-11-22: BR
(key colour, matched-key wash), BS, BT option 1, BU (including the
text-comparison notice).

## 6. Touchpoints

- `spec/protocol.md` §5.4.2, §5.11.3 and `spec/openapi.yaml`: `path`,
  its limits, class `json` only, the semantics in §3.1.
- `spec/filter-dsl.md` and `spec/fixtures/parser-tests.json` (frontend PR:
  the frontend unit tests run these fixtures): §5 grammar.
  Cases: depth 9 rejected, whitespace in the path rejected, quoted digits,
  a qualifier plus a path, the arrow-vs-`>` overlap, hostile keys (`"`,
  `\`, control characters, `$`, `.`, `[`, `*`).
- `frontend/src/lib/filter-dsl.ts`, `filter-tokens.ts`,
  `features/filter-highlight.ts`, `features/filter-ui.ts`,
  `features/record-view.ts`.
- Every port's WHERE builder and condition validator.
- `spec/fixtures/filter-builder-tests.json`: the WHERE fragment and binds
  per engine. Add one fixture that sends hostile keys and asserts the SQL
  text equals the plain-key case, with only the binds different.
- `spec/fixtures/catalogs.json` and the seeds: a new `json_docs` table
  (`doc`: `jsonb` on Postgres, plus `doc_json json`; `json` on MySQL and
  MariaDB; declared `JSON` on SQLite). Postgres comes from `tools/seed-gen`;
  the MySQL and SQLite seeds are hand-written. Its rows cover a JSON `null`,
  a missing key, a nested object, an array, booleans, a decimal (`1.50`),
  keys holding `.`, a space, `*` and `ü`, an SQL NULL, and a cell that is
  never an object (on SQLite, not JSON at all).
- `conformance/runner/json_path.rs`: semantic cases that assert the rows
  returned for the §3.1 cases, on the table and join routes.
- `docs/adapter-decisions.md`: the per-engine forms in §4 and the gaps in
  §3.2. `PORTING.md` hardening item 6.

## 7. Proof (2026-11-22, backend PR)

- Safety: `path-hostile-keys-change-only-the-binds` in
  `filter-builder-tests.json` builds byte-for-byte the same SQL as
  `path-plain-keys` in every port's unit runner, on every engine.
- Correctness: `conformance/runner/json_path.rs` and the whole suite (138
  tests) pass for Rust on Postgres 18, MySQL 8.4, MariaDB 11.8 and SQLite;
  Go on Postgres, SQLite and MariaDB; Node, Flask on Postgres and SQLite;
  Spring on Postgres. Each port's own CI runs the rest.
- Floor versions: Rust passes the whole suite on Postgres 15.20 and MariaDB
  10.11.19 (local Docker). The SQLite form returns the expected rows on
  SQLite 3.16.0 with JSON1, and without JSON1 fails with `no such function:
  json_valid`, which Flask maps to 400.

## 8. Later

- Paths on class `text` columns that hold JSON (common on SQLite). The
  `json_valid` guard makes this safe; MySQL raises 3141 on non-JSON text
  and would need the same guard.
- A typed comparison form (numbers, booleans).
- Suggesting keys beyond the loaded page.
