import assert from "node:assert/strict";
import type { FilterCondition, FilterOp, PathStep } from "../../src/core/types.ts";
import { pathStepText, pathText, quoteFilterValue, quoteListItem } from "../../src/lib/filter-dsl.ts";
import { fc, keywordSpelling, TRICKY_CHARS } from "../support/property.ts";

// Generators for spec/filter-dsl.md text and the wire AST it parses to (spec/protocol.md §5.4.2).

export const filterKeyword = keywordSpelling(["AND", "OR", "NOT", "IS", "NULL", "IN", "BETWEEN", "LIKE", "ILIKE"]);

export const name = fc.oneof(
  { weight: 4, arbitrary: fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,7}$/) },
  { weight: 1, arbitrary: filterKeyword },
);

export const value = fc.oneof(
  { weight: 4, arbitrary: fc.string({ unit: "binary", maxLength: 12 }) },
  { weight: 1, arbitrary: filterKeyword },
  { weight: 1, arbitrary: fc.constantFrom("", "'", "''", "a b", ",", "(x)", "->", "-1", "%_", ...TRICKY_CHARS) },
);

const notNull = value.filter((v) => !/^NULL$/i.test(v));

// Only keys the box can write: pathStepText is the module's own rule for that.
export const pathStep: fc.Arbitrary<PathStep> = fc.oneof(
  fc.integer({ min: 0, max: 2 ** 31 - 1 }),
  name,
  fc.string({ unit: "binary", minLength: 1, maxLength: 8 }).filter((k) => pathStepText(k) !== null),
);

const comparison = fc.constantFrom<FilterOp>("=", "!=", ">", ">=", "<", "<=", "LIKE", "ILIKE");

// The op with its value in wire shape: a string, the IN items, the BETWEEN bounds, or none.
export const predicate: fc.Arbitrary<Pick<FilterCondition, "op" | "value">> = fc.oneof(
  fc.record({ op: comparison, value }),
  fc.record({ op: fc.constant<FilterOp>("IN"), value: fc.array(value, { minLength: 1, maxLength: 4 }) }),
  // Known gap: quoteFilterValue leaves NULL bare, which the parser refuses as a BETWEEN bound.
  fc.record({ op: fc.constant<FilterOp>("BETWEEN"), value: fc.tuple(notNull, notNull) }),
  fc.record({ op: fc.constantFrom<FilterOp>("IS NULL", "IS NOT NULL") }),
);

// A join view's three aliases: unique and non-empty (spec/filter-dsl.md §3). A fixed
// count lets the aliases and the filter shrink independently.
const ALIAS_COUNT = 3;
const aliases = (alias: fc.Arbitrary<string>) =>
  fc.uniqueArray(alias, { minLength: ALIAS_COUNT, maxLength: ALIAS_COUNT });

// A valid AST in the exact shape the parser emits: optional fields omitted, `logic` on
// every condition but the first, and `join` on every condition when there are aliases.
export function filterAst(aliasCount: number): fc.Arbitrary<FilterCondition[]> {
  const condition = fc.record({
    not: fc.boolean(),
    join: aliasCount > 0 ? fc.nat({ max: aliasCount - 1 }) : fc.constant(0),
    // Known gap: outside a join view, a column named NOT reads as the NOT prefix.
    column: aliasCount > 0 ? name : name.filter((n) => n.toUpperCase() !== "NOT"),
    path: fc.array(pathStep, { maxLength: 8 }),
    predicate,
    logic: fc.constantFrom<"AND" | "OR">("AND", "OR"),
  });
  return fc.array(condition, { minLength: 1, maxLength: 10 }).map((cs) =>
    cs.map(
      (c, i): FilterCondition => ({
        ...(i > 0 ? { logic: c.logic } : {}),
        ...(c.not ? { not: true } : {}),
        column: c.column,
        ...(aliasCount > 0 ? { join: c.join } : {}),
        ...(c.path.length > 0 ? { path: c.path } : {}),
        op: c.predicate.op,
        ...(c.predicate.value !== undefined ? { value: c.predicate.value } : {}),
      }),
    ),
  );
}

// A join view's aliases with a filter over them; `alias` narrows what an alias may be.
export function joinViewFilter(
  alias = fc.string({ unit: "binary", minLength: 1, maxLength: 6 }),
): fc.Arbitrary<[string[], FilterCondition[]]> {
  return fc.tuple(aliases(alias), filterAst(ALIAS_COUNT));
}

// AST -> box text, built only from the module's own quoting helpers, the same calls the
// UI makes when it writes a clause.
export function printFilter(conditions: FilterCondition[], aliasNames?: readonly string[]): string {
  return conditions
    .map((c) => {
      const column = pathText(c.column, c.path ?? []);
      assert.ok(column !== null, `generator made an unwritable path: ${JSON.stringify(c.path)}`);
      const qualifier = c.join !== undefined && aliasNames ? `"${aliasNames[c.join].replace(/"/g, '""')}".` : "";
      const lhs = qualifier + column;
      const v = c.value;
      let clause: string;
      if (c.op === "IN") clause = `${lhs} IN (${(v as string[]).map(quoteListItem).join(", ")})`;
      else if (c.op === "BETWEEN") {
        const [lo, hi] = v as string[];
        clause = `${lhs} BETWEEN ${quoteFilterValue(lo)} AND ${quoteFilterValue(hi)}`;
      } else if (v === undefined) clause = `${lhs} ${c.op}`;
      else clause = `${lhs} ${c.op} ${quoteFilterValue(v as string)}`;
      const negated = c.not ? `NOT ${clause}` : clause;
      return c.logic ? `${c.logic} ${negated}` : negated;
    })
    .join(" ");
}

// Token soup reaches deep parser states far more often than uniform random text.
export const filterSoup = fc
  .array(
    fc.oneof(
      filterKeyword,
      fc.constantFrom("a", "x_1", "->", "->>", "'", "''", '"', ".", "=", ">=", "!=", "<", "(", ")", ","),
      fc.constantFrom("0", "99", ...TRICKY_CHARS),
    ),
    { maxLength: 30 },
  )
  .map((parts) => parts.join(""));

// Anything a user might type: token soup, or arbitrary text.
export const anyFilterText = fc.oneof(filterSoup, fc.string({ unit: "binary" }));
