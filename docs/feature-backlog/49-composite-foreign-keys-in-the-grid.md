# Composite foreign keys in the grid

> **Status:** PARTIAL · **Area:** frontend · **Ref:** grid and record view shipped (PR #231, #232); 3 gaps open

**Ask:** let the user see and follow a composite foreign key (two or more
columns that together reference one row elsewhere) wherever a single-column
one works.

`spec/protocol.md` §5.4.1 leaves composite FKs out of `key`/`references`, so
the frontend reads them from the table's structure (§5.10) into
`TableMeta.compositeFkOf` (`frontend/src/features/table-meta.ts`).
`docs/design.md` §3 ("Foreign-key navigation") describes the shipped
behaviour. Three gaps remain.

## 1. Join builder suggestion

`findForeignKey` (`frontend/src/lib/join-types.ts`) suggests an `ON` pair
from single-column `references` only. A composite FK should suggest all its
pairs (§5.11.1 allows up to 3). Both callers need it: the form
(`features/join-form.ts`) and the SQL text (`features/join-sql.ts`). The
structure lookup is cached per table (`features/structure.ts`).

## 2. Links in a join view

`fkLink` (`frontend/src/features/column-parts.ts`) takes composite FKs from
the table in view, so a join view links single-column FK cells but not
composite ones. It needs each joined table's `TableMeta`.

## 3. A NULL member gives no reason

When any member is NULL, `fkLink` returns no link, so a non-null member cell
under a 🔗 header is plain text with no explanation. Give it a title that
names the NULL column, as the referenced-by list already does for a
disabled entry (`features/referenced-by.ts`). The seed's composite FK
(`inventory_counts` → `inventory_locations`) has NOT NULL members, so an
e2e test needs a mocked response or a seed change.

## Done means

- The three gaps closed, with unit tests for `findForeignKey` and the full
  three-browser e2e suite.

## Alternative to weigh first

Gaps 1 and 2 extend a frontend workaround: §5.4.1 MUST leave composite FKs
out, so the frontend rebuilds them from §5.10. Reporting them on the wire
instead (a table-level `foreign_keys` list with `{from, to}` pairs, the
§5.10 shape, which §5.11.4 would then carry) gives `fkLink` and
`findForeignKey` one source, and helps [[27-er-relationship-diagram]] and
[[50-referenced-by-view-improvements]] too. Cost: spec, five ports and
conformance, against two frontend patches.

## Out of scope

- The referenced-by view: [[50-referenced-by-view-improvements]].
