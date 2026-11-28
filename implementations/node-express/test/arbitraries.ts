import { MAX_CONDITIONS, MAX_IN_ITEMS, MAX_PATH_INDEX, MAX_PATH_KEY_BYTES, MAX_PATH_STEPS } from "../src/filter.js";
import { MAX_JOIN_PAIRS, MAX_JOIN_TABLES } from "../src/join.js";
import { anyString, fc } from "./support/property.js";

// Wire-shape generators written from spec/protocol.md §5.4.2 (filter) and §5.11.1 (join).
// They build exactly what the spec allows, including the edges of every limit.

const plain = { noNullPrototype: true } as const;

export type WireCondition = {
  logic?: "AND" | "OR";
  not?: boolean;
  column: string;
  op: string;
  value?: string | string[];
  path?: (string | number)[] | null;
  join?: number;
};

export const VALUE_OPS = ["=", "!=", ">", "<", ">=", "<=", "LIKE", "ILIKE"] as const;

const utf8 = new TextEncoder();
const keyOk = (k: string): boolean =>
  ![...k].some((c) => c === '"' || c === "\\" || c < " ") && utf8.encode(k).length <= MAX_PATH_KEY_BYTES;

// A key of 1 to 255 bytes with no ", \ or U+0000–U+001F; an index from 0 to 2147483647.
export const pathKey = fc.oneof(
  { weight: 4, arbitrary: fc.string({ unit: "binary", minLength: 1, maxLength: 8 }).filter(keyOk) },
  { weight: 1, arbitrary: fc.constantFrom("0", "k".repeat(MAX_PATH_KEY_BYTES), "é".repeat(127), "\u007f", "😀") },
);
export const pathIndex = fc.oneof(fc.nat({ max: 100 }), fc.constantFrom(0, MAX_PATH_INDEX));
export const pathStep = fc.oneof(pathKey, pathIndex);
export const path = fc.array(pathStep, { minLength: 1, maxLength: MAX_PATH_STEPS });

// The op with its value in wire shape, `items` deciding each value string.
export function predicate(items: fc.Arbitrary<string>) {
  return fc.oneof(
    fc.record({ op: fc.constantFrom(...VALUE_OPS), value: items }, plain),
    fc.record(
      {
        op: fc.constant("IN"),
        value: fc.oneof(
          { weight: 9, arbitrary: fc.array(items, { minLength: 1, maxLength: 5 }) },
          { weight: 1, arbitrary: fc.constant(Array<string>(MAX_IN_ITEMS).fill("")) },
        ),
      },
      plain,
    ),
    fc.record({ op: fc.constant("BETWEEN"), value: fc.tuple(items, items) }, plain),
    fc.record({ op: fc.constantFrom("IS NULL", "IS NOT NULL") }, plain),
  );
}

interface FilterOptions {
  column?: fc.Arbitrary<string>;
  join?: fc.Arbitrary<number>;
}

// A spec-valid filter: `logic` absent on the first condition and present after, and
// `not` and `path` sometimes absent, sometimes their defaults (false, null).
export function wireFilter({ column = anyString(), join }: FilterOptions = {}): fc.Arbitrary<WireCondition[]> {
  const condition = fc.record(
    {
      logic: fc.constantFrom<"AND" | "OR">("AND", "OR"),
      not: fc.constantFrom(undefined, false, true),
      column,
      predicate: predicate(anyString()),
      path: fc.oneof({ weight: 3, arbitrary: fc.constant(undefined) }, fc.constant(null), path),
      join: join ?? fc.constant(undefined),
    },
    plain,
  );
  return fc.array(condition, { minLength: 1, maxLength: MAX_CONDITIONS }).map((cs) =>
    cs.map(
      (c, i): WireCondition => ({
        ...(i > 0 ? { logic: c.logic } : {}),
        ...(c.not !== undefined ? { not: c.not } : {}),
        column: c.column,
        ...c.predicate,
        ...(c.path !== undefined ? { path: c.path } : {}),
        ...(c.join !== undefined ? { join: c.join } : {}),
      }),
    ),
  );
}

export type WireJoin = {
  table: string;
  schema?: string;
  joins: {
    type: "inner" | "left";
    table: string;
    schema?: string;
    on: { left: { join: number; column: string }; right: string }[];
  }[];
  columns?: { join: number; column: string }[];
};

const optionalSchema = fc.option(anyString(), { nil: undefined });

// A spec-valid join: 1 to 3 joined tables, each ON pair reaching back to an earlier
// position, and an optional non-empty SELECT list without repeats.
export const wireJoin: fc.Arbitrary<WireJoin> = fc
  .integer({ min: 1, max: MAX_JOIN_TABLES - 1 })
  .chain((joinCount) =>
    fc.record(
      {
        table: anyString(),
        schema: optionalSchema,
        joins: fc.tuple(
          ...Array.from({ length: joinCount }, (_, i) =>
            fc.record(
              {
                type: fc.constantFrom<"inner" | "left">("inner", "left"),
                table: anyString(),
                schema: optionalSchema,
                on: fc.array(
                  fc.record(
                    { left: fc.record({ join: fc.nat({ max: i }), column: anyString() }, plain), right: anyString() },
                    plain,
                  ),
                  { minLength: 1, maxLength: MAX_JOIN_PAIRS },
                ),
              },
              plain,
            ),
          ),
        ),
        columns: fc.option(
          fc.uniqueArray(fc.record({ join: fc.nat({ max: joinCount }), column: anyString() }, plain), {
            minLength: 1,
            maxLength: 6,
            selector: (c) => JSON.stringify([c.join, c.column]),
          }),
          { nil: undefined },
        ),
      },
      plain,
    ),
  )
  .map((j) => JSON.parse(JSON.stringify(j)) as WireJoin);
