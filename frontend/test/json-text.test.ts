import assert from "node:assert/strict";
import { test } from "node:test";
import { recordJson, reindentJson } from "../src/lib/json-text.ts";

test("reindentJson matches JSON.stringify's two-space layout", () => {
  const text = '{"a": 1, "b": [true, null, {"c": "x"}], "d": {}, "e": [ ]}';
  assert.equal(reindentJson(text), JSON.stringify(JSON.parse(text), null, 2));
});

test("reindentJson keeps number tokens verbatim past 2^53", () => {
  assert.equal(reindentJson('{"id": 9007199254740993}'), '{\n  "id": 9007199254740993\n}');
  assert.equal(reindentJson("[1.50, 1e400]"), "[\n  1.50,\n  1e400\n]");
});

test("reindentJson copies strings with escapes, brackets and commas unchanged", () => {
  const text = '{"k": "a \\"q\\" , [x] {y}: \\\\"}';
  assert.equal(reindentJson(text), JSON.stringify(JSON.parse(text), null, 2));
});

test("reindentJson indents from the given starting depth", () => {
  assert.equal(reindentJson('{"a": 1}', 1), '{\n    "a": 1\n  }');
  assert.equal(reindentJson("3", 1), "3");
});

test("reindentJson never throws on malformed input", () => {
  assert.doesNotThrow(() => reindentJson('}}]{"a": "x'));
});

test("recordJson nests JSON fields and quotes everything else", () => {
  const out = recordJson([
    { name: "id", raw: "9007199254740993", json: false },
    { name: "meta", raw: '{"n": 9007199254740993}', json: true },
    { name: "note", raw: '{"looks": "like json"}', json: false },
    { name: "gone", raw: null, json: false },
  ]);
  assert.equal(
    out,
    [
      "{",
      '  "id": "9007199254740993",',
      '  "meta": {',
      '    "n": 9007199254740993',
      "  },",
      '  "note": "{\\"looks\\": \\"like json\\"}",',
      '  "gone": null',
      "}",
    ].join("\n"),
  );
  assert.deepEqual(Object.keys(JSON.parse(out)), ["id", "meta", "note", "gone"]);
});

test("recordJson of no fields is an empty object", () => {
  assert.equal(recordJson([]), "{}");
});
