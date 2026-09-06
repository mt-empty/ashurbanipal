import assert from "node:assert/strict";
import { test } from "node:test";
import type { Column, Row, TableData } from "../src/core/types.ts";
import { collectNewRowKeys, rowKey } from "../src/lib/row-diff.ts";

// The PK diff behind the new-since-refresh row highlight (ui-guidelines R10,
// covered end-to-end by refresh-highlight.spec.ts). Pure since the split: the
// "same view" test and the previous payload are store.ts's to hold.

const pk = (name: string): Column => ({ name, type: "int4", key: "pk" });
const plain = (name: string): Column => ({ name, type: "text" });
const data = (columns: Column[], rows: Row[]): TableData => ({ columns, rows, total_approx: rows.length });

test("rowKey follows pkNames order and is stable for equal values", () => {
  assert.equal(rowKey(["id"], { id: "1", x: "a" }), rowKey(["id"], { id: "1", x: "b" }));
  assert.notEqual(rowKey(["a", "b"], { a: "1", b: "2" }), rowKey(["b", "a"], { a: "1", b: "2" }));
  assert.equal(rowKey(["id"], { id: null }), rowKey(["id"], { id: null }));
  assert.notEqual(rowKey(["id"], { id: null }), rowKey(["id"], { id: "null" }));
});

test("no highlight when highlightNew is off", () => {
  const prev = data([pk("id")], [{ id: "1" }]);
  assert.deepEqual(collectNewRowKeys(prev, data([pk("id")], [{ id: "2" }]), { highlightNew: false, sameScope: true }), {
    pkNames: [],
  });
});

test("no highlight on the first fetch (no previous payload)", () => {
  assert.deepEqual(collectNewRowKeys(null, data([pk("id")], [{ id: "1" }]), { highlightNew: true, sameScope: true }), {
    pkNames: [],
  });
});

test("no highlight when the scope changed", () => {
  const prev = data([pk("id")], [{ id: "1" }]);
  assert.deepEqual(collectNewRowKeys(prev, data([pk("id")], [{ id: "2" }]), { highlightNew: true, sameScope: false }), {
    pkNames: [],
  });
});

test("no highlight when the table has no primary key", () => {
  const prev = data([plain("a")], [{ a: "x" }]);
  assert.deepEqual(collectNewRowKeys(prev, data([plain("a")], [{ a: "y" }]), { highlightNew: true, sameScope: true }), {
    pkNames: [],
  });
});

test("same scope + PK: only rows absent from the previous fetch are new", () => {
  const cols = [pk("id"), plain("status")];
  const prev = data(cols, [
    { id: "1", status: "old" },
    { id: "2", status: "old" },
  ]);
  const next = data(cols, [
    { id: "1", status: "edited" }, // same PK, changed field -> not new
    { id: "3", status: "fresh" }, // absent before -> new
    // id 2 dropped -> simply ignored
  ]);
  const { newRowKeys, pkNames } = collectNewRowKeys(prev, next, { highlightNew: true, sameScope: true });
  assert.deepEqual(pkNames, ["id"]);
  assert.ok(newRowKeys);
  assert.deepEqual([...newRowKeys], [rowKey(["id"], { id: "3" })]);
  assert.ok(!newRowKeys.has(rowKey(["id"], { id: "1" })));
});

test("composite primary key combines both columns", () => {
  const cols = [pk("org"), pk("slug"), plain("v")];
  const prev = data(cols, [{ org: "a", slug: "x", v: "1" }]);
  const next = data(cols, [
    { org: "a", slug: "x", v: "2" }, // same composite key -> not new
    { org: "a", slug: "y", v: "1" }, // new
  ]);
  const { newRowKeys, pkNames } = collectNewRowKeys(prev, next, { highlightNew: true, sameScope: true });
  assert.deepEqual(pkNames, ["org", "slug"]);
  assert.deepEqual([...(newRowKeys ?? [])], [rowKey(["org", "slug"], { org: "a", slug: "y" })]);
});
