import type { JoinColumn, JoinDef, JoinTable } from "../../src/core/types.ts";
import { JOIN_KEYWORDS, JOIN_MAX_PAIRS, JOIN_MAX_TABLES, JOIN_REJECTED_KEYWORDS } from "../../src/lib/join-dsl.ts";
import { fc, keywordSpelling, TRICKY_CHARS } from "../support/property.ts";

// Generators for spec/join-dsl.md text and the JoinDef it parses to.

const joinKeyword = keywordSpelling([...JOIN_KEYWORDS, ...JOIN_REJECTED_KEYWORDS, "OR"]);

// Any name a quoted identifier can hold, biased toward the ones printJoin must quote.
export const joinName = fc.oneof(
  { weight: 4, arbitrary: fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,7}$/) },
  { weight: 1, arbitrary: joinKeyword },
  { weight: 1, arbitrary: fc.constantFrom('"', 'a"b', "*", "a.b", "1x", "a b", "--", "/*", ...TRICKY_CHARS) },
  { weight: 1, arbitrary: fc.string({ unit: "binary", minLength: 1, maxLength: 8 }) },
);

// fc.record may build null-prototype objects, which a strict deepEqual tells apart.
const plain = { noNullPrototype: true } as const;

const table: fc.Arbitrary<JoinTable> = fc
  .record({ schema: fc.option(joinName, { nil: undefined }), table: joinName, alias: fc.option(joinName) }, plain)
  .map(({ schema, ...rest }) => (schema === undefined ? rest : { schema, ...rest }));

// Per table: no SELECT items, its `*`, or some of its columns; never both, never twice.
const selection = fc.oneof(
  fc.constant<"none">("none"),
  fc.constant<"all">("all"),
  fc.uniqueArray(joinName, { minLength: 1, maxLength: 3 }),
);

// A JoinDef parseJoin accepts with no catalog: unique effective names, each ON pair
// reaching back to an earlier table, and an explicit SELECT list or null for `*`.
export const joinDef: fc.Arbitrary<JoinDef> = fc
  .uniqueArray(table, { minLength: 2, maxLength: JOIN_MAX_TABLES, selector: (t) => t.alias ?? t.table })
  .chain((tables) =>
    fc.record(
      {
        tables: fc.constant(tables),
        joins: fc.tuple(
          ...tables.slice(1).map((_, i) =>
            fc.record(
              {
                type: fc.constantFrom<"inner" | "left">("inner", "left"),
                on: fc.array(
                  fc.record(
                    { left: fc.record({ join: fc.nat({ max: i }), column: joinName }, plain), right: joinName },
                    plain,
                  ),
                  { minLength: 1, maxLength: JOIN_MAX_PAIRS },
                ),
              },
              plain,
            ),
          ),
        ),
        columns: fc
          .tuple(...tables.map(() => selection))
          .map((picks) =>
            picks.flatMap((pick, join): JoinColumn[] =>
              pick === "none" ? [] : pick === "all" ? [{ join, all: true }] : pick.map((column) => ({ join, column })),
            ),
          )
          .chain((items) => fc.shuffledSubarray(items, { minLength: items.length }))
          .map((items) => (items.length === 0 ? null : items)),
      },
      plain,
    ),
  );

// Token soup for the join text box.
export const joinSoup = fc
  .array(
    fc.oneof(
      joinKeyword,
      fc.constantFrom("orders", "o", "u", "id", "*", ".", ",", "=", ";", '"', '""', "(", ")", "--", "/*", "<>"),
      fc.constantFrom(...TRICKY_CHARS),
    ),
    { maxLength: 30 },
  )
  .map((parts) => parts.join(" "));

export const anyJoinText = fc.oneof(joinSoup, fc.string({ unit: "binary" }));
