import assert from "node:assert/strict";
import { test } from "node:test";
import { scanJson } from "../src/lib/json-doc.ts";
import { foldDoc, type JsonNode } from "../src/lib/json-tree.ts";

// The pure shape fold behind renderJsonTree (the DOM walk stays covered by
// inspection-affordances.spec.ts + frontend:build-check). Every field here is
// consumed verbatim by renderNode, so these assertions pin the rendered
// output's structure and text without a DOM.

const folded = (text: string): JsonNode => {
  const doc = scanJson(text);
  assert.ok(doc, text);
  return foldDoc(doc);
};
const entriesOf = (node: JsonNode) => {
  assert.equal(node.kind, "container");
  return (node as { entries: { key?: string; node: JsonNode }[] }).entries;
};

test("scalars carry the kind, the exact text the DOM shows, and the text a filter compares", () => {
  assert.deepEqual(folded("null"), { kind: "scalar", scalar: "null", text: "null", value: null });
  assert.deepEqual(folded("true"), { kind: "scalar", scalar: "bool", text: "true", value: "true" });
  assert.deepEqual(folded("42"), { kind: "scalar", scalar: "number", text: "42", value: "42" });
  assert.deepEqual(folded("-3.5"), { kind: "scalar", scalar: "number", text: "-3.5", value: "-3.5" });
  assert.deepEqual(folded('"hi"'), { kind: "scalar", scalar: "string", text: '"hi"', value: "hi" });
});

test("a number keeps its own digits", () => {
  const entries = entriesOf(folded('{"price": 1.50, "big": 9007199254740993}'));
  assert.deepEqual(
    entries.map((e) => [(e.node as { text: string }).text, (e.node as { value: string }).value]),
    [
      ["1.50", "1.50"],
      ["9007199254740993", "9007199254740993"],
    ],
  );
});

test("a UUID string is tagged uuid; other strings are string", () => {
  const scalar = (text: string) => (folded(JSON.stringify(text)) as { scalar: string }).scalar;
  assert.equal(scalar("a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d"), "uuid");
  assert.equal(scalar("A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D"), "uuid");
  assert.equal(scalar("a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6"), "string"); // one char short
});

test("string text is JSON.stringify'd, so quotes and newlines are escaped; value is decoded", () => {
  assert.deepEqual(folded('"he said \\"hi\\""'), {
    kind: "scalar",
    scalar: "string",
    text: '"he said \\"hi\\""',
    value: 'he said "hi"',
  });
  assert.equal((folded('"a\\nb"') as { text: string }).text, '"a\\nb"');
  assert.equal((folded('"\\u00fc"') as { value: string }).value, "ü");
});

test("empty object and array fold to a distinct empty node", () => {
  assert.deepEqual(folded("{}"), { kind: "empty", open: "{", close: "}" });
  assert.deepEqual(folded("[ ]"), { kind: "empty", open: "[", close: "]" });
});

test("array entries have no key and keep order", () => {
  const entries = entriesOf(folded('["a", 1, null]'));
  assert.ok(entries.every((e) => e.key === undefined));
  assert.deepEqual(
    entries.map((e) => (e.node as { scalar: string }).scalar),
    ["string", "number", "null"],
  );
});

test("object entries carry the raw key and keep source order", () => {
  assert.deepEqual(
    entriesOf(folded('{"b": 1, "a": 2, "1": 3}')).map((e) => e.key),
    ["b", "a", "1"],
  );
});

test("a repeated key keeps its last value at its first place", () => {
  assert.deepEqual(
    entriesOf(folded('{"a": 1, "b": 2, "a": 3}')).map((e) => [e.key, (e.node as { text: string }).text]),
    [
      ["a", "3"],
      ["b", "2"],
    ],
  );
});

test("nesting recurses: object in array in object", () => {
  const arr = entriesOf(folded('{"outer": [{"inner": 1}]}'))[0].node;
  const obj = entriesOf(arr)[0].node;
  assert.equal(entriesOf(obj)[0].key, "inner");
});
