# ER / relationship diagram for the current schema

> **Status:** OPEN · **Area:** spec, ports, frontend

## 1. The ask

A diagram view of the resolved schema: a node per table, an edge per
foreign key, click a node to open that table in the grid. Mainly an
onboarding aid for a dev new to a service.

## 2. The constraint that shapes it

`frontend/dbviewer.html` is one self-contained file with no CDN dependency
(`docs/design.md` §3.1, `docs/ui-guidelines.md` R3). It has no runtime npm
dependency today. A graph-layout library would be either:

- bundled into `dbviewer.html` by esbuild: a size cost and a licence
  review, and the page's first runtime dependency; or
- hand-rolled: a basic layered or force layout is a few hundred lines. FK
  graphs are usually small, so layout quality matters less than shipping
  no dependency.

Mermaid text is no shortcut: it still needs a bundled renderer.

## 3. Touchpoints

- `spec/protocol.md`: a schema-wide relationship route
  (`GET {mount}/api/schema/graph`?) returning `{ tables[], edges[] }`.
  Today FK data is per table: outgoing in §5.4.1's `references` (single
  column only) and §5.10's `foreign_keys`, incoming in §5.9. The new route
  reads it in one catalog query per backend, behind the same allow-list
  and privilege gate as `/tables`. Building the graph from §5.10 per table
  costs one request per table, too many for a large schema. Before adding
  a graph-only route, weigh a schema-wide §5.10 (`table` optional, returning
  every listed table's `foreign_keys`), or one schema-wide catalog read
  shared with [[63-find-a-column-across-tables]]'s `/api/columns`: either
  reuses the allow-list gate and the composite FK shape.
- Every port implements the route; conformance covers it.
- Frontend: a new view, SVG render, pan and zoom. Node → grid reuses the
  existing table-switch path.
- A schema with no FKs shows a clear "no relationships" state.

## 4. Open questions

- Hand-rolled layout, or the first bundled runtime dependency? This is a
  `docs/design.md` §3.1 decision, not only an implementation choice.
- Scale: a 200-table schema needs filtering or focus-on-neighbours, not a
  wall of nodes. Scope the first version to "tables within N FK hops of
  the selected one"?
- Show columns on nodes, or table names only until zoomed?
- Cross-schema edges: §5.9 already reports cross-schema referrers, and
  joins can span schemas ([[44-cross-schema-joins]]). In scope, or one
  schema only at first?
- Composite FKs: one edge per constraint, as §5.10 reports them? The grid
  side is [[49-composite-foreign-keys-in-the-grid]].
