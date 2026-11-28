import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyFilter, fuzzyScore } from "../src/lib/fuzzy.ts";
import { fc, TRICKY_CHARS } from "./support/property.ts";

// Table and column names: identifiers with the separators fuzzy matching scores on,
// plus characters whose UTF-16 length or case mapping is not one-to-one.
const text = fc.oneof(
  { weight: 3, arbitrary: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_.-]{0,15}$/) },
  {
    weight: 1,
    arbitrary: fc
      .array(
        fc.oneof(
          fc.constantFrom("a", "B", "_", "-", ".", ...TRICKY_CHARS),
          fc.string({ unit: "binary", maxLength: 2 }),
        ),
        {
          maxLength: 10,
        },
      )
      .map((p) => p.join("")),
  },
);

// A query that is literally a piece of the text: a substring, or a scattered subsequence.
const textAndQuery = text.chain((t) =>
  fc.oneof(
    fc
      .tuple(fc.nat({ max: t.length }), fc.nat({ max: t.length }))
      .map(([a, b]) => [t, t.slice(Math.min(a, b), Math.max(a, b))] as const),
    fc.subarray([...t]).map((chars) => [t, chars.join("")] as const),
  ),
);

test("property: a query made of the text's own characters, in order, always matches", () => {
  fc.assert(
    fc.property(textAndQuery, ([t, q]) => {
      assert.notEqual(fuzzyScore(q, t), null, `${JSON.stringify(q)} in ${JSON.stringify(t)}`);
    }),
  );
});

// Flips the case of characters whose case mapping is one-to-one (not ß -> SS).
const flipCase = (s: string, flips: boolean[]): string =>
  [...s]
    .map((c, i) => {
      const other = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
      return flips[i % flips.length] && [...other].length === 1 && other.toLowerCase() === c.toLowerCase() ? other : c;
    })
    .join("");

test("property: matching ignores case", () => {
  fc.assert(
    fc.property(textAndQuery, fc.array(fc.boolean(), { minLength: 1 }), ([t, q], flips) => {
      assert.equal(fuzzyScore(flipCase(q, flips), t), fuzzyScore(q, t));
    }),
  );
});

test("property: fuzzyFilter keeps exactly the matching items, best score first, ties in input order", () => {
  fc.assert(
    fc.property(text, fc.array(text, { maxLength: 8 }), (q, items) => {
      const out = fuzzyFilter(q, items, (s) => s);
      const scored = items
        .map((item, i) => ({ item, i, score: fuzzyScore(q.trim(), item) }))
        .filter((m) => m.score !== null);
      assert.deepEqual(
        out,
        scored.sort((a, b) => (b.score as number) - (a.score as number) || a.i - b.i).map((m) => m.item),
      );
    }),
  );
});
