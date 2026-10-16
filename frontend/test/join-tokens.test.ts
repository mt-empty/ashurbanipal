import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JOIN_KEYWORDS, JOIN_REJECTED_KEYWORDS } from "../src/lib/join-dsl.ts";
import { JOIN_TOKEN_WORDS, joinCompletionAt, tokenizeJoinText } from "../src/lib/join-tokens.ts";

const kinds = (text: string) =>
  tokenizeJoinText(text)
    .filter((t) => t.kind !== "space")
    .map((t) => `${t.kind}:${text.slice(t.start, t.end)}`);

test("the colourer knows the same words as the parser", () => {
  assert.deepEqual([...JOIN_TOKEN_WORDS.keywords].sort(), [...JOIN_KEYWORDS].sort());
  assert.deepEqual([...JOIN_TOKEN_WORDS.rejected].sort(), [...JOIN_REJECTED_KEYWORDS, "OR"].sort());
});

test("tokens cover every fixture input exactly", () => {
  const url = new URL("../../spec/fixtures/join-parser-tests.json", import.meta.url);
  for (const c of JSON.parse(readFileSync(url, "utf8")).cases as { input: string }[]) {
    const joined = tokenizeJoinText(c.input)
      .map((t) => c.input.slice(t.start, t.end))
      .join("");
    assert.equal(joined, c.input);
  }
});

test("keywords, names, punctuation and refused words are told apart", () => {
  assert.deepEqual(kinds('FROM orders o JOIN "x y" ON o.id = x.id WHERE (1)'), [
    "keyword:FROM",
    "name:orders",
    "name:o",
    "keyword:JOIN",
    'name:"x y"',
    "keyword:ON",
    "name:o",
    "punct:.",
    "name:id",
    "punct:=",
    "name:x",
    "punct:.",
    "name:id",
    "plain:WHERE",
    "plain:(",
    "plain:1",
    "plain:)",
  ]);
});

test("a table is expected after FROM and JOIN, with partial text", () => {
  assert.equal(joinCompletionAt("FROM ").expect, "table");
  const c = joinCompletionAt("FROM orders o JOIN us");
  assert.equal(c.expect, "table");
  assert.equal(c.partial, "us");
  assert.equal(c.head, "FROM orders o JOIN ");
  assert.deepEqual(c.declared, [{ name: "o", table: "orders" }]);
});

test("a keyword is offered once a letter is typed after a table", () => {
  assert.deepEqual(joinCompletionAt("FROM orders L").keywords, ["JOIN", "INNER JOIN", "LEFT JOIN"]);
  assert.deepEqual(joinCompletionAt("FROM orders JOIN users O").keywords, ["ON"]);
  assert.equal(joinCompletionAt("FROM orders ").expect, "none");
});

test("after ON a qualifier is expected, then a column of that qualifier", () => {
  assert.equal(joinCompletionAt("FROM orders o JOIN users u ON ").expect, "qualifier");
  const c = joinCompletionAt("FROM orders o JOIN users u ON o.us");
  assert.equal(c.expect, "column");
  assert.equal(c.qualifier, "o");
  assert.equal(c.partial, "us");
  assert.equal(c.head, "FROM orders o JOIN users u ON o.");
  assert.deepEqual(c.declared, [
    { name: "o", table: "orders" },
    { name: "u", table: "users" },
  ]);
});

test("the second colref of a pair knows the first", () => {
  const c = joinCompletionAt("FROM orders o JOIN users u ON o.user_id = u.");
  assert.equal(c.expect, "column");
  assert.equal(c.qualifier, "u");
  assert.deepEqual(c.otherSide, { qualifier: "o", column: "user_id" });
  assert.equal(joinCompletionAt("FROM orders o JOIN users u ON o.user_id = u.id A").expect, "keyword");
});

test("a quoted alias is read back unquoted", () => {
  const c = joinCompletionAt('FROM orders "my o" JOIN users u ON "my o".');
  assert.equal(c.qualifier, "my o");
  assert.deepEqual(c.declared[0], { name: "my o", table: "orders" });
});
