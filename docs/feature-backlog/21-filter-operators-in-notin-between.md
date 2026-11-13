# Filter operators: IN, NOT IN, BETWEEN

> **Status:** DONE · **Area:** spec, ports, conformance, frontend, docs, e2e · **Ref:** shipped with [[33-spec-hardening-review-findings]] S1 (typed comparison)

Read-only — extends the existing filter, no change to the read/write
posture.

## 1. The ask

Feature work constantly needs "these five ids" or "created in this
window", which meant a long `OR` chain or two `>=`/`<=` conditions. Add
`column [NOT] IN (v1, v2, …)` and `column BETWEEN lo AND hi`.

`BETWEEN` is `>=` plus `<=`, and those compared the column's text cast, so
`id BETWEEN 9 AND 10` matched nothing. This story therefore shipped
together with S1 of story 33: number, float, date and time columns now
compare in their own type (`spec/protocol.md` §5.4.2).

## 2. Decisions

- **Wire.** Two new ops, `IN` (value: an array of 1 to 1000 strings) and
  `BETWEEN` (value: `[lo, hi]`, inclusive). They use the existing
  uppercase spellings. There is no `NOT IN` op: `not: true` expresses it,
  and `NOT BETWEEN` the same way. Each counts as one of the 10 conditions;
  the 8192-byte bound still applies.
- **DSL.** `column [NOT] IN (a, 'b c')` and `column [NOT] BETWEEN lo AND hi`
  (`spec/filter-dsl.md` §2). A bare `NULL` inside a list is a parse error
  that points to `IS NULL`, because `x NOT IN (1, NULL)` is never true in
  SQL. An empty list, a trailing comma and `NOT x NOT IN (…)` are errors.
  The 1 KiB DSL limit keeps a typed list far below the 1000-item cap.
- **Reversed bounds** are legal and match nothing, like any contradiction.
- **SQL.** One placeholder per list item on every engine, not Postgres
  `= ANY($1)`: drivers bind arrays differently across the five ports.
  Parameter limits are far above 1000 (Postgres 65535, MySQL 65535,
  SQLite 32766 since 3.32). A system SQLite before 3.32 keeps 999; only
  Flask links it, and there a longer filter is a 400.
- **Bounds and items** take the same value forms as any typed comparison
  (`spec/protocol.md` §5.4.2); a bad one is a 400 `invalid_filter`, except
  on SQLite, which does not enforce column types and so skips the check.
- **MySQL 8.0.17** is now the minimum: `CAST(… AS FLOAT/DOUBLE)` needs it.

## 3. Follow-ups

- The frontend does not yet underline a value that does not fit the
  column's class (`amount > abc`); the server's 400 is shown instead.
