# ER / relationship diagram for the current schema

Status: proposed 2026-09-01. Read-only. The single-file / no-CDN frontend
constraint is the bulk of the work. Not scheduled.

## 1. The ask

A diagram view of the resolved schema: a node per table, an edge per
foreign key, click a node to jump to that table in the grid. Primarily an
onboarding aid for a dev landing on an unfamiliar service.

## 2. The constraint that shapes it

`frontend/dbviewer.html` is one self-contained file with no CDN dependency
(`CLAUDE.md`, `docs/design.md` §3.1). Monaco's diff editor is noted there
as the *one* place a CDN dependency is still even under consideration —
everything else is hand-rolled. So a graph-layout library is either:

- vendored and inlined at build time into `dbviewer.html` (bundle-size
  hit, licence review), or
- hand-rolled — a basic layered / force layout is a few hundred lines, and
  FK graphs are usually small enough that layout quality matters less than
  not shipping a dependency.

Mermaid is not free here — Artifacts render it natively, but the standalone
frontend has no mermaid runtime, so emitting mermaid text would still need
a renderer.

## 3. Touchpoints

- `spec/protocol.md` — a schema-wide relationship endpoint
  (`GET {mount}/api/schema/graph`?) returning `{ tables[], edges[] }`.
  Today FK data is only available per-table via column metadata; this
  aggregates it in one catalog query per backend, honouring the same
  table allow-list / privilege gate as `/tables`.
- Frontend — new view, SVG render, pan/zoom, node → grid navigation reuses
  the existing table-switch path.
- Degrades to "no diagram" cleanly when the schema has no FKs.

## 4. Open questions

- Hand-rolled layout vs. first vendored/inlined frontend dependency — this
  is a `docs/design.md` §3.1 governance call, not just an implementation
  choice.
- Scale: a 200-table schema needs filtering / focus-on-neighbours, not a
  wall of nodes. Scope v1 to "tables reachable within N FK hops of the
  selected one"?
- Show columns on nodes, or table names only until zoomed?
- Cross-schema edges — in scope, or single-schema only for v1?
