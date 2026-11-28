import assert from "node:assert/strict";
import { test } from "node:test";
import {
  eqClause,
  filterClause,
  filterDslErrorAt,
  filterTooLong,
  parseFilterDsl,
  pathEqClause,
  pathText,
  tryParseFilterDsl,
} from "../src/lib/filter-dsl.ts";
import { anyFilterText, filterAst, joinViewFilter, name, pathStep, printFilter, value } from "./arbitraries/filter.ts";
import { fc } from "./support/property.ts";

const utf8 = new TextEncoder();

test("property: any filter AST, written out as box text, parses back to the same AST", () => {
  fc.assert(
    fc.property(filterAst(0), (ast) => {
      const text = printFilter(ast);
      fc.pre(!filterTooLong(text));
      assert.deepEqual(parseFilterDsl(text), ast, text);
    }),
  );
});

test("property: in a join view, quoted aliases round-trip and resolve to their position", () => {
  fc.assert(
    fc.property(joinViewFilter(), ([names, ast]) => {
      const text = printFilter(ast, names);
      fc.pre(!filterTooLong(text));
      assert.deepEqual(parseFilterDsl(text, names), ast, text);
    }),
  );
});

test("property: any input either parses or fails with a position inside the input", () => {
  fc.assert(
    fc.property(anyFilterText, (input) => {
      let threw: unknown = null;
      try {
        parseFilterDsl(input);
      } catch (e) {
        threw = e;
      }
      if (threw === null) {
        assert.notEqual(tryParseFilterDsl(input), null);
        assert.equal(filterDslErrorAt(input), null);
        return;
      }
      // Only the parser's own error type, never a TypeError or RangeError from a bad index.
      assert.ok(filterDslErrorAt(input) !== null, `not a FilterDslError: ${String(threw)}`);
      assert.equal(tryParseFilterDsl(input), null);
      const { position, index } = threw as { position: number; index: number };
      assert.ok(index >= 0 && index <= input.length, `index ${index} outside the input`);
      assert.equal(utf8.encode(input.slice(0, index)).length, position, "byte position disagrees with index");
    }),
  );
});

// Long values reach the 1024-byte cap, which eqClause must refuse rather than overrun.
const cellValue = fc.oneof(
  { weight: 3, arbitrary: value },
  { weight: 1, arbitrary: fc.string({ unit: "binary", minLength: 250, maxLength: 400 }) },
  { weight: 1, arbitrary: fc.constant(null) },
);

test("property: an = button writes a clause that parses to that one condition, or nothing past the cap", () => {
  fc.assert(
    fc.property(
      // Known gap: outside a join view, a column named NOT reads as the NOT prefix.
      name.filter((n) => n.toUpperCase() !== "NOT"),
      fc.array(pathStep, { maxLength: 8 }),
      cellValue,
      (column, path, raw) => {
        const clause = path.length > 0 ? pathEqClause(column, path, raw) : eqClause(column, raw);
        if (clause === null) {
          const lhs = pathText(column, path);
          assert.ok(lhs !== null, "pathStep only makes writable keys");
          assert.ok(raw !== null && filterTooLong(filterClause(lhs, "=", raw)), "refused below the cap");
          return;
        }
        assert.ok(!filterTooLong(clause), clause);
        assert.deepEqual(parseFilterDsl(clause), [
          {
            column,
            ...(path.length > 0 ? { path } : {}),
            ...(raw === null ? { op: "IS NULL" } : { op: "=", value: raw }),
          },
        ]);
      },
    ),
  );
});
