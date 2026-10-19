import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { filterDslErrorAt } from "../src/lib/filter-dsl.ts";
import { completionAt, endsInUnfinishedWord, tokenizeFilterDsl } from "../src/lib/filter-tokens.ts";

interface ParserCase {
  name: string;
  input: string;
  aliases?: string[];
  expect?: unknown[];
}
const fixtureUrl = new URL("../../spec/fixtures/parser-tests.json", import.meta.url);
const cases: ParserCase[] = JSON.parse(readFileSync(fixtureUrl, "utf8")).cases;

const kinds = (text: string) =>
  tokenizeFilterDsl(text)
    .tokens.filter((t) => t.kind !== "space")
    .map((t) => `${t.kind}:${text.slice(t.start, t.end)}`);

for (const c of cases) {
  test(`tokens cover the input exactly: ${c.name}`, () => {
    const { tokens } = tokenizeFilterDsl(c.input);
    assert.equal(tokens.map((t) => c.input.slice(t.start, t.end)).join(""), c.input);
  });
  // Whatever the parser accepts, the colourer must not call out as unexpected.
  if (c.expect) {
    test(`no plain token in an accepted filter: ${c.name}`, () => {
      assert.deepEqual(
        tokenizeFilterDsl(c.input).tokens.filter((t) => t.kind === "plain"),
        [],
      );
    });
  }
}

test("a full condition is column, operator, value", () => {
  assert.deepEqual(kinds("status = completed"), ["column:status", "op:=", "value:completed"]);
});

test("joiners, NOT, LIKE and IS NOT NULL are keywords or operators", () => {
  assert.deepEqual(kinds("NOT a LIKE 'x y' OR b IS NOT NULL"), [
    "keyword:NOT",
    "column:a",
    "op:LIKE",
    "value:'x y'",
    "keyword:OR",
    "column:b",
    "keyword:IS",
    "keyword:NOT",
    "keyword:NULL",
  ]);
});

test("a doubled quote stays inside the quoted value; an open quote runs to the end", () => {
  assert.deepEqual(kinds("a = 'it''s' AND b = 'oops"), [
    "column:a",
    "op:=",
    "value:'it''s'",
    "keyword:AND",
    "column:b",
    "op:=",
    "value:'oops",
  ]);
});

test("a word that breaks the grammar is plain, and so is everything after it", () => {
  assert.deepEqual(kinds("a = 1 b = 2"), ["column:a", "op:=", "value:1", "plain:b", "plain:=", "plain:2"]);
});

test("LIKELY is not LIKE", () => {
  assert.deepEqual(kinds("a LIKELY"), ["column:a", "plain:LIKELY"]);
});

test("a symbol operator needs no spaces", () => {
  assert.deepEqual(kinds("a>=5"), ["column:a", "op:>=", "value:5"]);
});

const at = (text: string) => {
  const { expect, partial, head, column } = completionAt(text);
  return { expect, partial, head, column };
};

test("completion: empty text and after AND/OR/NOT expect a column", () => {
  assert.deepEqual(at(""), { expect: "column", partial: "", head: "", column: null });
  assert.deepEqual(at("a = 1 AND "), { expect: "column", partial: "", head: "a = 1 AND ", column: null });
  assert.deepEqual(at("NOT sta"), { expect: "column", partial: "sta", head: "NOT ", column: null });
});

test("completion: after a column and a space, an operator is next", () => {
  assert.deepEqual(at("status "), { expect: "operator", partial: "", head: "status ", column: "status" });
  assert.deepEqual(at("status I"), { expect: "operator", partial: "I", head: "status ", column: "status" });
});

test("completion: after an operator, a value of that column is next", () => {
  assert.deepEqual(at("status = "), { expect: "value", partial: "", head: "status = ", column: "status" });
  assert.deepEqual(at("status = comp"), { expect: "value", partial: "comp", head: "status = ", column: "status" });
  assert.deepEqual(at("a = 1 AND b >= 5").column, "b");
});

test("completion: after a finished condition, AND/OR is next", () => {
  assert.deepEqual(at("a = 1 AN"), { expect: "joiner", partial: "AN", head: "a = 1 ", column: "a" });
  assert.equal(at("a IS NULL ").expect, "joiner");
});

test("completion: nothing is offered once the text left the grammar", () => {
  assert.equal(at("a = 1 b ").expect, "error");
});

test("error index is a string index even after multi-byte characters", () => {
  assert.equal(filterDslErrorAt("a = 1"), null);
  assert.equal(filterDslErrorAt("a = é b")?.index, 6);
  assert.equal(filterDslErrorAt("a = 1 x")?.index, 6);
});

test("a last word that could still grow into a valid one is unfinished", () => {
  for (const text of ["status I", "status !", "status LIK", "a = 1 AN", "a = 1 o", "a IS N", "a IS NOT N"])
    assert.equal(endsInUnfinishedWord(text), true, text);
  for (const text of ["", "status ", "status = completed oops", "a = 1 x", "status Q", "a IS x"])
    assert.equal(endsInUnfinishedWord(text), false, text);
});
