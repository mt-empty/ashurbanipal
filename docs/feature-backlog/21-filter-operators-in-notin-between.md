# Filter operators: IN, NOT IN, BETWEEN

Status: proposed 2026-09-01. Read-only — extends the existing filter, no
change to the read/write posture. Not scheduled.

## 1. The ask

The filter grammar today has `= != >= <= > < LIKE ILIKE` plus
`IS [NOT] NULL` (`spec/filter-dsl.md` §2). Feature work constantly needs
"these five ids" or "created in this window", which today means a long
`OR` chain or two `>=`/`<=` conditions. Add:

- `column IN (v1, v2, …)` / `column NOT IN (v1, v2, …)`
- `column BETWEEN lo AND hi` (inclusive, `lo`/`hi` bind as parameters)

## 2. Touchpoints

- `spec/filter-dsl.md` — grammar (§1/§2), and the valid/rejected/adversarial
  test table (§5). New rows for list length limits, empty list, trailing
  comma, `BETWEEN` with reversed bounds.
- `spec/protocol.md` §5.4.2 — the JSON AST gains `in` / `not_in` (value is
  an array) and `between` (value is a two-element array). Decide a max list
  length; fold it into the existing 10-condition / 8192-byte envelope.
- Frontend parser (`frontend/src/`) — tokenise the list / `BETWEEN … AND`.
- Each backend's `build_where_clause` — map `in` to `= ANY($1)` (Postgres)
  or an expanded placeholder list (MySQL/SQLite), `between` to
  `col BETWEEN $1 AND $2`. Column still allow-list-checked first, every
  value still bound, never spliced.
- `conformance/runner/filter_dsl.rs` — the shared test table drives all
  five ports.

## 3. Open questions

- Max elements in an `IN` list (bind-parameter ceilings differ per engine —
  Postgres ~65k, SQLite default 999, MySQL packet-size bound).
- Does `BETWEEN` accept the same bare/quoted value forms as the binary
  operators, including dates as bare tokens?
- `NOT IN` + NULL in the list is a classic SQL footgun (`NOT IN (1, NULL)`
  is never true). Reject NULL inside an `IN` list at parse time, or
  document the SQL behaviour?
