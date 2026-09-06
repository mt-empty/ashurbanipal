import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseFilterDsl, quoteFilterValue } from "../src/lib/filter-dsl.ts";

// The single canonical DSL-text -> wire-AST parser (spec/filter-dsl.md). Cases
// come from spec/fixtures/parser-tests.json, generated from the doc's §5
// V(alid)/R(ejected)/A(dversarial) table. The parser has no runtime imports,
// so node --test reaches it directly — no browser, no test hook in the module.

interface ParserCase {
  name: string;
  input: string;
  expect?: unknown[];
  expect_error?: { position?: number };
}

const fixtureUrl = new URL("../../spec/fixtures/parser-tests.json", import.meta.url);
const cases: ParserCase[] = JSON.parse(readFileSync(fixtureUrl, "utf8")).cases;

for (const c of cases) {
  test(`${c.name}: ${JSON.stringify(c.input.slice(0, 60))}`, () => {
    if (c.expect) {
      assert.deepEqual(parseFilterDsl(c.input), c.expect);
      return;
    }
    assert.throws(
      () => parseFilterDsl(c.input),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        // Every parse error carries a byte offset (spec/filter-dsl.md §4);
        // the exact value is asserted only where the fixture pins it.
        assert.match(err.message, / at position \d+$/);
        if (c.expect_error?.position !== undefined) {
          assert.equal((err as { position?: number }).position, c.expect_error.position);
        }
        return true;
      },
    );
  });
}

// The composition side (click-to-filter, FK nav, common values) writes text the
// parser must accept back unchanged — the quoting shapes most likely to
// silently diverge (spec/filter-dsl.md §6).
test("quoteFilterValue output round-trips through the parser unchanged", () => {
  const values = ["it's fine", "AND", "", "NOT", "% smith%", "plain"];
  for (const v of values) {
    const parsed = parseFilterDsl(`col = ${quoteFilterValue(v)}`);
    assert.equal(parsed[0].value, v);
  }
});
