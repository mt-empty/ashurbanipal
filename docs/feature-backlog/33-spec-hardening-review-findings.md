# Spec-hardening review: wire-contract and doc red flags

> **Status:** OPEN · **Area:** spec, ports, conformance, frontend, docs

**Ask:** a review of the wire contract (`spec/protocol.md`,
`spec/openapi.yaml`) found places where it falls short of best practice.
This is a triage list, not one feature: each item can be fixed on its
own. Item IDs are kept stable across edits, so gaps in the numbering are
expected.

## Behavior / wire contract

### B2 — Offset-only pagination

`OFFSET n` reads and discards n rows on Postgres and MySQL. A deep page
can hit §6's query timeout and return 500 `query_timeout`. §5.4 puts no
upper bound on `offset`, and nothing says where it gets slow. There is no
keyset (cursor) alternative.

§5.4's tie-break key already gives a total order for any table with a
primary key or a qualifying unique index, which keyset paging needs. A
table with neither has no total order, so it must keep offset paging.

Fix:
1. Document the cost of a deep `offset` in §5.4 and §6.
2. Add an optional `after=<opaque cursor>` parameter for tables with a
   tie-break key. The cursor holds the last row's sort value and key. It
   is a new optional parameter, so v1 stands (§7). It must keep working if
   [[05-multi-column-sort]] lands.

### B4 — `<undecodable>` is an in-band sentinel

§5.4.3 replaces a cell that can't be decoded with the string
`"<undecodable>"`. A real text value that is exactly that string looks
the same as a decode failure.

MySQL and MariaDB already mask bad bytes on the server
(`docs/adapter-decisions.md` §5.4.3), so a decode failure can't be
detected there. An out-of-band signal only works on Postgres and SQLite.

Fix: signal decode failure outside the cell value, for example an
optional per-row list of the column indexes that failed. Adding the field
alone keeps v1. Removing the sentinel at the same time changes an
existing rule, which is a version bump (§7). Record the MySQL/MariaDB
limit in `docs/adapter-decisions.md`.

### B5 — MySQL/MariaDB list tables the role cannot read

MySQL/MariaDB list a table the role has some privilege on but not
`SELECT`, and the row fetch then fails (1142 → 400). That exposes the
table's name and gives a "listed, then error on click" experience. The
mechanism, its reach (§5.2/§5.3, §5.4.1, §5.9, §5.11) and the
alternatives weighed are in `docs/adapter-decisions.md` §5.2/§5.3.

Options:
- **MySQL:** the `SHOW GRANTS … USING` allow-set. Build it once per
  operation, or keep it in S4's cache. Apply it only where a table is
  listed but not read (§5.2/§5.3, §5.4.1, §5.9); data routes keep the 1142
  mapping and gain nothing from a pre-check.
- **MariaDB:** `SHOW GRANTS FOR <role>` per granted role, followed
  recursively, with the same placement.
- **If the gap stays:** a spec-level flag on §5.2 entries (for example
  `readable: null` where the engine can't tell), so the frontend can mark
  them. The frontend can't infer this on its own.

SQLite has no access control on tables, so there is nothing to filter.

### B6 — The spec forbids defense in depth

§3: implementations "MUST NOT add authentication inside the mount". There
is also no audit log of what was browsed, no rate limit, and no app-level
table allowlist, only the database role's grants and one global `enabled`
switch. If the perimeter is misconfigured, anyone who reaches the mount
can silently read everything the connection role can see.

`docs/design.md` §6 already names a host-injected bearer check as "the
natural next step", which the spec's MUST NOT rules out.

Fix:
- Change §3 so the host MAY add an authentication check inside the
  mount. The spec still defines none of its own.
- Consider an optional access-log hook (who read which table, with which
  filter).
- Consider a config-level table allowlist. It must use the same rule for
  the table list and for the per-request table check (§5.2), so the two
  never disagree.

## Sharp edges (lower priority)

### S2 — No filter grouping

§5.4.2: `AND` binds tighter than `OR`, there is no way to write
`a AND (b OR c)`, and a filter has at most 10 conditions.

The filter stays one plain text field ([[10-structured-filter-builder-ui]]
was declined), so grouping means parentheses in the text DSL
(`spec/filter-dsl.md`) and a group node in the JSON AST. Decide under §7
whether a new node type is additive. Adjacent to [[24-jsonb-path-filter]].

### S4 — Per-request catalog cost

Every `/api/tables/data` request runs catalog lookups for columns,
FK/PK keys and tie-break keys before the data query. That cost grows with
catalog size, and a catalog query that times out is a 500. The spec says
nothing about it. §6 says no cache is *required*, but it neither permits
nor rules out one.

Fix:
1. Measure on a 2,000-table catalog on each engine. The old ~90 ms
   Postgres figure predates the current catalog queries.
2. If the cost matters, state in §6 that a port MAY cache catalog
   metadata per source with a short TTL. The TTL bounds how long a schema
   change or a revoked grant stays unseen, so the spec should cap it.
3. Note in §6 how catalog cost scales with catalog size.
