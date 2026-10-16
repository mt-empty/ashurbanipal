import assert from "node:assert/strict";
import { test } from "node:test";
import { addJoin, defToDraft, draftToDef, newDraft, removeLastJoin } from "../src/lib/join-draft.ts";
import { parseJoin, printJoin } from "../src/lib/join-dsl.ts";

const parse = (text: string) => {
  const r = parseJoin(text);
  assert.ok("def" in r);
  return r.def;
};

test("a parsed join survives the draft round trip", () => {
  for (const text of [
    "FROM orders JOIN users ON orders.user_id = users.id",
    "SELECT o.*, u.email FROM orders o LEFT JOIN users u ON o.user_id = u.id",
    "SELECT u.email FROM orders o LEFT JOIN users u ON o.user_id = u.id",
  ]) {
    const def = parse(text);
    const back = draftToDef(defToDraft(def));
    assert.ok("def" in back);
    assert.equal(printJoin(back.def), printJoin(def));
  }
});

test("a table with no selected column drops out of the column list", () => {
  const draft = defToDraft(parse("SELECT u.email FROM orders o JOIN users u ON o.user_id = u.id"));
  assert.deepEqual(draft.columns, [[], ["email"]]);
});

test("an incomplete draft says what is missing", () => {
  const draft = newDraft("orders");
  assert.deepEqual(draftToDef(draft), { error: "Choose a table for join 1." });
  draft.joins[0].table = "users";
  assert.deepEqual(draftToDef(draft), { error: "Finish the column pair of join 1." });
  draft.joins[0].on[0] = { leftJoin: 0, leftColumn: "user_id", rightColumn: "id" };
  assert.ok("def" in draftToDef(draft));
});

test("the same table twice needs an alias", () => {
  const draft = newDraft("orders");
  draft.joins[0] = {
    type: "inner",
    table: "orders",
    alias: "",
    on: [{ leftJoin: 0, leftColumn: "id", rightColumn: "id" }],
  };
  assert.match((draftToDef(draft) as { error: string }).error, /second use an alias/);
  draft.joins[0].alias = "b";
  assert.ok("def" in draftToDef(draft));
});

test("selecting no column at all is rejected", () => {
  const draft = newDraft("orders");
  draft.joins[0] = {
    type: "inner",
    table: "users",
    alias: "",
    on: [{ leftJoin: 0, leftColumn: "user_id", rightColumn: "id" }],
  };
  draft.columns = [[], []];
  assert.deepEqual(draftToDef(draft), { error: "Select at least one column." });
});

test("adding and removing a join keeps one column entry per table", () => {
  const draft = newDraft("orders");
  addJoin(draft);
  assert.equal(draft.columns.length, 3);
  removeLastJoin(draft);
  assert.equal(draft.columns.length, 2);
  assert.equal(draft.joins.length, 1);
});
