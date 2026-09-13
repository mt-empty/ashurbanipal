# Spec-hardening review: wire-contract and doc red flags

> **Status:** OPEN · **Area:** spec, ports, frontend, docs

**Ask:** a review pass on 2026-09-08, done while planning
[[14-incoming-fk-references]], turned up a set of best-practice concerns
in the *existing* wire contract (`spec/protocol.md`, `spec/openapi.yaml`)
and in `docs/design.md`. This is not one feature — it is a triage list of
separable fixes, captured so they are not re-derived from scratch each
time. Each item is independently actionable.

`docs/ui-guidelines.md` and `docs/frontend-style-guide.md` were reviewed
in the same pass and are sound — every finding is in the protocol or in
`docs/design.md`.

## Behavior / wire contract

### B1 — No stable order for pagination

`spec/protocol.md` §5.4 makes `sort` a single column and mandates nothing
about a deterministic total order; with no `sort` there is no `ORDER BY`
at all. Offset pagination over a non-unique or absent sort key lets the
engine reorder equal rows between successive page requests, so a user
paging a table can see a row twice or skip one.

Fix: §5.4 MUST require a deterministic order whenever `limit`/`offset`
apply — e.g. append the primary key (or the full column tuple for a
PK-less table) as an implicit final sort key, in every port. Needs a
conformance case. Adjacent to [[05-multi-column-sort]].

### B2 — Offset-only pagination

`OFFSET n` costs an O(n) scan on Postgres and MySQL. A deep page can trip
§6's query timeout and return 500. There is no keyset/cursor alternative,
and the ceiling is not documented.

Fix: add optional keyset pagination (`after=<opaque last-row key>`)
alongside offset; at minimum, document the limit.

### B3 — Errors carry no machine-readable discriminator

`spec/protocol.md` §2: one 400 covers unknown table, unknown column,
invalid filter, and invalid `order`, and clients "MUST NOT parse" the
plain-text body. The frontend cannot tell a malformed filter from a
missing table except by re-deriving it, and the surfaced text is
per-port backend prose the user never wrote. Because the body is
`text/plain`, adding a code later is a shape change (a §7 version
decision).

Fix: a small stable `error.code` enum in a JSON error body, decided while
the cost is still low.

**Actioned** in [[34-rfc9457-problem-details]]: `spec/protocol.md` §2 and
`spec/openapi.yaml` now specify RFC 9457 `application/problem+json` with a
`code` member; §7 records why it's an in-place v1 change. That story
tracks the implementation rollout across the five ports and the frontend.

### B4 — `<undecodable>` is an in-band sentinel

`spec/protocol.md` §5.4.3 replaces an undecodable cell with the literal
string `"<undecodable>"`. A cell whose real text value is exactly that
string is indistinguishable from a decode failure.

Fix: signal decode failure out of band (a per-cell flag), not a reserved
value inside the data space.

### B5 — MySQL/MariaDB list tables the role cannot read

`docs/adapter-decisions.md` §5.2/§5.3 records this as an accepted gap:
Postgres hides a table the role can't `SELECT`; MySQL/MariaDB list it and
fail only at row fetch. That leaks the table's name and existence, gives
a "listed, then 400 on click" UX, and is a cross-engine behavior split on
a disclosure-sensitive surface.

Fix: revisit the rejected `EXPLAIN`-probe or an equivalent; or, if the
gap stands, have the frontend mark un-verifiable entries rather than
letting them 400.

**2026-09-08 follow-up** (agent check, verified against live MySQL 8.4.11
/ MariaDB 11.8.8):
- The gap is **narrower than recorded**. `information_schema` rows are
  privilege-scoped on both engines, so a table the role has *no*
  privilege on is already omitted from `KEY_COLUMN_USAGE` / `TABLES` — the
  leak is only a table the role has *some* non-`SELECT` privilege on
  (INSERT/UPDATE/REFERENCES/…). Still a cross-engine split and still a
  "listed, then 1142→400 on click" UX, but not "any unreadable table".
- **`adapter-decisions.md:150` overstates the alternatives for MySQL.**
  MySQL has an O(1–2)-round-trip, grant-path-complete option the prior
  analysis missed: `SHOW GRANTS FOR CURRENT_USER() USING <ENABLED_ROLES>`
  (or `SET ROLE ALL; SHOW GRANTS`), parsed app-side into a `(db, table)`
  allow-set. Gaps: DB-name `LIKE` wildcards in `GRANT … ON db_%.*` must be
  matched as patterns; `ENABLED_ROLES` transitive-closure for nested
  roles is unconfirmed on MySQL (documented on MariaDB). It is a *parsed
  allow-set, not a `WHERE` predicate* — so the "no scalar predicate"
  finding stands — and **it does not port to MariaDB** (no `USING`
  clause, no `SET ROLE ALL` — both parse-error on 11.8; you must
  `SHOW GRANTS FOR <role>` per granted role and recurse). So a
  cross-engine SHOULD still can't lean on it, but a MySQL-only
  improvement is feasible.
- SQLite: no per-object access control exists at all (`sqlite3_set_authorizer`
  is a compile-time C callback in the embedding app, not a catalog) —
  nothing to filter, confirmed.

### B6 — The spec forbids defense-in-depth

`spec/protocol.md` §3: implementations "MUST NOT add authentication
inside the mount." Combined with no audit log of what was browsed, no
rate limiting, and no app-level per-table allowlist (only the DB role's
grants and one global `enabled` bool), a misconfigured perimeter means
silent full read access to everything the connection role can see.
`docs/design.md` §6 is candid about the tradeoff, but a "MUST NOT" is a
strong prohibition to bake into a normative spec.

Fix: soften §3 to permit a host-injected bearer check inside the mount;
consider an optional access-log hook and a config-level table allowlist.

## Documented sharp edges (lower priority)

### S1 — Lexicographic filter comparisons

§5.4.2: `>`/`<`/`>=`/`<=` compare the column's text cast, so `"10" < "9"`
and date ranges misbehave. Deliberate v1, but users hit it on the first
numeric column. Adjacent to [[21-filter-operators-in-notin-between]].

### S2 — No filter grouping

§5.4.2: conditions join with SQL precedence and there is no way to write
`a AND (b OR c)`; 10-condition cap. With S1, the filter is weak. Adjacent
to [[10-structured-filter-builder-ui]] and [[24-jsonb-path-filter]].

### S3 — `total_approx` presented as the row count

§5.4.4 allows a stale or `-1` estimate; `docs/ui-guidelines.md` R6 shows
row counts as always-visible fact. Right after a bulk load the estimate
can be 0 or off by an order of magnitude.

Fix: render it as an estimate (`~108k`), and degrade gracefully at `-1`.

### S4 — Stateless mandate vs per-request catalog cost

§6 requires no cache; the reference implementation re-runs the full
`information_schema` column/key/comment metadata on every
`/api/tables/data` call (~90 ms on a 2,000-table catalog, measured while
planning [[14-incoming-fk-references]]), and a timeout there is a 500.
The spec never acknowledges catalog-size scaling.

Fix: permit and add a short-TTL per-source catalog-metadata cache; note
the scaling characteristic in §6.

## Doc drift

### D1 — `docs/design.md` §4 re-specs every route and has diverged

§4.1 still describes the filter as a DSL string on the wire
(`[NOT] column OP value ...`), contradicting §5.4.2's "JSON AST, never
DSL text". §5's `DbSource` trait is written `async fn` (old `async_trait`
style) while the real trait and `CLAUDE.md` are RPITIT `impl Future`.
`CLAUDE.md` says §4 "stays as rationale", but nothing checks parity and a
reader who lands there first gets wrong information.

Fix: §4 links to `spec/protocol.md` and keeps only the *why* — no route
restatement.

### D2 — Normative clauses name one implementation as the exemplar

`spec/protocol.md` §5.2 and §5.7 contain "(the Rust implementation sorts
by name)" inside SHOULD clauses. The project's stance (`CLAUDE.md`,
`PORTING.md`) is that no implementation is canonical. (§5.9 was drafted
with the same phrasing and corrected on capture — it now says "e.g. by
`(schema, table, constraint)`; collation unspecified"; §5.2/§5.7 still
carry it.)

Fix: state the requirement (stable order, by name, collation unspecified)
without pointing at a specific port.

### D3 — "subject to change at any time"

`spec/protocol.md`'s header disclaims stability while five ports are held
to it by CI. Conformance mitigates the risk; the framing still invites
churn.

Fix: replace with a concrete change process (additive vs breaking, as §7
already sketches) rather than an open-ended disclaimer.
