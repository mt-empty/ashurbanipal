# Report each source's database engine

> **Status:** DONE · **Area:** spec, ports, conformance, frontend, docs · **Ref:** decided 2026-11-11 to drop §5.8's no-engine rule; shipped 2026-11-11

Add an `engine` field to each `/sources` entry, and drop the rule that a
response must not say which engine a source uses.

## 1. The ask

`spec/protocol.md` §5.8 says a `/sources` response MUST NOT include the
engine behind a source. `spec/openapi.yaml` (`/sources`) and
`docs/design.md` (`GET /sources`) repeat it. No document records why.

The rule no longer pays its way:

- **It hides little.** Column `type` is already the engine's own spelling
  (§5.4.1), so `timestamp with time zone` or `datetime` gives the engine
  away.
- **Access is the host's job.** The host decides who can reach the UI
  (`readme.md` §Security). The engine name adds nothing an attacker who
  can already browse the tables could not learn.
- **It blocks work:**
  - Story 22's per-engine `INSERT` dialect (quoting, casts, literals).
  - Counts: SQLite always reports `-1` (`docs/adapter-decisions.md`,
    `/table-counts`), so the page shows `?` on every SQLite table. It
    cannot tell "this engine never estimates" from "not estimated yet".

## 2. Wire change

- A §5.8 source entry gains a required `engine`, from a closed list:
  `postgres`, `mysql`, `sqlite`. A MariaDB source reports `mysql` (§7).
- Clients MUST accept a value they do not know and treat it like a source
  with no engine facts. A new port's engine then needs no client release.
- §5.8 loses the MUST NOT sentence. `openapi.yaml` and `docs/design.md`
  lose their copies of it.
- A client that ignores the field sees no change, so it is a
  `feat(protocol)`. Because the field is required, it lands under §7's
  alpha exception, recorded in `spec/CHANGELOG.md`.

```json
{ "sources": [{ "name": "primary", "engine": "postgres" }], "default": "primary" }
```

## 3. What the page may use it for

The engine is for things the user takes away or reads. It is not a way to
guess behaviour the server can state itself.

- **Allowed:** SQL text the user copies (story 22's dialect), labels, and
  whether a table count can ever exist (§4).
- **Not allowed:** working out column class, join class, sortability or
  any other rule a port already owns. Those stay server-reported fields
  (stories 45 and 47). A new need of that kind gets its own field, not an
  engine check in the frontend.

Write this rule into §5.8 so a later change cannot quietly widen it.

## 4. Frontend

- Keep the `engine` from `/sources` in the scope state beside the source
  name.
- Table counts: on `sqlite`, show no count at all: not on the table chip
  (its count slot stays empty, sized for the loading spinner), not in the
  grid's row meta, and not in the join builder's table list. Story 54's side
  panel row follows the same rule (design canvas Round 19, board BN c). `?`
  stays for an engine that estimates but has no figure yet.
- The AI-agent API reference (`frontend/src/features/api-reference.ts`)
  shows the new field in its `/sources` example.
- Story 22's dialect follow-up can then start. It is a separate change.

## 5. Touchpoints

- `spec/protocol.md` §5.8, `spec/openapi.yaml`, `spec/CHANGELOG.md`,
  `docs/design.md`
- The five backends: Rust core (axum and actix-web share it), Go, Node,
  Flask, Spring. Each knows its source's backend when the host registers
  it.
- `conformance/runner/sources.rs`, `two_source.rs`
- The demos: the PGlite live demo uses the Node port's handlers; the
  synthetic demo (`frontend/src/demo/synthetic/serve.ts`) and its snapshot
  build need the field too.
- `frontend/src/features/scope-select.ts`, `lib/format.ts`,
  `features/table-chips.ts`, `features/api-reference.ts`

## 6. What "done" means

- Conformance, on every engine: each source reports the right `engine`,
  and a two-source run reports each source's own.
- The page shows no count on a SQLite source, and `?` on a Postgres table
  that was never analyzed.
- The full three-browser e2e suite passes.

## 7. Decisions

- **MariaDB reports `mysql`** (decided 2026-11-11). Every port already
  tells them apart with a cached `SELECT VERSION()`, but only on the first
  query. Reporting `mysql` keeps `/sources` a configuration read that never
  touches the database. Clients accept unknown values, so `mariadb` can be
  added later without a client release (`docs/adapter-decisions.md` §5.8).
- **Each `DbSource` reports its own engine** as a constant, so a host
  configures nothing new and a mixed-engine process reports each source.
- **Version.** Left out. Add it only when a feature needs it.

## 8. Out of scope

- Story 22's per-engine `INSERT` dialect itself.
- Any engine check that replaces a server-reported field.
