import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  eqClause,
  filterTooLong,
  parseFilterDsl,
  pathEqClause,
  pathText,
  quoteFilterValue,
  quoteListItem,
} from "../src/lib/filter-dsl.ts";

// The single canonical DSL-text -> wire-AST parser (spec/filter-dsl.md). Cases
// come from spec/fixtures/parser-tests.json, generated from the doc's §5
// V(alid)/R(ejected)/A(dversarial) table. The parser has no runtime imports,
// so node --test reaches it directly — no browser, no test hook in the module.

interface ParserCase {
  name: string;
  input: string;
  aliases?: string[];
  expect?: unknown[];
  expect_error?: { position?: number };
}

const fixtureUrl = new URL("../../spec/fixtures/parser-tests.json", import.meta.url);
const cases: ParserCase[] = JSON.parse(readFileSync(fixtureUrl, "utf8")).cases;

for (const c of cases) {
  test(`${c.name}: ${JSON.stringify(c.input.slice(0, 60))}`, () => {
    if (c.expect) {
      assert.deepEqual(parseFilterDsl(c.input, c.aliases), c.expect);
      return;
    }
    assert.throws(
      () => parseFilterDsl(c.input, c.aliases),
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
  const values = ["it's fine", "AND", "", "NOT", "% smith%", "plain", "NULL", "null"];
  for (const v of values) {
    const parsed = parseFilterDsl(`col = ${quoteFilterValue(v)}`);
    assert.equal(parsed[0].value, v);
  }
});

// The filter box's value suggestions quote both BETWEEN bounds with quoteFilterValue.
test("quoteFilterValue output round-trips as a BETWEEN bound, NULL included", () => {
  for (const v of ["NULL", "null", "it's", "AND", "", "plain"]) {
    const parsed = parseFilterDsl(`col BETWEEN ${quoteFilterValue(v)} AND ${quoteFilterValue(v)}`);
    assert.deepEqual(parsed[0].value, [v, v]);
  }
});

test("quoteListItem output round-trips through an IN list unchanged", () => {
  const values = ["a,b", "(x)", "NULL", "null", "it's", "AND", "", "plain"];
  for (const v of values) {
    const parsed = parseFilterDsl(`col IN (${quoteListItem(v)}, z)`);
    assert.deepEqual(parsed[0].value, [v, "z"]);
  }
});

test("a join alias spelled like a filter keyword parses once quoted", () => {
  assert.deepEqual(parseFilterDsl(`"not".status = 'x'`, ["not", "u"]), [
    { column: "status", join: 0, op: "=", value: "x" },
  ]);
});

test("filterTooLong counts UTF-8 bytes against the 1024-byte cap", () => {
  assert.equal(filterTooLong("a".repeat(1024)), false);
  assert.equal(filterTooLong("a".repeat(1025)), true);
  // 342 three-byte characters are 1026 bytes but only 342 code units.
  assert.equal(filterTooLong("€".repeat(341)), false);
  assert.equal(filterTooLong("€".repeat(342)), true);
});

test("eqClause writes = or IS NULL, and nothing past the limit", () => {
  assert.equal(eqClause("status", "pending"), "status = pending");
  assert.equal(eqClause("o.note", "two words"), "o.note = 'two words'");
  assert.equal(eqClause("status", null), "status IS NULL");
  assert.equal(eqClause("status", "x".repeat(1025)), null);
  assert.equal(eqClause("status", "é".repeat(600)), null);
});

test("pathText writes bare keys, digits for an index, and quotes the rest", () => {
  assert.equal(pathText("metadata", ["prefs", "theme"]), "metadata->prefs->theme");
  assert.equal(pathText("doc", ["arr", 0, "user id"]), "doc->arr->0->'user id'");
  assert.equal(pathText("doc", ["0", "it's", "ü", "$", "a.b"]), "doc->'0'->'it''s'->'ü'->'$'->'a.b'");
});

test("pathText round-trips through the parser", () => {
  const paths: (string | number)[][] = [
    ["a"],
    ["arr", 3, "x y"],
    ["0"],
    ["it's"],
    ["*", ".", "["],
    ["a", "b", "c", "d", "e", "f", "g", "h"],
  ];
  for (const path of paths) {
    const parsed = parseFilterDsl(`${pathText("doc", path)} = 1`);
    assert.deepEqual(parsed[0].path, path);
  }
});

test("pathText refuses a key the box can't write, and a path past 8 steps", () => {
  for (const key of ['say "hi"', "a\\b", "a\u0001", "", "k".repeat(256)])
    assert.equal(pathText("doc", [key]), null, key);
  assert.equal(pathText("doc", ["a", "b", "c", "d", "e", "f", "g", "h", "i"]), null);
});

test("pathEqClause writes = or IS NULL on the path", () => {
  assert.equal(pathEqClause("metadata", ["prefs", "theme"], "dark"), "metadata->prefs->theme = dark");
  assert.equal(
    pathEqClause("metadata", ["beta_features", 0], "new dashboard"),
    "metadata->beta_features->0 = 'new dashboard'",
  );
  assert.equal(pathEqClause("o.metadata", ["x"], null), "o.metadata->x IS NULL");
  assert.equal(pathEqClause("doc", ['"'], "v"), null);
});

test("the parser's path errors point where BU underlines", () => {
  const errorAt = (input: string) => {
    try {
      parseFilterDsl(input);
    } catch (e) {
      return (e as Error).message;
    }
    return null;
  };
  assert.equal(errorAt("metadata -> role = admin"), "remove the spaces around ->: write metadata->role at position 9");
  assert.equal(errorAt("metadata-> role = admin"), "remove the spaces around ->: write metadata->role at position 11");
  assert.equal(errorAt("p->a->b->c->d->e->f->g->h->i = 1"), "a path has at most 8 steps at position 27");
  assert.equal(errorAt(`metadata->'say "hi"' = yes`), "a key can't contain \" or \\ at position 10");
  assert.equal(errorAt('data["k"] = 1'), "write a JSON path with -> at position 4");
});
