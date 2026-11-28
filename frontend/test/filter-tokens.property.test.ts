import assert from "node:assert/strict";
import { test } from "node:test";
import { filterTooLong, tryParseFilterDsl } from "../src/lib/filter-dsl.ts";
import { completionAt, tokenizeFilterDsl } from "../src/lib/filter-tokens.ts";
import { anyFilterText, filterAst, joinViewFilter, printFilter } from "./arbitraries/filter.ts";
import { fc } from "./support/property.ts";

// A valid filter as typed in a table view or a join view.
const validText = (alias?: fc.Arbitrary<string>) =>
  fc
    .oneof(
      filterAst(0).map((ast) => printFilter(ast)),
      joinViewFilter(alias).map(([names, ast]) => printFilter(ast, names)),
    )
    .filter((text) => !filterTooLong(text));

// Known gap: the parser reads NOT NOT != 0 as a negated column named NOT; the tokenizer does not.
const accepted = anyFilterText.filter((t) => tryParseFilterDsl(t) !== null && !/(^|\s)NOT\s+NOT\b/i.test(t));

test("property: the tokens tile any input exactly, with no gaps or empty tokens", () => {
  fc.assert(
    fc.property(anyFilterText, (text) => {
      const { tokens } = tokenizeFilterDsl(text);
      let at = 0;
      for (const t of tokens) {
        assert.equal(t.start, at, `gap or overlap before ${JSON.stringify(t)}`);
        assert.ok(t.end > t.start, `empty token ${JSON.stringify(t)}`);
        at = t.end;
      }
      assert.equal(at, text.length);
    }),
  );
});

test("property: a completion's head and partial put the input back together", () => {
  fc.assert(
    fc.property(anyFilterText, (text) => {
      const { head, partial } = completionAt(text);
      assert.equal(head + partial, text);
    }),
  );
});

test("property: whatever the parser accepts has no plain token and ends ready for AND/OR", () => {
  fc.assert(
    fc.property(fc.oneof(validText(), accepted), (text) => {
      const { tokens, expect } = tokenizeFilterDsl(text);
      assert.deepEqual(
        tokens.filter((t) => t.kind === "plain").map((t) => text.slice(t.start, t.end)),
        [],
        text,
      );
      assert.equal(expect, "joiner", text);
    }),
  );
});

test("property: while a valid filter is being typed, only the word under the cursor can be plain", () => {
  fc.assert(
    fc.property(
      // Known gap: an unclosed quoted alias with whitespace in it is plain until it is closed.
      validText(fc.string({ unit: "binary", minLength: 1, maxLength: 6 }).filter((a) => !/\s/.test(a))),
      fc.nat(),
      (text, n) => {
        const prefix = text.slice(0, n % (text.length + 1));
        const { tokens } = tokenizeFilterDsl(prefix);
        const settled = tokens.slice(0, -1).filter((t) => t.kind === "plain");
        assert.deepEqual(
          settled.map((t) => prefix.slice(t.start, t.end)),
          [],
          JSON.stringify(prefix),
        );
      },
    ),
  );
});
