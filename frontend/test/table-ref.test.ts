import assert from "node:assert/strict";
import { test } from "node:test";
import { visitKey } from "../src/lib/scope-key.ts";
import { near, refKey, sameTable, schemaRef, scopeQuery, tableIn, tableParams } from "../src/lib/table-ref.ts";

const warehouse = schemaRef("primary", "warehouse");

test("a name relative to a table resolves in that table's schema unless the wire names another", () => {
  const orders = near(warehouse, "public", "orders");
  assert.deepEqual({ ...orders }, { source: "primary", schema: "public", table: "orders" });
  // spec/protocol.md §5.11.4: public.orders.user_id → users, with no schema, is public.users.
  assert.ok(sameTable(near(orders, undefined, "users"), tableIn(schemaRef("primary", "public"), "users")));
  assert.ok(!sameTable(near(orders, undefined, "users"), tableIn(warehouse, "users")));
});

test("refKey uses visitKey's encoding, so keys built either way agree", () => {
  assert.equal(refKey(tableIn(warehouse, "users")), visitKey("primary", "warehouse", "users"));
  assert.equal(refKey(tableIn(warehouse, "users"), "id"), visitKey("primary", "warehouse", "users", "id"));
  assert.equal(refKey(warehouse), visitKey("primary", "warehouse"));
  assert.notEqual(refKey(tableIn(warehouse, "users")), refKey(near(warehouse, "public", "users")));
});

test("requests send only the names that are known", () => {
  assert.equal(
    tableParams(near(warehouse, "public", "orders"), { limit: "1" }).toString(),
    "table=orders&limit=1&source=primary&schema=public",
  );
  assert.equal(scopeQuery(schemaRef(null, null)), "");
  assert.equal(scopeQuery(schemaRef("primary", null)), "?source=primary");
});
