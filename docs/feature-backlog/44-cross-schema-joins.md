# Cross-schema joins

> **Status:** OPEN · **Area:** spec, ports, conformance, frontend, docs, e2e · **Ref:** extends stories 40 (join route) and 41 (join builder); needs story 45 first

Let one join name tables from more than one schema of the same source.
Read-only, like every join. A join still never crosses a source.

## 1. The ask

A user can already follow a foreign key into another schema: an FK cell
opens `warehouse.shipments` → `public.orders`, and "referenced by" lists
referrers in other schemas. But a join stays in one schema
(`spec/protocol.md` §5.11: "Every table in the join is resolved in this one
schema"). So the user can walk from a shipment to its order, but cannot see
shipments and orders side by side in one grid.

The seed already has the shapes to test against:

- `warehouse.shipments.order_id` → `public.orders.id`
- `warehouse.shipment_events.handled_by_user_id` → `public.users.id`
- `users` exists in both `public` and `ashb_test_referenced_by_partitioning`,
  so a join can name two tables with the same name.

## 2. Decisions so far

- **Same source only.** Each source is one connection (§1 "Resolved
  source"). A join across sources would need two connections and a
  client-side merge. Out of scope.
- **Every new field is optional.** A request with none of them behaves
  exactly as today.
- **The join object is self-contained.** The base table and each `joins`
  entry may carry their own `schema`. This mirrors the join DSL, where
  `FROM` already takes `schema.table`, and saved joins are stored as that
  DSL text (`frontend/src/lib/join-saved.ts`).
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

- **Table picker.** Lists the current schema's tables first, then other
  schemas' tables grouped under their schema name. Needs a board on the
  design canvas before building (see the "Ashurbanipal UI" canvas).
- **Column catalog.** `join-catalog.ts` `tableColumns(table)` fetches
  `/tables/data?limit=1` in the current scope only. It must take a schema,
  and its cache key must include it.
- **FK suggestions.** `findForeignKey` (`frontend/src/lib/join-types.ts`)
  matches by `references.table` alone and ignores `references.schema`.
  - Today that can suggest a wrong `ON` pair: a cross-schema FK can match
    a same-named table in the current schema.
  - Fix it first, as its own small change: match on schema and table.
  - Then offer cross-schema FK targets as join suggestions.
- **Bands and record dialog.** A band's label stays the effective name. Its
  tooltip shows `schema.table` when the schema differs from the scope.
- **Saved joins.** Still stored under the scope (source and schema) the user
  saved them from. A cross-schema join shows only in that scope's chips.
- **URL.** The `join` param holds the canonical text, now with qualifiers
  when needed. `schema` stays the scope.
- **Filter and sort** keep `alias.column` (`spec/filter-dsl.md` §1). No change.

## 7. Touchpoints

- `spec/protocol.md` §5.11 and §5.11.1, `spec/openapi.yaml` (join object
  and response column)
- `spec/join-dsl.md` grammar, semantics and test table;
  `spec/fixtures/join-parser-tests.json` regenerated from it
- The five backends: Rust core (axum and actix-web), Go, Node, Flask, Spring
- `conformance/runner/`: new cases (§8)
- `docs/adapter-decisions.md`: §5 rows above
- `frontend/src/lib/join-dsl.ts`, `join-def.ts`, `join-types.ts`,
  `join-draft.ts`; `frontend/src/features/join-catalog.ts`, `join-form.ts`,
  `join-sql.ts`, `join-view.ts`
- e2e: `join-builder.spec.ts`, `join-result.spec.ts`

## 8. What "done" means

- Conformance passes on every port against Postgres, and where the port
  supports them, MySQL and SQLite:
  - `warehouse.shipments` ⋈ `public.orders` on `order_id = id` returns the
    joined rows, with `schema` on the `orders` columns only.
  - A `schema` not in §5.7's list → 400 `invalid_join`.
  - A table not in the named schema → 400 `invalid_join`.
  - An adversarial schema name (quotes, `;`, NUL) → 400, never SQL.
  - A join without any `schema` fields behaves exactly as before.
- The join builder can add a table from another schema in Form and SQL
  mode, and suggests the cross-schema FK pair.
- `findForeignKey` matches on schema and table, with a unit test for the
  same-name case.
- The full three-browser e2e suite passes.

## 9. Related work

Do story 45 first. It has the server report the default source and schema,
and keys remembered settings on concrete names. Saved cross-schema joins
and the column catalog cache both depend on those stable scope keys, and
unqualified table names in a join resolve in the default schema that story
45 makes reliable.

## 10. Out of scope

- Joins across sources.
- SQLite `ATTACH`.
- More than 4 tables, or non-equality `ON`.
