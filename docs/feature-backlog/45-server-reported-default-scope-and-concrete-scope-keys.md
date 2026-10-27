# Server-reported default source and schema, and concrete scope keys

> **Status:** OPEN · **Area:** spec, ports, conformance, frontend, docs, e2e · **Ref:** found in the 2026-10-25 architecture review of source/schema/table use; do before story 44

The server is the only party that knows which source and schema an absent
parameter resolves to. Have it say so, and have the UI use those concrete
names everywhere instead of `null`.

## 1. The ask

Two bugs share one cause.

- **The UI opens the wrong schema.** `/schemas` does not say which schema is
  the default. So `loadSchemas` (`frontend/src/features/scope-select.ts`)
  guesses: the remembered schema, else `public`, else the first name.
  - On the demo's second source, whose session is pinned to `other_schema`,
    the server's default table list is `other_schema`'s, but the UI opens
    `public` (checked live, 2026-10-25).
  - On MySQL/MariaDB a schema is a database. `public` does not exist, so
    the UI opens the alphabetically first database, not the one in the
    connection string.
- **Remembered settings vanish.** While a host has one source or one schema,
  the UI stores `null` for it. Settings are keyed by `[null, null, table]`.
  When the host adds a second source, or the role can see a second schema,
  the same table becomes `["primary", "public", table]`. Remembered sort,
  hidden columns, column widths and saved joins are then lost, and the old
  entries stay in storage.

## 2. When the UI holds `null` today

`null` means "send no parameter; the server uses its default". It covers
three different cases:

| Case | `source` | `schema` |
|---|---|---|
| Only one exists (the UI knows its name, then discards it) | `scope-select.ts` `loadSources` | `scope-select.ts` `loadSchemas` |
| Not known yet: start-up, or just after a source switch with no remembered schema | `core/store.ts` initial state | `core/store.ts` initial state, `switchSource` |
| The lookup failed (`/sources` or `/schemas` errored) | `loadSources` catch | `loadSchemas` catch |
| Back/Forward restores an entry without the parameter | `core/url.ts` `applyUrlExact` | `core/url.ts` `applyUrlExact` |

A URL with an empty value (`?source=`) stores `""`, not `null`
(`applyUrlOverlay`). On the wire it behaves the same, but it makes a
different storage key.

## 3. Decisions so far

- **No backward compatibility.** The wire shapes, the spec and stored
  browser data may all change. Each mount serves its own copy of the UI, so
  the UI and the API it calls are always the same build.
- **The server always reports the defaults.** `/sources` and `/schemas` each
  return a `default` field.
- **`default` is the only way to mark the default.** The rule that the first
  `/sources` entry is the default (`spec/protocol.md` §1 and §5.8) goes, so
  the spec has one source of truth.
- **Both list routes have the same shape:** a list of `{ "name": … }`
  objects plus one top-level `default`.
- **Only the list routes carry it.** Echoing the resolved `source` and
  `schema` on every scoped route (§5.2–§5.5, §5.9–§5.11) was considered and
  rejected:
  - The UI needs both names before its first table request (for the
    selectors and the storage keys), so the list routes are where it learns
    them anyway.
  - Echoing would touch 9 routes in 5 backends for no extra information.
- **The UI always works with concrete names.** After start-up, the scope
  holds real names, and every request sends both.
- **The URL is unchanged.** It still omits `source` and `schema` when only
  one exists, so links stay short and still open on a sibling whose source
  has another name.
- **One scope key.** A single helper replaces the four spellings in use today.
- **Old stored settings are discarded**, not migrated. Users lose remembered
  sort, hidden columns, widths and saved joins once.

## 4. Wire change

`spec/protocol.md` §5.8:

```json
{ "sources": [{ "name": "primary" }, { "name": "reporting" }], "default": "primary" }
```

- `default` MUST be the source an absent `source` resolves to (§1), and
  MUST be in `sources`.

`spec/protocol.md` §5.7:

```json
{ "schemas": [{ "name": "other_schema" }, { "name": "public" }], "default": "other_schema" }
```

- `default` MUST be the schema an absent `schema` resolves to on this source
  (§1), and MUST be in `schemas`.
- `default` is `null` when the connection has no default schema (below).

| Engine | `default` comes from |
|---|---|
| Postgres | `select current_schema()` |
| MySQL/MariaDB | `select database()` |
| SQLite | `"main"` |

**No default schema.** `current_schema()` is `NULL` when no schema on the
`search_path` exists, and `database()` is `NULL` when the connection string
names no database.
- `/schemas` returns `default: null`. The UI then opens the first listed
  schema and sends it by name.
- A scoped request with no `schema` gets 400 on every port, never a 500.
- Today Spring already returns a clear 400 (`MySqlSource.kt`
  `resolveSchema`). Rust decodes the result as a non-null `String`
  (`core/src/db/postgres.rs`, `core/src/db/mysql.rs`
  `resolve_schema_in_tx`), so a `NULL` fails as a decode error. Check the
  other ports the same way.
- Likelihood: rare on Postgres (for example, `public` dropped and no
  `$user` schema); plausible on MySQL, where a database-per-tenant app may
  connect without naming a database.

## 5. Frontend

- **Scope state is a union type**, not nullable fields:
  `{ kind: "loading" } | { kind: "known", source, schema } | { kind: "failed" }`.
  - Per-scope memory (sort, hidden columns, widths, saved joins, chip list)
    takes the `known` variant only, so the compiler enforces that nothing
    is read or written while the scope is unknown.
  - On `failed`, requests send no parameter, as today.
- **Resolve at start-up.**
  - `loadSources` keeps the remembered source when it is still listed, else
    `default`.
  - `loadSchemas` keeps the remembered schema when it is still listed, else
    `default`, else the first listed schema.
  - A one-entry list gives its one name.
- **Send both on every request.** `applyScopeParams` builds request
  parameters from the concrete names. URL writing (`syncUrl`) still omits a
  name when its list has one entry, so it needs its own rule.
- **One key helper** in `core/store.ts`, `scopeKey(source, schema)`. These
  use it today with their own spellings:
  - `scopeTableKey`: sort, hidden columns, structure cache
    (`JSON.stringify([source, schema, table])`)
  - saved joins (`lib/join-saved.ts`): `source ?? ""`, `schema ?? ""`
  - column widths (`features/column-widths.ts` `widthScopeOf`):
    `` `${source}|${schema}|…` ``, which prints `null`
  - chip list (`features/table-chips.ts` `scopeOfChips`):
    `` `${source ?? ""}|${schema ?? ""}` ``, which can collide because a
    quoted Postgres name may contain `|`
  - `schemaBySource`: `source ?? ""`
- **Discard old stored settings.** Rename the per-scope storage keys
  (`ashurbanipal_ui` in `core/store.ts`, `ashurbanipal_joins` in
  `features/join-saved.ts`) and remove the old keys at start-up. Theme and
  the chip-list expanded flag are not per-scope and keep their keys.
- **Normalize `""` to unknown** when reading the URL.

## 6. Touchpoints

- `spec/protocol.md` §1, §5.7 and §5.8; `spec/openapi.yaml`
  (`SchemasResponse`, `SourcesResponse`)
- The five backends: Rust core (axum and actix-web), Go, Node, Flask, Spring
- `conformance/runner/schemas.rs`, `sources.rs`
- `docs/adapter-decisions.md`: where each engine's default comes from, and
  the no-default case
- `frontend/src/core/store.ts`, `core/url.ts`, `core/types.ts`,
  `features/scope-select.ts`, `features/table-chips.ts`,
  `features/column-widths.ts`, `features/join-saved.ts`,
  `lib/join-saved.ts`, `features/structure.ts`
- `docs/ui-guidelines.md` R11/R12 if their wording names the key shape

## 7. What "done" means

- **Conformance**, on every port and engine:
  - `/sources` `default` is listed.
  - `/schemas` `default` is listed, and both lists use the object shape.
  - `/tables` with no `schema` returns the same list as with
    `schema=<default>`.
  - The two-source runner's pinned source reports `other_schema`.
  - If the runner can create a role whose `search_path` names no existing
    schema: `/schemas` returns `default: null`, and `/tables` with no
    `schema` returns 400.
- **e2e:**
  - On the second demo source, pinned to `other_schema`, the UI opens
    `other_schema`.
  - Every request carries `source` and `schema` once start-up is done.
  - Old stored data under the previous keys is removed, and start-up
    works with it present.
- **Unit tests** (`frontend/test/`) for the key helper.
- The full three-browser e2e suite passes.

## 8. Out of scope

- Echoing the resolved scope on every route (§3).
- **Nesting each source's schemas in `/sources`.** It saves one request at
  start-up but makes `/sources`, which today reads only configuration,
  query every source and need a per-source error. Not worth it while most
  hosts have one source.
- **Requiring `source` and `schema` on every route.** It would remove
  server-side default resolution, but touches every route in five ports and
  makes curl use harder.
- Changing what the URL carries.
- Cross-schema joins (story 44), which build on the stable keys from this
  story.
