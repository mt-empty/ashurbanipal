import assert from "node:assert/strict";
import { test } from "node:test";
import { compareText, type Doc, keysAt, nodeAt, scanJson, spanAt, valuesAt } from "../src/lib/json-doc.ts";

const doc = (text: string): Doc => {
  const d = scanJson(text);
  assert.ok(d, text);
  return d;
};

test("scanJson accepts JSON and refuses anything else", () => {
  for (const ok of ['{"a": 1}', "[]", '"s"', "-1.5e3", " true ", "null", '{"k\\"q": "\\u00fc"}'])
    assert.ok(scanJson(ok), ok);
  for (const bad of [
    "",
    "{",
    '{"a" 1}',
    "[1,]",
    "tru",
    "01",
    '"open',
    "1 2",
    "not json",
    '"a\tb"',
    '{"k\n": 1}',
    '"\u0001"',
  ])
    assert.equal(scanJson(bad), null, bad);
});

test("scanJson leaves a document past the depth cap unscanned", () => {
  assert.equal(scanJson(`${"[".repeat(1100)}${"]".repeat(1100)}`), null);
  assert.ok(scanJson(`${"[".repeat(900)}${"]".repeat(900)}`));
});

test("compareText is what the server compares: a string unquoted, else the JSON text", () => {
  const d = doc('{"s": "a\\"b", "n": 1.50, "t": true, "z": null, "o": {"k": "V"}, "a": [1, 2]}');
  const at = (key: string) => {
    const node = nodeAt(d.root, [key]);
    assert.ok(node);
    return compareText(d, node);
  };
  assert.equal(at("s"), 'a"b');
  assert.equal(at("n"), "1.50");
  assert.equal(at("t"), "true");
  assert.equal(at("z"), null);
  assert.equal(at("o"), '{"k": "V"}');
  assert.equal(at("a"), "[1, 2]");
});

test("nodeAt follows keys and indexes, and misses a wrong-kind step", () => {
  const d = doc('{"arr": [{"user id": 42}], "s": "x", "dup": 1, "dup": 2}');
  assert.equal(nodeAt(d.root, ["arr", 0, "user id"])?.kind, "number");
  assert.equal(nodeAt(d.root, ["arr", 1]), undefined);
  assert.equal(nodeAt(d.root, ["s", 0]), undefined);
  assert.equal(nodeAt(d.root, ["arr", "0"]), undefined);
  const dup = nodeAt(d.root, ["dup"]);
  assert.ok(dup);
  assert.equal(compareText(d, dup), "2");
});

const rows = [
  doc('{"role": "user", "prefs": {"theme": "dark"}, "beta": ["x", "y"]}'),
  doc('{"role": "admin", "prefs": {"theme": "light"}}'),
  doc('{"role": "user", "prefs": null}'),
  doc('{"role": 5}'),
];

test("keysAt counts rows per key, most common first, with what each holds", () => {
  assert.deepEqual(keysAt(rows, []), [
    { step: "role", kind: "mixed", count: 4 },
    { step: "prefs", kind: "mixed", count: 3 },
    { step: "beta", kind: "array", count: 1 },
  ]);
  assert.deepEqual(keysAt(rows, ["prefs"]), [{ step: "theme", kind: "text", count: 2 }]);
  assert.deepEqual(keysAt(rows, ["beta"]), [
    { step: 0, kind: "text", count: 1 },
    { step: 1, kind: "text", count: 1 },
  ]);
});

test("valuesAt counts scalar values as the server compares them", () => {
  assert.deepEqual(valuesAt(rows, ["role"]), [
    { text: "user", count: 2, number: false },
    { text: "admin", count: 1, number: false },
    { text: "5", count: 1, number: true },
  ]);
  assert.deepEqual(valuesAt(rows, ["prefs"]), []);
});

test("spanAt covers a member from its key to the end of its value", () => {
  const text = '{"role": "user", "prefs": {"theme" :  "dark"}, "a": [10, 20]}';
  const d = doc(text);
  const slice = (path: (string | number)[]) => {
    const span = spanAt(d, path);
    return span && text.slice(span.start, span.end);
  };
  assert.equal(slice(["prefs", "theme"]), '"theme" :  "dark"');
  assert.equal(slice(["a", 1]), "20");
  assert.equal(slice(["prefs"]), '"prefs": {"theme" :  "dark"}');
  assert.equal(slice(["missing"]), null);
  assert.equal(slice([]), null);
});

test("spanAt finds an escaped key by its decoded name", () => {
  const text = '{"say \\"hi\\"": 1, "\\u00fc": 2}';
  const d = doc(text);
  const span = spanAt(d, ["ü"]);
  assert.ok(span);
  assert.equal(text.slice(span.start, span.end), '"\\u00fc": 2');
});
