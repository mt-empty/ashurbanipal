import { describe, expect, it } from "vitest";
import { BadJoinError, MAX_JOIN_BYTES, MAX_JOIN_PAIRS, MAX_JOIN_TABLES, parseJoin } from "../src/join.js";
import { type WireJoin, wireJoin } from "./arbitraries.js";
import { fc } from "./support/property.js";

// What parseJoin returns for a valid join: `type` read as a `left` flag.
const expected = (j: WireJoin) => ({
  table: j.table,
  schema: j.schema,
  joins: j.joins.map(({ type, ...rest }) => ({ ...rest, schema: rest.schema, left: type === "left" })),
  columns: j.columns,
});

const throwsBadJoin = (run: () => unknown): void => {
  try {
    run();
  } catch (err) {
    if (err instanceof BadJoinError) return;
    throw new Error(`threw ${String(err)}, not a BadJoinError`);
  }
  throw new Error("accepted it");
};

type Raw = Record<string, unknown>;
const entry = (j: Raw, i: number): Raw => (j.joins as Raw[])[i];
const withEntry = (j: Raw, i: number, e: Raw): Raw => ({
  ...j,
  joins: (j.joins as Raw[]).map((x, k) => (k === i ? e : x)),
});

// Each one breaks exactly one structural rule of §5.11.1, in the join or its entry `i`.
const violations: Record<string, (j: Raw, i: number) => Raw> = {
  "no table": ({ table, ...j }) => j,
  "schema not a string": (j) => ({ ...j, schema: 1 }),
  "unknown field": (j) => ({ ...j, where: "x" }),
  "no joins": (j) => ({ ...j, joins: [] }),
  "one table past the limit": (j) => ({ ...j, joins: Array(MAX_JOIN_TABLES).fill(entry(j, 0)) }),
  "type outside inner/left": (j, i) => withEntry(j, i, { ...entry(j, i), type: "right" }),
  "entry table not a string": (j, i) => withEntry(j, i, { ...entry(j, i), table: null }),
  "unknown entry field": (j, i) => withEntry(j, i, { ...entry(j, i), using: [] }),
  "empty on": (j, i) => withEntry(j, i, { ...entry(j, i), on: [] }),
  "one on pair past the limit": (j, i) => {
    const on = entry(j, i).on as Raw[];
    return withEntry(j, i, { ...entry(j, i), on: Array(MAX_JOIN_PAIRS + 1).fill(on[0]) });
  },
  "on.left reaching forward": (j, i) => {
    const [pair] = entry(j, i).on as { left: Raw; right: string }[];
    return withEntry(j, i, { ...entry(j, i), on: [{ ...pair, left: { ...pair.left, join: i + 1 } }] });
  },
  "negative position": (j, i) => {
    const [pair] = entry(j, i).on as { left: Raw; right: string }[];
    return withEntry(j, i, { ...entry(j, i), on: [{ ...pair, left: { ...pair.left, join: -1 } }] });
  },
  "on.right not a string": (j, i) => {
    const [pair] = entry(j, i).on as Raw[];
    return withEntry(j, i, { ...entry(j, i), on: [{ ...pair, right: 3 }] });
  },
  "empty columns": (j) => ({ ...j, columns: [] }),
  "a column listed twice": (j) => ({
    ...j,
    columns: [
      { join: 0, column: "a" },
      { join: 0, column: "a" },
    ],
  }),
  "fractional column position": (j) => ({ ...j, columns: [{ join: 0.5, column: "a" }] }),
};

describe("join validation (spec/protocol.md §5.11.1)", () => {
  it("property: accepts every spec-valid join and returns its structure", () => {
    fc.assert(
      fc.property(wireJoin, (j) => {
        const json = JSON.stringify(j);
        fc.pre(Buffer.byteLength(json, "utf8") <= MAX_JOIN_BYTES);
        expect(parseJoin(json)).toEqual(expected(j));
      }),
    );
  });

  it("property: refuses every single structural violation with a BadJoinError", () => {
    fc.assert(
      fc.property(
        wireJoin.chain((j) =>
          fc.tuple(fc.constant(j), fc.nat({ max: j.joins.length - 1 }), fc.constantFrom(...Object.keys(violations))),
        ),
        ([j, i, rule]) => {
          throwsBadJoin(() => parseJoin(JSON.stringify(violations[rule](j as Raw, i))));
        },
      ),
    );
  });

  it("property: any other input is accepted or refused with a BadJoinError, never another error", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.jsonValue().map((v) => JSON.stringify(v)),
          fc
            .dictionary(fc.constantFrom("table", "schema", "joins", "columns"), fc.jsonValue())
            .map((v) => JSON.stringify(v)),
          fc.string({ unit: "binary" }),
        ),
        (raw) => {
          try {
            parseJoin(raw);
          } catch (err) {
            if (!(err instanceof BadJoinError)) throw err;
          }
        },
      ),
    );
  });
});
