import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dropScopeSchema, joinLabel, labelSchemas, toWire } from "../src/lib/join-def.ts";
import type { JoinCatalog } from "../src/lib/join-dsl.ts";
import { parseJoin, printJoin } from "../src/lib/join-dsl.ts";
import { findForeignKey, joinMismatch, pairNote, unjoinableReason } from "../src/lib/join-types.ts";
import { near, schemaRef, tableIn } from "../src/lib/table-ref.ts";

const inPublic = (table: string) => tableIn(schemaRef("primary", "public"), table);

// The single join-text -> JoinDef parser (spec/join-dsl.md). Cases come from
// spec/fixtures/join-parser-tests.json, generated from the doc's §5 table.

interface JoinCase {
  name: string;
  input: string;
  no_catalog?: boolean;
  expect?: unknown;
  canonical?: string;
  expect_error?: { code: string; line?: number; column?: number; suggest?: string };
}

const fixtureUrl = new URL("../../spec/fixtures/join-parser-tests.json", import.meta.url);
const fixture: {
  catalog: JoinCatalog;
  schemas: Record<string, JoinCatalog | null>;
  cases: JoinCase[];
} = JSON.parse(readFileSync(fixtureUrl, "utf8"));
const optionsFor = (c: JoinCase) => (c.no_catalog ? {} : { catalog: fixture.catalog, schemas: fixture.schemas });

for (const c of fixture.cases) {
  test(`${c.name}: ${JSON.stringify(c.input.slice(0, 60))}`, () => {
    const result = parseJoin(c.input, optionsFor(c));
    if (c.expect) {
      assert.ok("def" in result, "error" in result ? result.error.message : "");
      assert.deepEqual(result.def, c.expect);
      assert.equal(printJoin(result.def), c.canonical);
      // text -> definition -> text is stable
      const again = parseJoin(c.canonical as string, optionsFor(c));
      assert.ok("def" in again);
      assert.deepEqual(again.def, c.expect);
      return;
    }
    assert.ok("error" in result, "expected a rejection");
    const want = c.expect_error as NonNullable<JoinCase["expect_error"]>;
    assert.equal(result.error.code, want.code, result.error.message);
    if (want.line !== undefined) assert.equal(result.error.line, want.line);
    if (want.column !== undefined) assert.equal(result.error.column, want.column);
    assert.equal(result.error.suggest, want.suggest);
  });
}

test("toWire merges tables into joins and omits columns for all columns", () => {
  const parsed = parseJoin("FROM orders o LEFT JOIN users u ON o.user_id = u.id", { catalog: fixture.catalog });
  assert.ok("def" in parsed);
  assert.deepEqual(
    toWire(parsed.def, () => []),
    {
      table: "orders",
      joins: [{ type: "left", table: "users", on: [{ left: { join: 0, column: "user_id" }, right: "id" }] }],
    },
  );
});

test("toWire expands alias.* in catalog order beside explicit columns", () => {
  const parsed = parseJoin("SELECT o.*, u.email FROM orders o JOIN users u ON o.user_id = u.id", {
    catalog: fixture.catalog,
  });
  assert.ok("def" in parsed);
  const wire = toWire(parsed.def, (join) => fixture.catalog[parsed.def.tables[join].table] ?? []);
  assert.deepEqual(wire.columns?.slice(0, 2), [
    { join: 0, column: "id" },
    { join: 0, column: "user_id" },
  ]);
  assert.deepEqual(wire.columns?.at(-1), { join: 1, column: "email" });
});

test("toWire expands alias.* items that leave a table out of the select list", () => {
  const parsed = parseJoin(
    "SELECT o.*, u.* FROM orders o JOIN users u ON o.user_id = u.id JOIN events e ON e.user_id = u.id",
    { catalog: fixture.catalog },
  );
  assert.ok("def" in parsed);
  const wire = toWire(parsed.def, (join) => fixture.catalog[parsed.def.tables[join].table] ?? []);
  assert.ok(wire.columns);
  assert.ok(wire.columns.every((c) => c.join !== 2));
});

test("join pair checks follow the server's class, and the enum_type for enums", () => {
  const uuid = { type: "uuid", class: "uuid" as const };
  const int = { type: "integer", class: "number" as const };
  const big = { type: "bigint", class: "number" as const };
  const text = { type: "text", class: "text" as const };
  const status = { type: "order_status", class: "enum" as const, enum_type: "public.order_status" };
  const ticket = { type: "ticket_status", class: "enum" as const, enum_type: "public.ticket_status" };
  // A domain over order_status shows its own name but is the same enum underneath.
  const open = { type: "open_status", class: "enum" as const, enum_type: "public.order_status" };
  const jsonb = { type: "jsonb", class: "json" as const };
  assert.equal(joinMismatch(uuid, uuid), null);
  assert.equal(joinMismatch(int, big), null);
  assert.equal(joinMismatch(status, status), null);
  assert.equal(joinMismatch(open, status), null);
  assert.equal(joinMismatch(status, uuid)?.note, "order_status ≠ uuid");
  assert.equal(joinMismatch(status, uuid)?.message, "enum cannot be joined to uuid. Pick columns of the same kind.");
  assert.equal(joinMismatch(status, ticket)?.note, "order_status ≠ ticket_status");
  assert.equal(
    joinMismatch(status, ticket)?.message,
    "order_status cannot be joined to ticket_status: they are different enumerated types.",
  );
  assert.equal(joinMismatch(status, text)?.note, "order_status ≠ text");
  // Two text columns pair unless both report a collation and they differ.
  const ci = { type: "varchar(20)", class: "text" as const, collation: "utf8mb4_0900_ai_ci" };
  const bin = { type: "varchar(20)", class: "text" as const, collation: "utf8mb4_bin" };
  assert.equal(joinMismatch(ci, ci), null);
  assert.equal(joinMismatch(ci, text), null);
  assert.equal(joinMismatch(ci, bin)?.note, "different collations");
  assert.equal(
    joinMismatch(ci, bin)?.message,
    "varchar(20) and varchar(20) use different text collations (utf8mb4_0900_ai_ci and utf8mb4_bin).",
  );
  assert.equal(joinMismatch(jsonb, text)?.note, "jsonb: not joinable");
  assert.equal(joinMismatch(text, jsonb)?.message, "jsonb columns cannot be joined. Pick another column.");
  assert.equal(unjoinableReason({ type: "double precision", class: "float" }), "double precision: not joinable");
  assert.equal(unjoinableReason(uuid), null);
  assert.equal(
    unjoinableReason({ type: "set('pending','completed','cancelled')", class: "other" }),
    "set('pending','complete…: not joinable",
  );
});

test("a pair check supplied by the page rejects a mismatched pair at its second column", () => {
  const text = "FROM orders o JOIN users u ON u.id = o.status";
  const check = (a: { column: string }, b: { column: string }) =>
    a.column === "id" && b.column === "status" ? "enum cannot be joined to uuid." : null;
  const result = parseJoin(text, { pairCheck: check });
  assert.ok("error" in result);
  assert.equal(result.error.code, "type-mismatch");
  assert.equal(result.error.message, "enum cannot be joined to uuid.");
  assert.equal(text.slice(result.error.index), "o.status");
  assert.ok("def" in parseJoin(text));
});

test("a foreign key is found in either direction and greyed notes follow the other side", () => {
  const orders = [
    {
      name: "user_id",
      type: "uuid",
      class: "uuid" as const,
      key: "fk" as const,
      references: { table: "users", column: "id" },
    },
  ];
  const users = [{ name: "id", type: "uuid", class: "uuid" as const }];
  assert.deepEqual(findForeignKey([{ table: inPublic("orders"), columns: orders }], inPublic("users"), users), {
    at: 0,
    leftColumn: "user_id",
    rightColumn: "id",
  });
  assert.deepEqual(findForeignKey([{ table: inPublic("users"), columns: users }], inPublic("orders"), orders), {
    at: 0,
    leftColumn: "id",
    rightColumn: "user_id",
  });
  assert.equal(pairNote({ type: "jsonb", class: "json" }, undefined), "jsonb: not joinable");
  assert.equal(pairNote({ type: "text", class: "text" }, users[0]), "text ≠ uuid");
  assert.equal(pairNote(users[0], users[0]), null);
});

test("a foreign key into another schema matches that schema's table, not a same-named one", () => {
  const events = [
    {
      name: "handled_by_user_id",
      type: "uuid",
      class: "uuid" as const,
      key: "fk" as const,
      references: { schema: "public", table: "users", column: "id" },
    },
  ];
  const users = [{ name: "id", type: "uuid", class: "uuid" as const }];
  const shipmentEvents = near(inPublic("x"), "warehouse", "shipment_events");
  const warehouseUsers = near(shipmentEvents, undefined, "users");
  assert.equal(findForeignKey([{ table: shipmentEvents, columns: events }], warehouseUsers, users), null);
  assert.equal(findForeignKey([{ table: warehouseUsers, columns: users }], shipmentEvents, events), null);
  assert.deepEqual(findForeignKey([{ table: shipmentEvents, columns: events }], inPublic("users"), users), {
    at: 0,
    leftColumn: "handled_by_user_id",
    rightColumn: "id",
  });
  assert.deepEqual(findForeignKey([{ table: inPublic("users"), columns: users }], shipmentEvents, events), {
    at: 0,
    leftColumn: "id",
    rightColumn: "handled_by_user_id",
  });
});

test("toWire keeps alias.* items written out of table order as an explicit column list", () => {
  const forward = parseJoin("SELECT o.*, u.* FROM orders o JOIN users u ON o.user_id = u.id", {
    catalog: fixture.catalog,
  });
  assert.ok("def" in forward);
  assert.equal(toWire(forward.def, () => []).columns, undefined);
  const reversed = parseJoin("SELECT u.*, o.* FROM orders o JOIN users u ON o.user_id = u.id", {
    catalog: fixture.catalog,
  });
  assert.ok("def" in reversed);
  const wire = toWire(reversed.def, (join) => fixture.catalog[reversed.def.tables[join].table] ?? []);
  assert.equal(wire.columns?.[0].join, 1);
  assert.equal(wire.columns?.at(-1)?.join, 0);
});

test("toWire sends each table's own schema only where the text names one", () => {
  const parsed = parseJoin(
    "FROM warehouse.shipments s LEFT JOIN orders o ON s.order_id = o.id",
    optionsFor({} as JoinCase),
  );
  assert.ok("def" in parsed);
  assert.deepEqual(
    toWire(parsed.def, () => []),
    {
      table: "shipments",
      schema: "warehouse",
      joins: [{ type: "left", table: "orders", on: [{ left: { join: 0, column: "order_id" }, right: "id" }] }],
    },
  );
});

test("dropScopeSchema drops a qualifier that names the scope's own schema", () => {
  const parsed = parseJoin("FROM warehouse.shipments s JOIN public.orders o ON s.order_id = o.id", {});
  assert.ok("def" in parsed);
  const canonical = dropScopeSchema(parsed.def, "warehouse");
  assert.equal(printJoin(canonical), "SELECT *\nFROM shipments s\nINNER JOIN public.orders o ON s.order_id = o.id");
  assert.equal(dropScopeSchema(canonical, "warehouse"), canonical);
  assert.equal(dropScopeSchema(parsed.def, null), parsed.def);
});

test("two same-named tables from two schemas are named in the clash message", () => {
  const parsed = parseJoin("FROM warehouse.users JOIN public.users ON users.id = users.id", {});
  assert.ok("error" in parsed);
  assert.equal(parsed.error.code, "duplicate-name");
  assert.match(parsed.error.message, /warehouse\.users and public\.users/);
});

test("a pair check is told each side's schema", () => {
  const seen: unknown[] = [];
  parseJoin("FROM warehouse.shipments s JOIN orders o ON s.order_id = o.id", {
    pairCheck: (a, b) => {
      seen.push(a, b);
      return null;
    },
  });
  assert.deepEqual(seen, [
    { schema: "warehouse", table: "shipments", column: "order_id" },
    { table: "orders", column: "id" },
  ]);
});

test("a join that spans schemas labels every table with its schema; one within the scope labels none", () => {
  const cross = parseJoin("FROM shipments s LEFT JOIN public.orders o ON s.order_id = o.id", {});
  assert.ok("def" in cross);
  assert.deepEqual(labelSchemas(cross.def, "warehouse"), ["warehouse", "public"]);
  assert.equal(joinLabel(cross.def, "warehouse"), "warehouse.shipments s ⟕ public.orders o");
  const within = parseJoin("FROM orders o JOIN users u ON o.user_id = u.id", {});
  assert.ok("def" in within);
  assert.equal(joinLabel(within.def, "public"), "orders o ⋈ users u");
  // No scope name to write (the schema list failed): only the qualified table says its schema.
  assert.equal(joinLabel(cross.def, null), "shipments s ⟕ public.orders o");
});

test("a qualifier naming the scope's schema is dropped as the table is read", () => {
  const parsed = parseJoin("FROM public.orders o JOIN users u ON o.user_id = u.id", { scopeSchema: "public" });
  assert.ok("def" in parsed);
  assert.deepEqual(parsed.def.tables[0], { table: "orders", alias: "o" });
  const twice = parseJoin("FROM users JOIN public.users ON users.id = users.id", { scopeSchema: "public" });
  assert.ok("error" in twice);
  assert.equal(twice.error.code, "duplicate-name");
  assert.match(twice.error.message, /table "users" appears twice/);
});

test("an unknown column names its table with the schema it was written with", () => {
  const parsed = parseJoin("FROM users LEFT JOIN warehouse.users w ON users.id = w.idd", optionsFor({} as JoinCase));
  assert.ok("error" in parsed);
  assert.equal(parsed.error.code, "unknown-column");
  assert.match(parsed.error.message, /^warehouse\.users has no column idd/);
});
