# Incoming FK references ("referenced by")

**Ask:** alongside the outgoing `references` Ashurbanipal already reports
per column (`spec/protocol.md` §5.4.1 — "this column points at
`table.column`"), also surface the reverse direction: which rows in
*other* tables point at the row currently being viewed. Desktop DB
clients (DBeaver, DataGrip) show this as a separate "referenced by"
panel alongside their outgoing-FK navigation — see the discussion on
[[13-pk-that-is-also-fk-loses-references]] for how a PK+FK column's
chain of outgoing references composes without this.

**Not part of #13:** #13 is about a single column's own `key`/`references`
metadata being incomplete when the column is both PK and FK — still a
single-hop, outgoing fact. This is a different, additive capability: for
a given row, find every table+column elsewhere in the schema whose FK
points at it, then query those tables filtered by the current row's key
value(s). Needs its own catalog query (reverse-scan `information_schema`
FK constraints for ones whose *target* is the current table, not whose
*source* is), its own wire shape (`spec/protocol.md` — a new field or
route, not a variant of `ColumnInfo`), and its own frontend UI (something
like the DBeaver/DataGrip "referenced by" panel, not a click-to-navigate
cell).

**Impact / constraints:**
- Cardinality is unbounded on this side — a referenced row can have many
  children in many tables (unlike outgoing FK navigation, which is always
  exactly one target row). UI/pagination implications differ from the
  existing click-to-navigate pattern.
- Cross-port: same "check every backend implements the same catalog
  query" concern as #13, times four ports.
- Scope/design decision before implementation: wire shape (new endpoint
  vs. field on the existing row/table response), and whether it's eager
  (computed with every row fetch) or on-demand (a separate request when a
  user asks for it) — eager risks an N+1-per-row query cost this project
  hasn't taken on elsewhere.
