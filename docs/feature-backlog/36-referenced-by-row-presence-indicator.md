# Row-presence indicator for "referenced by" entries

> **Status:** OPEN · **Area:** spec, ports, frontend, docs

**Ask:** in the "referenced by" list ([[14-incoming-fk-references]], `spec/protocol.md`
§5.9), mark which entries actually hold rows for the record on screen, so
a user can tell at a glance which referrers are worth opening. `users.id
= 42` may be referenced by eight tables structurally but have child rows
in only two of them.

The list today is structural only — every FK constraint that targets the
table, identical for every row (which is why the frontend memoises it per
`(source, schema, table)`, `frontend/src/features/referenced-by.ts:21`).
An entry that leads to an empty filtered result for this particular
record looks the same as one that leads to fifty rows; the user finds out
only by clicking through.

## Prior art

DBeaver's References panel — the model for story 14's base feature — does
**not** do this. It shows one referencing table at a time through a combo
box (`ReferencesResultsContainer`, noted in story 14) and surfaces a
count only as the loaded sub-grid's ordinary result count: lazy, behind
the "Calculate total row count" button, never per-association and never
before selection. DataGrip likewise opens a filtered result with no
pre-count. So this is an Ashurbanipal-specific refinement — showing every
referrer at once in a flat list is what makes an at-a-glance per-entry
indicator both possible and worth having.

## Shape — a boolean, not a count

`SELECT EXISTS(SELECT 1 FROM <child> WHERE <from> = $1 [AND …])` per
entry. `EXISTS` short-circuits at the first matching row, so it stays
cheap even when the FK column is unindexed — which Postgres does not
index automatically on the referencing side. A true `count(*)` per entry
is a full aggregate (seq scan on an unindexed column, N of them per row
viewed); §5.9's closing note rules row counts out of the base route on
purpose, and pricing an exact filtered count into a new route carries
that cost into all six backends. The boolean gets the "don't send me
into an empty table" value for a fraction of it. Exact counts, if ever
wanted, are the heavier sibling of this route — not a reason to skip the
cheap version.

## Wire shape

A new route (story 14's "a new route, not a field" reasoning applies —
a field forces eager computation): a batched lookup that takes the viewed
row's key value(s) and returns one flag per FK constraint.

```
GET {mount}/api/tables/referenced-by/presence?source=&schema=&table=&pk=<col>:<val>[&pk=…]
→ { "presence": [ { "constraint": "orders_user_id_fkey", "exists": true }, … ] }
```

(`pk` param shape illustrative.) Notes:

- Row-dependent, unlike §5.9's base payload — so a separate frontend cache
  keyed `(source, schema, table, pk-tuple)`, its own staleness token (a
  slow reply for row 41 must not paint over row 42), and no reuse of the
  structural memo.
- Server reuses §5.9's work: same reverse-FK catalog lookup, same
  allow-list intersection, then one `EXISTS` per surviving entry on the
  operation's single pinned connection (schema-isolation invariant,
  `docs/design.md` §5). PK values are bound, never spliced.
- A referrer the connected role cannot `SELECT` → omit, or `exists:
  null`, matching §5.9's privilege-visibility split
  (`docs/adapter-decisions.md` §5.2/§5.3).
- The per-backend statement timeout (`spec/protocol.md` §6) still applies;
  `EXISTS` is bounded enough that hitting it is unlikely, but a timeout
  maps to `exists: null` — rendered "unknown", not "empty".
- `constraint` is the join key, same as §5.9 (`(table, constraint)` unique
  per response); on SQLite it is the same synthesized `fk_<id>` label.

## Frontend

`referenced-by.ts` renders the list from the structural payload as it does
now, then fires one presence request for the viewed row. `exists: false`
entries render de-emphasised (dimmed, or a "no rows" tag); `null` renders
neutral. Whether a false entry stays clickable is a UX call — probably
yes, landing on the empty filtered grid is a valid answer to "show me".
Per `docs/ui-guidelines.md` R9 the presence fetch needs its own
loading/settled/error state in the panel. Both surfaces (PK-cell popover
and record-dialog section) share the one renderer, so they share this.

## Relationship to the `.pk-cell` affordance follow-up

Story 14's deferred item — gate the dashed-underline PK-cell affordance on
whether the table has *any* incoming FK — is the *table-level* version of
this question and needs only the structural §5.9 result. This story is the
*row-level* version. Shared motivation ("don't signal a path that goes
nowhere"), different mechanism; they can land independently.

## Effort / constraints

- Spec section + `spec/openapi.yaml` path + conformance case.
- `core/` (serves axum + actix) plus go / node / flask / spring — ~20–30
  lines each, mirroring the §5.9 route's structure and reusing its
  allow-list step.
- ~40 lines of frontend (second cache + token + dimmed rendering); no new
  module.
- e2e: present / absent / unknown across two rows with different child
  data.
- Cross-dialect conformance depends on [[35-conformance-seed-dialect-parity]]
  — asserting "entry X has rows, entry Y does not" needs the MySQL/SQLite
  seeds to carry the same child rows as the Postgres one, which today they
  do not.
- `docs/adapter-decisions.md` row if an engine handles the privilege or
  timeout case differently from the note above.
