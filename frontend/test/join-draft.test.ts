import assert from "node:assert/strict";
import { test } from "node:test";
import { addJoin, defToDraft, draftToDef, newDraft, removeJoin } from "../src/lib/join-draft.ts";
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
    "SELECT u.full_name, o.id FROM orders o LEFT JOIN users u ON o.user_id = u.id",
    "SELECT u.*, o.id FROM orders o LEFT JOIN users u ON o.user_id = u.id",
    "SELECT o.*, u.* FROM orders o LEFT JOIN users u ON o.user_id = u.id",
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

test("a draft with every join removed is not a join", () => {
  const draft = newDraft("orders");
  removeJoin(draft, 0);
  assert.deepEqual(draftToDef(draft), { error: "Add a table to join." });
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
  removeJoin(draft, 1);
  assert.equal(draft.columns.length, 2);
  assert.equal(draft.joins.length, 1);
});

test("removing a middle join clears pairs that pointed at it and shifts later positions", () => {
  const def = parse(
    "FROM orders o JOIN users u ON o.user_id = u.id JOIN order_extra x ON x.order_id = o.id JOIN events e ON e.user_id = u.id AND e.id = x.order_id",
  );
  const draft = defToDraft(def);
  removeJoin(draft, 0); // drop users
  assert.deepEqual(
    draft.joins.map((j) => j.table),
    ["order_extra", "events"],
  );
  assert.deepEqual(draft.joins[0].on[0], { leftJoin: 0, leftColumn: "id", rightColumn: "order_id" });
  assert.deepEqual(draft.joins[1].on[0], { leftJoin: 0, leftColumn: "", rightColumn: "user_id" });
  assert.deepEqual(draft.joins[1].on[1], { leftJoin: 1, leftColumn: "order_id", rightColumn: "id" });
});

test("ticking a column keeps the written order and adds it after", () => {
  const draft = defToDraft(parse("SELECT u.email, o.id FROM orders o JOIN users u ON o.user_id = u.id"));
  draft.columns[0] = ["id", "status"];
  const back = draftToDef(draft);
  assert.ok("def" in back);
  assert.equal(printJoin(back.def).split("\n")[0], "SELECT u.email, o.id, o.status");
});

test("removing a join drops its written columns and renumbers the rest", () => {
  const draft = defToDraft(
    parse("SELECT e.id, o.id FROM orders o JOIN users u ON o.user_id = u.id JOIN events e ON e.user_id = u.id"),
  );
  removeJoin(draft, 0);
  assert.deepEqual(draft.order, [
    { join: 1, column: "id" },
    { join: 0, column: "id" },
  ]);
});
