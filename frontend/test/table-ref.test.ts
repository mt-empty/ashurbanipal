import assert from "node:assert/strict";
import { test } from "node:test";
import { visitKey } from "../src/lib/scope-key.ts";
import { near, refKey, relatedTables, schemaRef, scopeQuery, tableIn, tableParams } from "../src/lib/table-ref.ts";

const warehouse = schemaRef("primary", "warehouse");
const inPublic = (table: string) => tableIn(schemaRef("primary", "public"), table);

test("a name relative to a table resolves in that table's schema unless the wire names another", () => {
  const orders = near(warehouse, "public", "orders");
  assert.deepEqual({ ...orders }, { source: "primary", schema: "public", table: "orders" });
  // spec/protocol.md §5.11.4: public.orders.user_id → users, with no schema, is public.users.
  assert.equal(refKey(near(orders, undefined, "users")), refKey(tableIn(schemaRef("primary", "public"), "users")));
  assert.notEqual(refKey(near(orders, undefined, "users")), refKey(tableIn(warehouse, "users")));
});

test("refKey uses visitKey's encoding, so keys built either way agree", () => {
  assert.equal(refKey(tableIn(warehouse, "users")), visitKey("primary", "warehouse", "users"));
  assert.equal(refKey(tableIn(warehouse, "users"), "id"), visitKey("primary", "warehouse", "users", "id"));
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

test("relatedTables marks tables a key leads to or comes from, across schemas, with a count for several", () => {
  const fk = (name: string, table: string, schema?: string) => ({
    name,
    type: "uuid",
    class: "uuid" as const,
    key: "fk" as const,
    references: { schema, table, column: "id" },
  });
  const orders = inPublic("orders");
  const found = relatedTables([
    {
      table: orders,
      columns: [fk("user_id", "users"), fk("billing_user_id", "users"), fk("carrier_id", "carriers", "warehouse")],
      referrers: [
        { table: "order_extra", constraint: "c1", columns: [{ from: "order_id", to: "id" }] },
        { table: "shipments", schema: "warehouse", constraint: "c2", columns: [{ from: "order_id", to: "id" }] },
      ],
    },
  ]);
  assert.equal(found.get(refKey(inPublic("users"))), "orders.user_id → users.id (+1 more)");
  assert.equal(found.get(refKey(inPublic("order_extra"))), "order_extra.order_id → orders.id");
  assert.equal(found.get(refKey(near(orders, "warehouse", "carriers"))), "orders.carrier_id → carriers.id");
  assert.equal(found.get(refKey(near(orders, "warehouse", "shipments"))), "shipments.order_id → orders.id");
  assert.equal(found.has(refKey(inPublic("products"))), false);
});

test("relatedTables marks a self-reference and has nothing to mark without earlier tables", () => {
  const employees = inPublic("employees");
  const manager = {
    name: "manager_id",
    type: "uuid",
    class: "uuid" as const,
    key: "fk" as const,
    references: { table: "employees", column: "id" },
  };
  assert.equal(
    relatedTables([{ table: employees, columns: [manager], referrers: [] }]).get(refKey(employees)),
    "employees.manager_id → employees.id",
  );
  assert.equal(relatedTables([]).size, 0);
});
