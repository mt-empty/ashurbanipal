import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConstraintFk } from "../src/core/types.ts";
import { keyDescription } from "../src/lib/column-key.ts";

const users = { table: "users", column: "id" };
const location: ConstraintFk = {
  name: "inventory_counts_location_fk",
  table: "inventory_locations",
  columns: [
    { from: "warehouse_code", to: "warehouse_code" },
    { from: "bin_code", to: "bin_code" },
  ],
  on_delete: "NO ACTION",
  on_update: "NO ACTION",
};

test("keyDescription labels primary, foreign and composite foreign keys", () => {
  assert.equal(keyDescription({ name: "note", type: "text" }), null);
  assert.deepEqual(keyDescription({ name: "id", type: "uuid", key: "pk" }), { icon: "🔑", label: "primary key" });
  assert.deepEqual(keyDescription({ name: "user_id", type: "uuid", key: "fk", references: users }), {
    icon: "🔗",
    label: "foreign key, references users.id",
  });
  assert.deepEqual(
    keyDescription({ name: "user_id", type: "uuid", key: "pk", references: { ...users, schema: "auth" } }),
    { icon: "🔑", label: "primary key, also references auth.users.id" },
  );
  assert.deepEqual(keyDescription({ name: "bin_code", type: "text" }, location), {
    icon: "🔗",
    label: "part of foreign key (warehouse_code, bin_code) → inventory_locations(warehouse_code, bin_code)",
  });
});
