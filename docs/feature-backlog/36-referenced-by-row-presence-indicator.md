# Row-presence indicator for "referenced by" entries

> **Status:** OPEN · **Area:** spec, ports, frontend, docs

**Ask:** in the "referenced by" list (`spec/protocol.md` §5.9), mark which
entries hold rows for the record on screen. `users.id = 42` may be
referenced by eight tables but have child rows in only two. Today every
entry looks the same, and the user finds an empty one only by clicking
through.

The list is structural, the same for every row of a table
([[50-referenced-by-view-improvements]] §1 has how it shows today). This
story is the row-level step.

DBeaver and DataGrip show no such flag: they open one referencing table
at a time and count only on request. Showing every referrer in one flat
list is what makes a per-entry flag possible here.

## Shape: a boolean, not a count

One `EXISTS (SELECT 1 FROM <child> WHERE …)` per entry. `EXISTS` stops at
the first matching row, so it stays cheap even on an unindexed FK column;
Postgres does not index the referencing side by itself. A `count(*)` per
entry scans each child table, which is why §5.9 reports no row counts.
Exact counts are a separate, heavier feature
([[61-count-matching-rows]] counts one filtered view on a click).

## Wire shape

A new route, not a field on §5.9: a field would force the work on every
list request. One batched request takes the viewed row's values and
returns one flag per entry.

```
GET {mount}/api/tables/referenced-by/presence?source=&schema=&table=&key=<col>:<val>[&key=…]
→ { "presence": [ { "table": "orders", "constraint": "orders_user_id_fkey", "exists": true }, … ] }
```

The parameter shape is a sketch. Before adding it, weigh two cheaper
paths:

- **No spec change:** one `/api/tables/data?limit=1&filter=…` per entry
  (`limit` clamps to at least 1, §5.4). N requests, but no new route in
  five ports.
- **One seam with [[61-count-matching-rows]]:** "exists" is a filtered
  count capped at 1. Both stories can share one filtered-aggregate method
  on each port's database seam, and the batch can take §5.4.2 filter ASTs
  instead of a new `key` syntax.

Notes on the route as sketched:

- `key` carries the row's value for every column that appears as a `to`
  in any entry. An FK can target a unique key, not only the primary key,
  so this is not always the PK.
- Each `EXISTS` uses the same `WHERE` as the drill-in: `from = value` per
  column pair, built by the port's existing §5.4 filter builder. Values
  are bound, never spliced, and typed comparison works as in §5.4.2. Then
  `true` means the drill-in returns at least one row.
- An entry whose `to` value is NULL in this row is already disabled in
  the UI; report it as `exists: false`.
- The server reuses §5.9's catalog lookup and privilege gate, then runs
  all the checks as one statement, `SELECT EXISTS(…) AS e0, EXISTS(…) AS
  e1, …`, on the operation's one connection (`docs/design.md` §5). One
  round trip and one timeout bound (§6), not N of each. Serial `EXISTS`
  queries would also fail together on Postgres: one timeout aborts the
  transaction.
- A timeout gives `exists: null` for every entry, shown as "unknown", not
  "empty".
- A referrer the role cannot read follows §5.9's privilege rule
  (`docs/adapter-decisions.md` §5.9). On MySQL/MariaDB such an entry can
  still be listed, and it fails the whole statement (1142). The port then
  falls back to one `EXISTS` per entry, so only that entry reports
  `exists: null`.
- `(table, constraint)` is the join key, as in §5.9. On SQLite
  `constraint` is the synthesized `fk_<id>` label.

## Frontend

`referenced-by.ts` renders the list from the structural payload as now,
then sends one presence request for the viewed row. `exists: false`
renders muted (for example a "no rows" tag); `null` renders neutral. A
false entry stays clickable: an empty filtered grid is a valid answer.

- The presence result depends on the row, so it needs its own cache keyed
  by `(source, schema, table, key values)`, apart from the structural
  memo.
- A late reply for row 41 must not paint over row 42
  (`docs/ui-guidelines.md` R14), and the request shows its own loading
  and error state (R9).
- The PK-cell popover and the record-dialog section share one renderer,
  so both get the flag.
- Whether the flag belongs in the list is decided in
  [[50-referenced-by-view-improvements]]'s design round. This story builds
  it once that round says yes.

## Effort / constraints

- `spec/protocol.md` section, `spec/openapi.yaml` path,
  `frontend/src/features/api-reference.ts` entry.
- Every port: Rust `core/` (serves axum and actix-web), Go, Node, Flask,
  Spring Boot. Each mirrors its §5.9 route and reuses its filter builder.
- The synthetic demo backend (`frontend/src/demo/synthetic/serve.ts`)
  needs the route; the live demo gets it from node-express.
- Conformance: for every entry of a seeded row, assert that the flag
  equals "the §5.4 drill-in returns a row". This holds on every seed and
  needs no seed parity. Asserting a fixed list of true and false entries
  across engines needs [[35-conformance-seed-dialect-parity]].
- e2e: present, absent and unknown, across two rows with different child
  rows.
- A `docs/adapter-decisions.md` row if an engine handles the privilege or
  timeout case differently from the notes above.
