import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJoin, printJoin } from "../src/lib/join-dsl.ts";
import { tokenizeJoinText } from "../src/lib/join-tokens.ts";
import { anyJoinText, joinDef } from "./arbitraries/join.ts";
import { fc } from "./support/property.ts";

test("property: printJoin's text parses back to the same JoinDef", () => {
  fc.assert(
    fc.property(joinDef, (def) => {
      const text = printJoin(def);
      assert.deepEqual(parseJoin(text), { def }, text);
    }),
  );
});

test("property: any input parses or returns an error whose line and column match its index", () => {
  fc.assert(
    fc.property(anyJoinText, (text) => {
      const result = parseJoin(text);
      if ("def" in result) {
        // Canonical text is a fixed point: printing what was accepted reads back the same.
        assert.deepEqual(parseJoin(printJoin(result.def)), result, text);
        return;
      }
      const { index, line, column } = result.error;
      assert.ok(index >= 0 && index <= text.length, `index ${index} outside the input`);
      const before = text.slice(0, index).split("\n");
      assert.deepEqual([line, column], [before.length, before[before.length - 1].length + 1]);
    }),
  );
});

test("property: the join tokens tile any input exactly, with no gaps or empty tokens", () => {
  fc.assert(
    fc.property(fc.oneof(anyJoinText, joinDef.map(printJoin)), (text) => {
      let at = 0;
      for (const t of tokenizeJoinText(text)) {
        assert.equal(t.start, at, `gap or overlap before ${JSON.stringify(t)}`);
        assert.ok(t.end > t.start, `empty token ${JSON.stringify(t)}`);
        at = t.end;
      }
      assert.equal(at, text.length);
    }),
  );
});

test("property: printJoin's text has no plain token", () => {
  fc.assert(
    fc.property(joinDef, (def) => {
      const text = printJoin(def);
      const plain = tokenizeJoinText(text).filter((t) => t.kind === "plain");
      assert.deepEqual(
        plain.map((t) => text.slice(t.start, t.end)),
        [],
        text,
      );
    }),
  );
});
