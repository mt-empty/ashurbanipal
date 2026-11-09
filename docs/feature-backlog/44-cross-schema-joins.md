# Cross-schema joins

> **Status:** DONE · **Area:** spec, ports, conformance, frontend, docs, e2e · **Ref:** server side in PR #248; join DSL, table refs, picker, bands and e2e in the frontend PR that follows

Let one join name tables from more than one schema of the same source.
Read-only, like every join. A join still never crosses a source.

## 1. The ask

A user can already follow a foreign key into another schema: an FK cell
opens `warehouse.shipments` → `public.orders`, and "referenced by" lists
referrers in other schemas. But a join stays in one schema
(`spec/protocol.md` §5.11: "Every table in the join is resolved in this one
schema"). So the user can walk from a shipment to its order, but cannot see
shipments and orders side by side in one grid.

The seeds (seed version 6) have the shapes to test against:

- `warehouse.shipments.order_id` → `public.orders.id`
- `warehouse.shipment_events.handled_by_user_id` → `public.users.id`
- `warehouse.users` shares only its name and an `id` column with
  `public.users`, so a join can name two tables with the same name.
- `conformance/seed/seed.mysql.sql` has the same `warehouse` tables as a
  second database, with both FKs reaching the connection's default
  database.
- **SQLite has only `main`**, so it can test only the rejections.

## 2. Decisions so far

- **Same source only.** Each source is one connection (§1 "Resolved
  source"). A join across sources would need two connections and a
  client-side merge. Out of scope.
- **Every new field is optional.** A request with none of them behaves
  exactly as today.
- **The join object is self-contained.** The base table and each `joins`
  entry may carry their own `schema`. The join DSL gains `schema.table`
  after `FROM` and `JOIN` to match (§4; today `tableref` takes a bare name
  only), and saved joins are stored as that DSL text
  (`frontend/src/lib/join-saved.ts`).
- **A column's `references.schema` stays relative to its own table**, as
  §5.4.1 and §5.11.4 already define it. A client resolves an FK target's
  schema as `references.schema`, else the column's own `schema` (§3), else
  the scope.
- **The request's `schema` stays the default.** Any table without its own
  schema resolves in the request's resolved schema, as now.
- **Every schema name is allow-listed** against §5.7's live list, and every
  table against that schema's §5.2 list. A name is never spliced into SQL
  before both checks pass. Then it is quoted with the engine's identifier
  quoting, as the `FROM` clause already does.
- **One operation, one connection, one transaction** (§1). Each extra
  schema is resolved and checked inside that same transaction.
- **Limits do not change.** At most 4 tables, at most 3 pairs per `ON`, and
  the 8192-byte `join` bound.

## 3. Wire change (`spec/protocol.md` §5.11.1)

Add an optional `schema` to the base and to each `joins` entry:

```json
{
  "table": "shipments",
  "schema": "warehouse",
  "joins": [
    { "type": "left", "table": "orders", "schema": "public",
      "on": [{ "left": { "join": 0, "column": "order_id" }, "right": "id" }] }
  ]
}
```

- Absent means the request's resolved schema.
- Present MUST match §5.7's list exactly (case-sensitive); otherwise 400
  `invalid_join`. The table MUST then match that schema's §5.2 list.
- In the response, a `columns` entry gains `schema` only when its table is
  not in the request's resolved schema. This mirrors `references.schema`
  (§5.4.1): present only for the cross-schema case.
- The two fields have different bases. A column's `schema` is relative to
  the request's resolved schema; its `references.schema` stays relative to
  the column's own table (§2). The spec MUST say so. Example, with the
  request's schema `warehouse`: `public.orders.user_id` carries
  `schema: "public"` and `references: {table: "users", column: "id"}` with
  no `schema`, because `users` is in `orders`' own schema. Its target is
  `public.users`, not `warehouse.users`.
- §5.11.2 column compatibility is unchanged. All tables share one engine,
  so types compare the same way across schemas.

## 4. Join DSL change (`spec/join-dsl.md`)

```ebnf
tableref    = [ ident , "." ] , ident , [ ws , [ "AS" , ws ] , alias ] ;
```

- `FROM warehouse.shipments s LEFT JOIN public.orders o ON s.order_id = o.id`
- A `tableref` only appears after `FROM` or `JOIN`, so `schema.table` cannot
  be confused with `alias.column` in `ON` and `SELECT`.
- **Effective name** stays the alias, or the bare table name when unaliased,
  never `schema.table`. Two tables with the same name from two schemas
  therefore need an alias on one of them; the existing "effective names
  must all differ" rule already rejects the clash.
- The printer writes the schema only when it differs from the scope's
  schema, so today's joins print exactly as before.
- New test-table rows: valid qualified names, quoted schema names
  (`"my schema".t`), a clash without an alias, and an adversarial schema
  name, which parses and is then rejected by the server.

## 5. Engines (`docs/adapter-decisions.md`)

| Engine | Mechanism | Notes |
|---|---|---|
| Postgres | `"schema"."table"` in `FROM`/`JOIN` | Privilege gate as today (`has_table_privilege` per table). |
| MySQL/MariaDB | `` `db`.`table` `` | A "schema" is a database. Cross-database joins work on one server when the role can read both. Same partial privilege gap as §5.2/§5.3. |
| SQLite | `main` only | One schema, so any other `schema` is rejected like an unknown name. `ATTACH` stays out of scope. |

## 6. Frontend (story 41's builder)

- **Table picker** (canvas board BE, chosen 2026-11-08). Each table row,
  the start table included, gets a schema dropdown in front of its table
  dropdown.
  - The schema dropdown starts on the scope's schema, so a join within one
    schema needs no extra input.
  - The table dropdown lists only the chosen schema's tables. Those come
    from §5.2 with `schema`, fetched the first time that schema is picked.
  - The schema dropdown is hidden when §5.7 lists only one schema (SQLite
    always does).
- **Table references** (design agreed 2026-11-08). A table is always named
  with its schema and source, so the type system rules out keying or
  requesting a table under the wrong scope by omission.
  - Types in `core/types.ts`: `SchemaRef = {source, schema}` and
    `TableRef = SchemaRef & {table}`, both branded. A `TableRef` is accepted
    wherever a `SchemaRef` is. Fields are `string | null`: null means "the
    server's default", which only happens when the schema list failed to
    load.
  - Pure builders in `lib/table-ref.ts`, with unit tests: `tableIn(schemaRef,
    name)`; `near(ownerRef, schema?, table)` for every wire name that is
    relative to something already held (an FK target to its column's table,
    a join column to the request's schema, a referrer to the viewed table);
    `refKey(ref)`, using the `visitKey` encoding. A ref never goes into a
    template string (it would print `[object Object]`), only through
    `refKey`.
  - `refInScope(table)` in `core/store.ts` is the one builder that reads the
    current scope. It is used only at the edges: URL, storage, history and
    table chips.
  - Every function that fetches, caches or links a table takes a
    `TableRef`, and a table request can only be built from one
    (`tableParams(ref)`). Module caches are keyed by `refKey(ref)` in place
    of the `scopeIdentity(table)` keys. `scopeIdentity()` keeps no table
    argument: it stays as the scope-level "same view?" check, which also
    runs while the scope loads. `applyScopeParams` and the implicit
    `scopeQuery()` go; request builders take the scope as an argument.
  - A view's start table as a ref is `startRef(view)`. `startTable(view)`,
    the name scope-keyed uses take (storage, the URL's `table=`, chips), is
    null for a join that starts in another schema. Closing a refused join
    that starts elsewhere switches to that schema when §5.7 lists it, as FK
    navigation does, and otherwise opens the scope's first table.
  - The join dialog drops a qualifier naming the scope's own schema before
    it saves or shows a join, and the view does the same once a schema
    restored from a link is confirmed. SQL mode checks `schema.table`
    against §5.7's list.
  - Bare names remain only at scope-relative edges: `tableRequest(name)`,
    `tableNameInView()`, `knownScopeKey(table)`, `listedTableNames()` and
    `startTable(view)`.
  - Exceptions: the boot prefetch (before the scope is known) and sibling
    links (they copy the page's own query).
  - Call sites: about 80 in 18 files, including the join's start table check
    (`table-chips.ts`), `tableMeta`, `joinPath`, `navigateWithSeededFilter`
    and the parser's `JoinCatalog`, which gains a schema dimension.
- **Column catalog.** `join-catalog.ts` `tableColumns` and the index cache
  (`indexesRead`, read by composite FK links) take a `TableRef`.
- **FK links in the grid.** `fkLink` (`features/column-parts.ts`) resolves
  its target with `near(owner, references.schema, references.table)`, where
  `owner` is the column's own table. `ColumnBase` gains the optional `schema`
  the join response sends (§3). Without it, the example in §3 opens
  `warehouse.users`.
- **FK suggestions.** `findForeignKey` (`lib/join-types.ts`) already skips
  any reference that carries a schema (#247), so it can't suggest a wrong
  pair. Cross-schema targets become suggestions by comparing resolved
  `TableRef`s.
- **Bands and record dialog** (board BG, band choice b, chosen 2026-11-08;
  widened 2026-11-09). A band names its table as join labels already do,
  table then alias. In a join that spans schemas every band is qualified,
  the scope's tables too, with the schema muted: `warehouse.shipments s`
  and `public.orders o`. A join within one schema looks as it does today.
  The record view, the columns menu headings, the meta row and the join
  chip use the same label.
- **SQL mode.** After `FROM` and `JOIN` the suggestions add the other
  schemas (`public.`). After `schema.` they list that schema's tables, read
  the first time it is named, with a foreign key clause first.
- **Saved joins.** Still stored under the scope (source and schema) the user
  saved them from. A cross-schema join shows only in that scope's chips.
- **URL.** The `join` param holds the canonical text, now with qualifiers
  when needed. `schema` stays the scope.
- **Filter and sort** keep `alias.column` (`spec/filter-dsl.md` §2 and §3). No change.

## 7. Touchpoints

- `spec/protocol.md` §5.11 and §5.11.1, `spec/openapi.yaml` (join object
  and response column)
- `spec/join-dsl.md` grammar, semantics and test table;
  `spec/fixtures/join-parser-tests.json` regenerated from it
- The five backends: Rust core (axum and actix-web), Go, Node, Flask, Spring
- `conformance/runner/`: new cases (§8)
- Seeds (§1): `tools/seed-gen` (regenerating `conformance/seed/seed.sql` and
  `.devcontainer/db/init/01-seed.sql`), `conformance/seed/seed.mysql.sql`,
  `conformance/seed/VERSION`
- `docs/adapter-decisions.md`: §5 rows above
- `frontend/src/lib/join-dsl.ts`, `join-def.ts`, `join-types.ts`,
  `join-draft.ts`; `frontend/src/features/join-catalog.ts`, `join-form.ts`,
  `join-sql.ts`, `join-view.ts`, `column-parts.ts`
- e2e: `cross-schema-join.spec.ts` (picker, bands, SQL suggestions and checks, the cross-schema FK link, common values, saved joins)

## 8. What "done" means

- Conformance passes on every port against Postgres and, where the port
  supports it, MySQL. SQLite runs only the rejection and no-`schema` cases:
  - `warehouse.shipments` ⋈ `public.orders` on `order_id = id`, with the
    request's schema `warehouse`, returns the joined rows, with `schema` on
    the `orders` columns only.
  - A join that names two same-named tables from two schemas, one aliased,
    returns rows from both.
  - A `schema` not in §5.7's list → 400 `invalid_join`.
  - A table not in the named schema → 400 `invalid_join`.
  - An adversarial schema name (quotes, `;`, NUL) → 400, never SQL.
  - A join without any `schema` fields behaves exactly as before.
- The join builder can add a table from another schema in Form and SQL
  mode, and suggests the cross-schema FK pair.
- `findForeignKey` matches on schema and table, with a unit test for the
  same-name case.
- An FK link on a joined column from another schema opens the table in
  that column's schema (the §3 example), with a unit test.
- The full three-browser e2e suite passes.

## 9. Related work

Do story 45 first. It has the server report the default source and schema,
and keys remembered settings on concrete names. Saved cross-schema joins
and the column catalog cache both depend on those stable scope keys, and
unqualified table names in a join resolve in the default schema that story
45 makes reliable. Story 45 is done.

The MySQL `warehouse` database was added here rather than through story 35
(conformance seed dialect parity), which still covers the rest of that seed.

## 10. Out of scope

- Joins across sources.
- SQLite `ATTACH`.
- More than 4 tables, or non-equality `ON`.
