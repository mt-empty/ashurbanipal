# Feature-expansion triage — remaining candidates

Status: captured 2026-09-01. A list of "become more of a DB client"
features was triaged this day. The ones worth their own entry were split
out as stories 21–27 (and the shareable-filter item is 20). This doc holds
the remainder: items already tracked elsewhere, read-only items judged
lower priority for now, and the write-track items that cannot be built
without relaxing the read-only constraint.

Context for the whole list: expanding scope while keeping five co-equal
ports in lockstep is the binding constraint, not any single feature. The
port strategy — one reference implementation vs. a shared core vs.
accepting lagging ports — should be decided before the write track starts.
See the discussion that produced this triage.

---

## A. Already tracked — pointers only

- **Incoming FK references** ("what points at this row") —
  `docs/feature-backlog/14-incoming-fk-references.md`.
- **Row diff / compare** —
  `docs/feature-backlog/04-diff-viewer-for-rows.md`.
- **Saved / recent filters per table** —
  `docs/feature-backlog/02-per-table-query-filter-history.md` (its
  "carve out an exception to R6" branch is largely resolved by
  `docs/feature-backlog/20-persisted-and-shareable-filter-state.md`).
- **Shareable filtered-view URL** —
  `docs/feature-backlog/20-persisted-and-shareable-filter-state.md`.
- **"Show DDL" source viewer** —
  `docs/feature-backlog/30-show-ddl-source-viewer.md` (split out
  2026-09-02).

## B. Read-only, lower priority

All of these introspect the catalog, run `SELECT`, or act entirely in the
frontend. None changes the read/write posture.

- **CSV export of the current result page.** The payload viewer already
  gives copyable JSON of the current view; this adds a CSV form and a file
  download. Frontend-only for the current page.
- **Client-side aggregates on a selection.** Sum / avg / count / min / max
  over selected cells or a column, shown in a status strip. Frontend-only,
  operates on already-fetched rows (bounded by R7).
- **Triggers, sequences, and table statistics** in the metadata panel.
  Long-tail catalog introspection; lower value for day-to-day feature work
  than indexes/constraints (story 26). Each item is a per-engine catalog
  query × five ports.
- **Streamed full-table export.** Export beyond the current page needs a
  streaming endpoint and a bytes-not-JSON response shape — a real protocol
  addition, and it sits in tension with R7's "render what the server
  paginates". Only worth it if exporting whole tables becomes a common ask.
- **Jump to row by primary key.** Subsumed by the existing filter
  (`id = 42`) and FK navigation; at most a small convenience input that
  knows the PK column and handles composite keys. Not a standalone story.

## C. Require dropping the read-only constraint

These need, in order: (1) the port-strategy decision above; (2) a
`writes_enabled` opt-in flag that is independent of `enabled` and defaults
to off, so a host that never sets it keeps today's safe-by-construction
behaviour; (3) write-path guardrail UX — preview, affected-row count,
explicit confirmation, transaction with rollback; (4) a lightweight action
log (who ran what, when). Treat this as a separate project that reuses the
codebase, scoped to development and integration environments — it is not
advertised for production, though nothing stops a host enabling it there.

- **Single-row edit — `UPDATE` by primary key.** The highest-value write:
  fix state that is blocking a test. Needs a PK (no PK → no edit target),
  type coercion per column, and confirmation.
- **Single-row insert and delete by primary key.** Set up and tear down
  test data. Insert needs required-column / default handling; delete needs
  FK-cascade awareness in the confirmation.
- **Duplicate row.** Insert prefilled from an existing row. Read-only only
  in the "prefill a form / copy an `INSERT`" form (that half is story 22);
  as an actual insert it belongs here.
- **Bulk update / delete with preview.** Highest blast radius. Must show
  the affected-row count from the same `WHERE` before executing, run in one
  transaction, and offer rollback. This is the feature most likely to nuke
  a shared integration environment by accident.
- **Session cleanup helper.** "Delete the rows I inserted this session" —
  depends on tracking inserts per session, and on delete existing.

Explicitly still excluded even under the write track:

- **DDL execution.** If built at all, emit a migration file for the host to
  review and run — never execute `CREATE` / `ALTER` / `DROP` blind.
- **Multiple heterogeneous engine types connected at once.** Out of scope
  for single-service feature work; large architectural change for little
  return.
