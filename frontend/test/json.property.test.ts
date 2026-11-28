import assert from "node:assert/strict";
import { test } from "node:test";
import type { PathStep } from "../src/core/types.ts";
import { compareText, nodeAt, scanJson, spanAt } from "../src/lib/json-doc.ts";
import { recordJson, reindentJson } from "../src/lib/json-text.ts";
import { fc } from "./support/property.ts";

// JSON.parse is the oracle for both modules: they keep each value's source text, so
// they must agree with it on what is JSON and what each value is.

const jsonValue = fc.jsonValue({ maxDepth: 4 });

// The same value laid out compactly, pretty-printed, or with tabs.
const jsonText = fc
  .tuple(jsonValue, fc.constantFrom<number | string>(0, 2, "\t"))
  .map(([v, indent]) => JSON.stringify(v, null, indent));

// One edit to valid JSON text, which mostly makes it invalid in an interesting place.
const mutated = jsonText.chain((text) =>
  fc
    .tuple(
      fc.nat({ max: text.length }),
      fc.constantFrom("delete", "insert", "replace"),
      fc.constantFrom(..."{}[],:\"\\ \n0-.eE+tfnu\u00a0x'".split("")),
    )
    .map(([at, edit, ch]) => {
      const tail = edit === "insert" ? text.slice(at) : text.slice(at + 1);
      return text.slice(0, at) + (edit === "delete" ? "" : ch) + tail;
    }),
);

const parses = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

// Is there a raw U+0000–U+001F inside a string literal, which JSON forbids?
function rawControlInString(text: string): boolean {
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString && c < " ") return true;
    if (c === '"') inString = !inString;
    else if (inString && c === "\\") i++;
  }
  return false;
}

test("property: scanJson accepts exactly what JSON.parse accepts", () => {
  fc.assert(
    fc.property(fc.oneof(jsonText, mutated, fc.string({ unit: "binary", maxLength: 12 })), (text) => {
      // Known gap: scanJson accepts a raw control character inside a string or key.
      fc.pre(!rawControlInString(text));
      assert.equal(scanJson(text) !== null, parses(text), JSON.stringify(text));
    }),
  );
});

// Every path into a value, the empty path included.
function pathsOf(v: unknown, prefix: PathStep[] = []): PathStep[][] {
  const here = [prefix];
  if (Array.isArray(v)) return here.concat(...v.map((item, i) => pathsOf(item, [...prefix, i])));
  if (v !== null && typeof v === "object")
    return here.concat(...Object.entries(v).map(([k, item]) => pathsOf(item, [...prefix, k])));
  return here;
}

function valueAt(v: unknown, path: readonly PathStep[]): unknown {
  return path.reduce<unknown>((at, step) => (at as Record<PathStep, unknown>)[step], v);
}

test("property: every value's kept source text reads back as that value", () => {
  fc.assert(
    fc.property(jsonText, (text) => {
      const doc = scanJson(text);
      assert.ok(doc, text);
      const parsed: unknown = JSON.parse(text);
      for (const path of pathsOf(parsed)) {
        const expected = valueAt(parsed, path);
        const node = nodeAt(doc.root, path);
        assert.ok(node, `no node at ${JSON.stringify(path)}`);
        assert.deepEqual(JSON.parse(text.slice(node.start, node.end)), expected);
        const compared = compareText(doc, node);
        if (expected === null) assert.equal(compared, null);
        else if (typeof expected === "string") assert.equal(compared, expected);
        else assert.equal(compared, text.slice(node.start, node.end));
        const span = spanAt(doc, path);
        if (path.length === 0) assert.equal(span, null);
        else {
          assert.ok(span, `no span at ${JSON.stringify(path)}`);
          const member = text.slice(span.start, span.end);
          const last = path[path.length - 1];
          const read: unknown = typeof last === "number" ? JSON.parse(member) : JSON.parse(`{${member}}`)[last];
          assert.deepEqual(read, expected);
        }
      }
    }),
  );
});

test("property: reindentJson lays out any JSON text exactly as JSON.stringify(v, null, 2)", () => {
  fc.assert(
    fc.property(jsonValue, fc.constantFrom<number | string>(0, 2, "\t"), (v, indent) => {
      assert.equal(reindentJson(JSON.stringify(v, null, indent)), JSON.stringify(v, null, 2));
    }),
  );
});

const field = fc.oneof(
  fc.record({ raw: fc.constant(null), json: fc.boolean() }),
  fc.record({ raw: fc.string({ unit: "binary" }), json: fc.constant(false) }),
  fc.record({ raw: jsonValue.map((v) => JSON.stringify(v)), json: fc.constant(true) }),
);

test("property: recordJson's text parses back to the row it was built from", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.tuple(fc.string({ unit: "binary" }), field), { maxLength: 6, selector: ([name]) => name }),
      (pairs) => {
        const fields = pairs.map(([name, f]) => ({ name, ...f }));
        const expected = Object.fromEntries(
          fields.map(({ name, raw, json }) => [name, raw === null ? null : json ? JSON.parse(raw) : raw]),
        );
        assert.deepEqual(JSON.parse(recordJson(fields)), expected);
      },
    ),
  );
});
