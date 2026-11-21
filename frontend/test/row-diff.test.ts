import assert from "node:assert/strict";
import { test } from "node:test";
import type { Column, Row, ViewData } from "../src/core/types.ts";
import { changedRowsText, collectRowChanges, rowKey } from "../src/lib/row-diff.ts";

// The PK diff behind the since-refresh new-row and changed-cell highlight (ui-guidelines R10,
// covered end-to-end by refresh-highlight.spec.ts). Pure since the split: the
// "same view" test and the previous payload are store.ts's to hold.

const pk = (name: string): Column => ({ name, type: "int4", class: "number", key: "pk" });
const plain = (name: string): Column => ({ name, type: "text", class: "text" });
const data = (columns: Column[], rows: Row[]): ViewData => ({ columns, rows, total_approx: rows.length });

test("rowKey follows pkNames order and is stable for equal values", () => {
  assert.equal(rowKey(["id"], { id: "1", x: "a" }), rowKey(["id"], { id: "1", x: "b" }));
  assert.notEqual(rowKey(["a", "b"], { a: "1", b: "2" }), rowKey(["b", "a"], { a: "1", b: "2" }));
  assert.equal(rowKey(["id"], { id: null }), rowKey(["id"], { id: null }));
  assert.notEqual(rowKey(["id"], { id: null }), rowKey(["id"], { id: "null" }));
});

test("no highlight when highlightNew is off", () => {
  const prev = data([pk("id")], [{ id: "1" }]);
  assert.deepEqual(collectRowChanges(prev, data([pk("id")], [{ id: "2" }]), { highlightNew: false, sameScope: true }), {
    pkNames: [],
  });
});

test("no highlight on the first fetch (no previous payload)", () => {
  assert.deepEqual(collectRowChanges(null, data([pk("id")], [{ id: "1" }]), { highlightNew: true, sameScope: true }), {
    pkNames: [],
  });
});

test("no highlight when the scope changed", () => {
  const prev = data([pk("id")], [{ id: "1" }]);
  assert.deepEqual(collectRowChanges(prev, data([pk("id")], [{ id: "2" }]), { highlightNew: true, sameScope: false }), {
    pkNames: [],
  });
});

test("no highlight when the table has no primary key", () => {
  const prev = data([plain("a")], [{ a: "x" }]);
  assert.deepEqual(collectRowChanges(prev, data([plain("a")], [{ a: "y" }]), { highlightNew: true, sameScope: true }), {
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
  const { newRowKeys, pkNames } = collectRowChanges(prev, next, { highlightNew: true, sameScope: true });
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
  const { newRowKeys, pkNames } = collectRowChanges(prev, next, { highlightNew: true, sameScope: true });
  assert.deepEqual(pkNames, ["org", "slug"]);
  assert.deepEqual([...(newRowKeys ?? [])], [rowKey(["org", "slug"], { org: "a", slug: "y" })]);
});

const on = { highlightNew: true, sameScope: true };

test("a changed cell is reported by row key and column; an unchanged row is not", () => {
  const cols = [pk("id"), plain("status"), plain("note")];
  const prev = data(cols, [
    { id: "1", status: "pending", note: "a" },
    { id: "2", status: "pending", note: "b" },
  ]);
  const next = data(cols, [
    { id: "1", status: "completed", note: "a" },
    { id: "2", status: "pending", note: "b" },
  ]);
  const { changedCells, newRowKeys } = collectRowChanges(prev, next, on);
  assert.deepEqual([...(changedCells ?? [])], [[rowKey(["id"], { id: "1" }), new Set(["status"])]]);
  assert.equal(newRowKeys?.size, 0);
});

test("every changed column of a row is reported under that one row", () => {
  const cols = [pk("id"), plain("status"), plain("discount")];
  const prev = data(cols, [{ id: "1", status: "pending", discount: null }]);
  const next = data(cols, [{ id: "1", status: "completed", discount: "10.00" }]);
  const { changedCells } = collectRowChanges(prev, next, on);
  assert.equal(changedCells?.size, 1);
  assert.deepEqual(changedCells?.get(rowKey(["id"], { id: "1" })), new Set(["status", "discount"]));
});

test("null and empty text are different values", () => {
  const cols = [pk("id"), plain("a"), plain("b")];
  const prev = data(cols, [{ id: "1", a: null, b: "" }]);
  const next = data(cols, [{ id: "1", a: "", b: null }]);
  const { changedCells } = collectRowChanges(prev, next, on);
  assert.deepEqual(changedCells?.get(rowKey(["id"], { id: "1" })), new Set(["a", "b"]));
});

test("a new row has no changed cells", () => {
  const cols = [pk("id"), plain("v")];
  const prev = data(cols, [{ id: "1", v: "x" }]);
  const next = data(cols, [
    { id: "1", v: "x" },
    { id: "2", v: "y" },
  ]);
  const { changedCells, newRowKeys } = collectRowChanges(prev, next, on);
  assert.deepEqual([...(newRowKeys ?? [])], [rowKey(["id"], { id: "2" })]);
  assert.equal(changedCells?.size, 0);
});

test("a column added or dropped between fetches is not a change", () => {
  const prev = data([pk("id"), plain("old"), plain("kept")], [{ id: "1", old: "x", kept: "k" }]);
  const next = data([pk("id"), plain("kept"), plain("added")], [{ id: "1", kept: "k", added: "y" }]);
  assert.equal(collectRowChanges(prev, next, on).changedCells?.size, 0);
});

test("no changed cells without a primary key, on a scope change, or with the highlight off", () => {
  const prevNoPk = data([plain("a")], [{ a: "x" }]);
  assert.equal(collectRowChanges(prevNoPk, data([plain("a")], [{ a: "y" }]), on).changedCells, undefined);
  const cols = [pk("id"), plain("v")];
  const prev = data(cols, [{ id: "1", v: "x" }]);
  const next = data(cols, [{ id: "1", v: "y" }]);
  assert.equal(collectRowChanges(prev, next, { highlightNew: true, sameScope: false }).changedCells, undefined);
  assert.equal(collectRowChanges(prev, next, { highlightNew: false, sameScope: true }).changedCells, undefined);
});

test("changedRowsText counts rows and names hidden columns only when every change is in one", () => {
  const k1 = rowKey(["id"], { id: "1" });
  const k2 = rowKey(["id"], { id: "2" });
  const none = new Set<string>();
  assert.equal(changedRowsText(undefined, none), "");
  assert.equal(changedRowsText(new Map(), none), "");
  const twoRows = new Map([
    [k1, new Set(["status", "discount"])],
    [k2, new Set(["status"])],
  ]);
  assert.equal(changedRowsText(twoRows, none), "2 changed");
  assert.equal(changedRowsText(twoRows, new Set(["discount"])), "2 changed");
  assert.equal(
    changedRowsText(new Map([[k1, new Set(["notes"])]]), new Set(["notes"])),
    "1 changed in a hidden column",
  );
  assert.equal(changedRowsText(twoRows, new Set(["status", "discount"])), "2 changed in hidden columns");
});
