import { describe, expect, it } from "vitest";
import { FilterError, NotAllowedError } from "../src/errors.js";
import {
  MAX_CONDITIONS,
  MAX_FILTER_BYTES,
  MAX_IN_ITEMS,
  MAX_PATH_INDEX,
  MAX_PATH_KEY_BYTES,
  MAX_PATH_STEPS,
  parseFilter,
  parseFilterForJoin,
} from "../src/filter.js";
import { type ColMeta, type TableMeta, tableWhereClause } from "../src/join.js";
import { pathIndex, pathKey, VALUE_OPS, type WireCondition, wireFilter } from "./arbitraries.js";
import { type Engine, engineCatalog, engines } from "./catalog-fixture.js";
import { anyString, fc } from "./support/property.js";

const fits = (json: string): boolean => Buffer.byteLength(json, "utf8") <= MAX_FILTER_BYTES;

// What parseFilter returns for a valid condition: `not` defaults to false and a null path is no path.
const normalized = (c: WireCondition) => {
  const { path, not, ...rest } = c;
  return { ...rest, not: not ?? false, ...(path ? { path } : {}) };
};

const throwsFilterError = (run: () => unknown): void => {
  try {
    run();
  } catch (err) {
    if (err instanceof FilterError) return;
    throw new Error(`threw ${String(err)}, not a FilterError`);
  }
  throw new Error("accepted it");
};

describe("filter AST validation (spec/protocol.md §5.4.2)", () => {
  it("property: accepts every spec-valid AST and returns it normalized", () => {
    fc.assert(
      fc.property(wireFilter(), (ast) => {
        const json = JSON.stringify(ast);
        fc.pre(fits(json));
        expect(parseFilter(json)).toEqual(ast.map(normalized));
      }),
    );
  });

  it("property: in a join, accepts a table position on every condition", () => {
    fc.assert(
      fc.property(wireFilter({ join: fc.nat({ max: 3 }) }), (ast) => {
        const json = JSON.stringify(ast);
        fc.pre(fits(json));
        expect(parseFilterForJoin(json)).toEqual(ast.map(normalized));
      }),
    );
  });

  // Each one breaks exactly one structural rule of §5.4.2 in one condition.
  type Raw = Record<string, unknown>;
  const violations: Record<string, (c: Raw, i: number) => Raw | null> = {
    "no column": ({ column, ...c }) => c,
    "column not a string": (c) => ({ ...c, column: 7 }),
    "no op": ({ op, ...c }) => c,
    "op outside the set": (c) => ({ ...c, op: "NOT IN" }),
    "op in lower case": (c) => ({ ...c, op: "like", value: "x" }),
    "unknown field": (c) => ({ ...c, extra: 1 }),
    "logic on the first condition": (c, i) => (i === 0 ? { ...c, logic: "AND" } : null),
    "no logic after the first": ({ logic, ...c }, i) => (i > 0 ? c : null),
    "logic outside AND/OR": (c, i) => (i > 0 ? { ...c, logic: "XOR" } : null),
    "not that is not a boolean": (c) => ({ ...c, not: "true" }),
    "value on IS NULL": (c) => ({ ...c, op: "IS NULL", value: "x" }),
    "no value on =": ({ value, ...c }) => ({ ...c, op: "=" }),
    "array value on =": (c) => ({ ...c, op: "=", value: ["x"] }),
    "empty IN": (c) => ({ ...c, op: "IN", value: [] }),
    "IN past 1000 items": (c) => ({ ...c, op: "IN", value: Array(MAX_IN_ITEMS + 1).fill("") }),
    "string IN": (c) => ({ ...c, op: "IN", value: "x" }),
    "BETWEEN with one bound": (c) => ({ ...c, op: "BETWEEN", value: ["1"] }),
    "BETWEEN with three bounds": (c) => ({ ...c, op: "BETWEEN", value: ["1", "2", "3"] }),
    "non-string item": (c) => ({ ...c, op: "IN", value: ["1", 2] }),
    "empty path": (c) => ({ ...c, path: [] }),
    "path past 8 steps": (c) => ({ ...c, path: Array(MAX_PATH_STEPS + 1).fill("k") }),
    "empty key": (c) => ({ ...c, path: [""] }),
    "key with a quote": (c) => ({ ...c, path: ['a"b'] }),
    "key with a backslash": (c) => ({ ...c, path: ["a\\b"] }),
    "key with a control character": (c) => ({ ...c, path: ["a\u001fb"] }),
    "key past 255 bytes": (c) => ({ ...c, path: ["k".repeat(MAX_PATH_KEY_BYTES + 1)] }),
    "negative index": (c) => ({ ...c, path: [-1] }),
    "fractional index": (c) => ({ ...c, path: [1.5] }),
    "index past 2147483647": (c) => ({ ...c, path: [MAX_PATH_INDEX + 1] }),
    "step that is neither key nor index": (c) => ({ ...c, path: [true] }),
    "path that is not an array": (c) => ({ ...c, path: "k" }),
    "table position outside a join": (c) => ({ ...c, join: 0 }),
  };

  it("property: refuses every single structural violation with a FilterError", () => {
    fc.assert(
      fc.property(
        wireFilter().chain((ast) =>
          fc.tuple(fc.constant(ast), fc.nat({ max: ast.length - 1 }), fc.constantFrom(...Object.keys(violations))),
        ),
        ([ast, i, rule]) => {
          const broken = violations[rule](ast[i] as Raw, i);
          fc.pre(broken !== null);
          throwsFilterError(() => parseFilter(JSON.stringify(ast.map((c, j) => (j === i ? broken : c)))));
        },
      ),
    );
  });

  it("property: refuses a negative or fractional table position in a join", () => {
    fc.assert(
      fc.property(wireFilter({ join: fc.constantFrom(-1, 0.5) }), (ast) => {
        throwsFilterError(() => parseFilterForJoin(JSON.stringify(ast)));
      }),
    );
  });

  it("property: refuses more than 10 conditions, and oversize text", () => {
    fc.assert(
      fc.property(wireFilter(), fc.nat({ max: 3 }), (ast, extra) => {
        const many = Array.from({ length: MAX_CONDITIONS + 1 + extra }, (_, i) => ({
          ...ast[i % ast.length],
          ...(i > 0 ? { logic: "AND" } : {}),
        }));
        if (many[0]) delete many[0].logic;
        throwsFilterError(() => parseFilter(JSON.stringify(many)));
        throwsFilterError(() => parseFilter(JSON.stringify(ast) + " ".repeat(MAX_FILTER_BYTES)));
      }),
    );
  });

  it("property: any other input is accepted or refused with a FilterError, never another error", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.jsonValue().map((v) => JSON.stringify(v)),
          fc
            .array(fc.dictionary(fc.constantFrom("logic", "not", "column", "op", "value", "path"), fc.jsonValue()))
            .map((v) => JSON.stringify(v)),
          fc.string({ unit: "binary" }),
        ),
        (raw) => {
          try {
            parseFilter(raw);
          } catch (err) {
            if (!(err instanceof FilterError)) throw err;
          }
        },
      ),
    );
  });
});

// Columns whose comparison the spec fixes as a text compare whatever the value: any column
// for LIKE/ILIKE and IS [NOT] NULL, an untyped column for every op, and a json column's path.
function textComparedCondition(col: ColMeta): fc.Arbitrary<WireCondition> {
  const typed = col.compare !== undefined;
  const ops = typed
    ? (["LIKE", "ILIKE", "IS NULL", "IS NOT NULL"] as const)
    : ([...VALUE_OPS, "IN", "BETWEEN", "IS NULL", "IS NOT NULL"] as const);
  const path =
    col.class.kind === "json"
      ? fc.option(fc.array(fc.oneof(pathKey, pathIndex), { minLength: 1, maxLength: MAX_PATH_STEPS }), {
          nil: undefined,
        })
      : fc.constant(undefined);
  return fc
    .record({
      op: fc.constantFrom<string>(...ops),
      not: fc.boolean(),
      path,
      items: fc.array(anyString(), { minLength: 2, maxLength: 4 }),
    })
    .chain(({ op, not, path, items }) => {
      // A typed column compares in its own type unless a path or LIKE makes it text.
      const allowed = !typed || path !== undefined || op === "LIKE" || op === "ILIKE" || op.startsWith("IS ");
      const finalOp = allowed ? op : "LIKE";
      const value =
        finalOp === "IN"
          ? items
          : finalOp === "BETWEEN"
            ? items.slice(0, 2)
            : finalOp.startsWith("IS ")
              ? undefined
              : items[0];
      return fc.constant<WireCondition>({
        column: col.name,
        op: finalOp,
        ...(not ? { not } : {}),
        ...(value !== undefined ? { value } : {}),
        ...(path ? { path } : {}),
      });
    });
}

// The same filter with every value, key and index swapped for another of the same kind.
function refill(ast: WireCondition[]): fc.Arbitrary<WireCondition[]> {
  return fc.tuple(
    ...ast.map((c) =>
      fc
        .record({
          value: Array.isArray(c.value)
            ? fc.tuple(...c.value.map(() => anyString()))
            : c.value === undefined
              ? fc.constant(undefined)
              : anyString(),
          path: c.path
            ? fc.tuple(...c.path.map((s) => (typeof s === "number" ? pathIndex : pathKey)))
            : fc.constant(undefined),
        })
        .map(({ value, path }) => ({ ...c, ...(value !== undefined ? { value } : {}), ...(path ? { path } : {}) })),
    ),
  );
}

// Generated as names, so a counterexample prints "postgres public.users", not the dialect object.
const catalogTables = new Map<string, [Engine, TableMeta]>(
  engines.flatMap((engine) =>
    [...engineCatalog(engine).tables].map(([key, t]): [string, [Engine, TableMeta]] => [
      `${engine.name} ${key}`,
      [engine, t],
    ]),
  ),
);
const catalogTable = fc
  .constantFrom(...catalogTables.keys())
  .map((name) => ({ name, table: (catalogTables.get(name) as [Engine, TableMeta])[1] }));

const flatValues = (ast: WireCondition[]): string[] =>
  ast.flatMap((c) => (c.value === undefined ? [] : Array.isArray(c.value) ? c.value : [c.value]));

// Is `sub` an in-order subsequence of `all`?
const subsequence = (sub: string[], all: string[]): boolean => {
  let i = 0;
  for (const v of all) if (v === sub[i]) i++;
  return i === sub.length;
};

describe("filter SQL (spec/protocol.md §5.4.2: values are bound, never spliced)", () => {
  it("property: the WHERE text is the same whatever the values, keys and indexes", () => {
    fc.assert(
      fc.property(
        catalogTable.chain(({ name, table }) =>
          fc
            .array(fc.constantFrom(...table.columns).chain(textComparedCondition), {
              minLength: 1,
              maxLength: MAX_CONDITIONS,
            })
            .map((cs) => cs.map((c, i) => (i > 0 ? ({ ...c, logic: i % 2 ? "AND" : "OR" } as WireCondition) : c)))
            .chain((a) => fc.tuple(fc.constant(name), fc.constant(a), refill(a))),
        ),
        ([name, a, b]) => {
          const [engine, table] = catalogTables.get(name) as [Engine, TableMeta];
          const sqlA = tableWhereClause(parseFilter(JSON.stringify(a)), table, engine.dialect);
          const sqlB = tableWhereClause(parseFilter(JSON.stringify(b)), table, engine.dialect);
          expect(sqlB.where).toBe(sqlA.where);
          expect(subsequence(flatValues(a), sqlA.values)).toBe(true);
          expect(subsequence(flatValues(b), sqlB.values)).toBe(true);
        },
      ),
    );
  });

  it("property: a column the table lacks is refused before any SQL is built", () => {
    fc.assert(
      fc.property(
        catalogTable.chain(({ name, table }) =>
          fc.tuple(
            fc.constant(name),
            wireFilter({ column: anyString().filter((n) => !table.columns.some((c) => c.name === n)) }),
          ),
        ),
        ([name, ast]) => {
          const [engine, table] = catalogTables.get(name) as [Engine, TableMeta];
          const json = JSON.stringify(ast);
          fc.pre(fits(json));
          expect(() => tableWhereClause(parseFilter(json), table, engine.dialect)).toThrow(NotAllowedError);
        },
      ),
    );
  });
});
