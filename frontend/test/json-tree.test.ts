import assert from "node:assert/strict";
import { test } from "node:test";
import { foldJson, type JsonValue } from "../src/lib/json-tree.ts";

// The pure shape fold behind renderJsonTree (the DOM walk stays covered by
// inspection-affordances.spec.ts + frontend:build-check). Every field here is
// consumed verbatim by renderNode, so these assertions pin the rendered
// output's structure and text without a DOM.

test("scalars carry the kind and the exact text the DOM shows", () => {
  assert.deepEqual(foldJson(null), { kind: "scalar", scalar: "null", text: "null" });
  assert.deepEqual(foldJson(true), { kind: "scalar", scalar: "bool", text: "true" });
  assert.deepEqual(foldJson(42), { kind: "scalar", scalar: "number", text: "42" });
  assert.deepEqual(foldJson(-3.5), { kind: "scalar", scalar: "number", text: "-3.5" });
  assert.deepEqual(foldJson("hi"), { kind: "scalar", scalar: "string", text: '"hi"' });
});

test("a UUID string is tagged uuid; other strings are string", () => {
  const scalar = (v: JsonValue) => (foldJson(v) as { scalar: string }).scalar;
  assert.equal(scalar("a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d"), "uuid");
  assert.equal(scalar("A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D"), "uuid");
  assert.equal(scalar("a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6"), "string"); // one char short
});

test("string text is JSON.stringify'd, so quotes and newlines are escaped", () => {
  assert.equal((foldJson('he said "hi"') as { text: string }).text, '"he said \\"hi\\""');
  assert.equal((foldJson("a\nb") as { text: string }).text, '"a\\nb"');
});

test("empty object and array fold to a distinct empty node", () => {
  assert.deepEqual(foldJson({}), { kind: "empty", open: "{", close: "}" });
  assert.deepEqual(foldJson([]), { kind: "empty", open: "[", close: "]" });
});

test("array entries have no key and keep order", () => {
  const node = foldJson(["a", 1, null]);
  assert.equal(node.kind, "container");
  assert.equal((node as { open: string }).open, "[");
  const entries = (node as { entries: { key?: string; node: JsonValue }[] }).entries;
  assert.equal(entries.length, 3);
  assert.ok(entries.every((e) => e.key === undefined));
  assert.deepEqual(
    entries.map((e) => (e.node as { scalar: string }).scalar),
    ["string", "number", "null"],
  );
});

test("object entries carry the raw key and keep insertion order", () => {
  const node = foldJson({ b: 1, a: 2 }) as { entries: { key?: string }[] };
  assert.deepEqual(
    node.entries.map((e) => e.key),
    ["b", "a"],
  );
});

test("nesting recurses: object in array in object", () => {
  const node = foldJson({ outer: [{ inner: 1 }] }) as { entries: { key?: string; node: JsonValue }[] };
  const arr = node.entries[0].node as { kind: string; entries: { node: JsonValue }[] };
  assert.equal(arr.kind, "container");
  const obj = arr.entries[0].node as { kind: string; entries: { key?: string }[] };
  assert.equal(obj.kind, "container");
  assert.equal(obj.entries[0].key, "inner");
});

test("integers beyond MAX_SAFE_INTEGER already lost precision upstream (JSON.parse); fold just reflects it", () => {
  // 9007199254740993 -> parsed to 9007199254740992 before fold ever sees it.
  const parsed = JSON.parse("9007199254740993") as JsonValue;
  assert.equal((foldJson(parsed) as { text: string }).text, "9007199254740992");
});
