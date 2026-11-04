import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { toWire } from "../src/lib/join-def.ts";
import type { JoinCatalog } from "../src/lib/join-dsl.ts";
import { parseJoin, printJoin } from "../src/lib/join-dsl.ts";
import { findForeignKey, joinMismatch, pairNote, unjoinableReason } from "../src/lib/join-types.ts";

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
const fixture: { catalog: JoinCatalog; cases: JoinCase[] } = JSON.parse(readFileSync(fixtureUrl, "utf8"));

for (const c of fixture.cases) {
  test(`${c.name}: ${JSON.stringify(c.input.slice(0, 60))}`, () => {
    const result = parseJoin(c.input, { catalog: c.no_catalog ? undefined : fixture.catalog });
    if (c.expect) {
      assert.ok("def" in result, "error" in result ? result.error.message : "");
      assert.deepEqual(result.def, c.expect);
      assert.equal(printJoin(result.def), c.canonical);
      // text -> definition -> text is stable
      const again = parseJoin(c.canonical as string, { catalog: c.no_catalog ? undefined : fixture.catalog });
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
  assert.deepEqual(findForeignKey([{ table: "orders", columns: orders }], "users", users), {
    at: 0,
    leftColumn: "user_id",
    rightColumn: "id",
  });
  assert.deepEqual(findForeignKey([{ table: "users", columns: users }], "orders", orders), {
    at: 0,
    leftColumn: "id",
    rightColumn: "user_id",
  });
  assert.equal(pairNote({ type: "jsonb", class: "json" }, undefined), "jsonb: not joinable");
  assert.equal(pairNote({ type: "text", class: "text" }, users[0]), "text ≠ uuid");
  assert.equal(pairNote(users[0], users[0]), null);
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
