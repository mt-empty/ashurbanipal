# Remember the selected schema per source

Status: shipped 2026-09-05 (commit `ca5fff1`, PR #90), matching the shape
proposed below: `schemaBySource` on `State` (`frontend/src/state.ts`),
recorded on `#schema-select` change and on the FK-navigation schema
switch via `setSchema()` (`frontend/src/sidebar.ts`), consulted in
`#source-select`'s `onchange`. §4's "remember table per (source, schema)"
question remains open. Rest kept as history.

## 1. The pain point

Switching source resets the schema every time. `#source-select`'s
`onchange` sets `state.schema = null` unconditionally
(`frontend/src/sidebar.ts:78`), then `loadSchemas()` runs against the new
source and, finding `state.schema` empty, pins it to `public` (or the
first schema) — `frontend/src/sidebar.ts:104-105`. So a dev who was
working in `reporting` on source A, flips to source B and back, lands in
`public` on A again and has to re-pick `reporting` from the dropdown.
`sort` and hidden columns are already remembered per table (R11); schema
is the one piece of scope that isn't remembered per anything.

## 2. Shape

Mirror the `sortByTable` pattern (`frontend/src/state.ts:17`, `:49-56`,
`:94-110`):

- Add `schemaBySource: Record<string, string>` to `State`, included in the
  `persist()` payload and hydrated with the same "object, not array,
  discard-if-malformed" guard the other keyed maps use.
- On `#schema-select` change (`sidebar.ts:116`) and on the FK-navigation
  schema switch (`frontend/src/grid.ts:188`), record
  `schemaBySource[state.source ?? ""] = state.schema`.
- In `#source-select`'s `onchange`, instead of `state.schema = null`, set
  `state.schema = state.schemaBySource[newSource] ?? null`.
- `loadSchemas()` already validates: `if (!state.schema ||
  !schemas.includes(state.schema))` falls back to `public`/first
  (`sidebar.ts:104`). So a remembered schema that no longer exists on that
  source degrades silently to the default — no extra validation needed
  (R5).

## 3. Interactions

- **URL wins over stored state** on load (`state.ts:60-64`) — unchanged. A
  shared link with an explicit `schema` still reproduces that link's view;
  the per-source memory only fills in when the URL says nothing.
- **Single-schema sources** never set `schema`, so they never write a
  `schemaBySource` entry — no clutter for the common case.
- Persisted like the other UI-shape keys; a schema name is an identifier,
  not row data, so R6 is not in play.

## 4. Open questions

- Also remember the selected **table** per (source, schema)? Bigger change,
  and a table name collision across sources is more surprising than a
  schema one. Probably a separate story; note it here so it isn't lost.
- Storage key growth is bounded by the number of sources a host registers
  (small), so no eviction policy needed.
