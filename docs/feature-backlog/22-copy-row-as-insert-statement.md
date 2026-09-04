# Copy row as INSERT statement

Status: shipped 2026-09-02 (record-view button; single dialect, quoted
string literals). Read-only — generates text, executes nothing.

## 1. The ask

The record / vertical view already has a whole-row-as-JSON copy button
(`docs/design.md` §3.1). Add a sibling that copies the row as an
`INSERT` statement, so a dev can lift a fixture row from one environment
into a migration, a seed file, a test, or another database.

```sql
INSERT INTO public.orders (id, customer_id, status, total_cents, created_at)
VALUES (42, 7, 'pending', 1999, '2026-08-01T10:15:00Z');
```

## 2. Shape

- Frontend-only if the row data and column list the view already holds are
  enough — no new endpoint.
- Column order from the current result set; values rendered per type
  (quote and escape strings, `NULL` unquoted, JSON/array as a quoted
  literal, timestamps ISO-8601).
- Schema-qualify the table name to match how the rest of the UI names it.
- Fine to also offer a multi-row form ("copy all N visible rows as
  INSERTs") from the same menu.

## 3. Cross-backend handling (as shipped)

The frontend only ever sees `col.type` as the connected engine reports it,
and the three diverge (Postgres `integer`/`boolean`, MySQL
`int`/`tinyint`, SQLite `INTEGER`/`BOOLEAN` or `""`), so `sqlLiteral`
(`frontend/src/record-view.ts`) does not key off exact type names:

- A value is emitted **bare** only when its column type loosely matches a
  numeric pattern *and* the text-cast value is a clean number
  (`/^-?\d+(\.\d+)?$/`). The value check catches false type matches (e.g.
  Postgres `point`) and keeps a digit-only value in a text column quoted.
- Everything else — including booleans, which text-cast as `true`/`false`
  on Postgres but `1`/`0` on MySQL/SQLite — is a quoted string literal;
  the target column's insert-time cast accepts it on all three engines.
- Identifiers are spliced unquoted (portable quote characters differ:
  Postgres/SQLite `"`, MySQL backtick); fine for the simple catalog names
  a browsing tool surfaces.

## 4. Open questions / not done

- Include generated / identity columns, or emit a column list that omits
  them with a toggle? (Shipped: all columns; `Column` carries no
  generated flag.)
- Multi-row form ("copy all N visible rows as INSERTs"). Not built.
- Very wide rows / large text cells — copied in full regardless of
  on-screen truncation (matches the cell viewer).
- **True per-backend dialect** (raised in PR review, `#87`): Postgres
  `::type` casts, MySQL backtick-quoted identifiers, engine-specific
  literal forms, instead of the one portable dialect above. Blocked on the
  frontend not knowing which engine is behind the selected source —
  `spec/protocol.md` has no `engine`/`dialect` field on `/sources`,
  `/schemas`, or `/tables` today, and column-type spellings alone aren't a
  reliable proxy (the whole reason §3's detection is loose-match +
  value-shape gated, not type-name-keyed). Doing this properly means a
  protocol addition wired through all five ports and conformance, not a
  frontend-only change — a separate, larger story if picked up.
