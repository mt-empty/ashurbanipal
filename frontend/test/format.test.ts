import assert from "node:assert/strict";
import { test } from "node:test";
import type { ColumnClass } from "../src/core/types.ts";
import {
  columnTypeClass,
  type DisplayBucket,
  edgeWhitespace,
  rendersAsJson,
  typeNameClass,
  whitespaceTitle,
} from "../src/lib/format.ts";

// typeNameClass buckets the DB engine's own catalog type spelling into a
// small render class. It must cover Postgres, MySQL, and SQLite vocabularies
// without a bare-substring match that would mis-bucket Postgres geometry /
// network / range types.
const CASES: [string, DisplayBucket | null][] = [
  // Postgres data_type spellings
  ["integer", "number"],
  ["bigint", "number"],
  ["smallint", "number"],
  ["numeric", "number"],
  ["double precision", "number"],
  ["real", "number"],
  ["boolean", "bool"],
  ["uuid", "uuid"],
  ["jsonb", "json"],
  ["timestamp with time zone", "date"],
  ["timestamp without time zone", "date"],
  ["date", "date"],
  // Postgres types that merely contain a bucket word — must stay null
  ["text", null],
  ["interval", null],
  ["point", null],
  ["inet", null],
  ["int4range", null],
  ["character varying", null],
  ["bytea", null],
  // MySQL DATA_TYPE spellings
  ["int", "number"],
  ["tinyint", "number"],
  ["mediumint", "number"],
  ["decimal", "number"],
  ["double", "number"],
  ["datetime", "date"],
  ["timestamp", "date"],
  ["json", "json"],
  ["varchar", null],
  ["char", null],
  // SQLite declared types — case-insensitive; opaque ones stay null
  ["INTEGER", "number"],
  ["REAL", "number"],
  ["BOOLEAN", "bool"],
  ["DATETIME", "date"],
  ["NUMBER", "number"], // SQLite accepts any declared type string
  ["TEXT", null],
  ["unknown", null], // sqlite.rs fallback for an empty declared type
  ["", null],
  // a length/precision suffix and surrounding whitespace are stripped
  ["NUMERIC(10,2)", "number"],
  ["varchar(255)", null],
  ["  Integer ", "number"],
  ["TIMESTAMP(6)", "date"],
  // full spellings: Postgres format_type, MySQL COLUMN_TYPE
  ["tinyint(1)", "bool"],
  ["TINYINT(1)", "bool"],
  ["tinyint(4)", "number"],
  ["int unsigned", "number"],
  ["bigint(20) unsigned zerofill", "number"],
  ["decimal(10,2)", "number"],
  ["timestamp(3) with time zone", "date"],
  ["datetime(6)", "date"],
  ["character varying(255)", null],
  ["numeric(10,2)[]", null],
  ["order_status", null],
  ["enum('a','b')", null],
];

for (const [input, expected] of CASES) {
  test(`${JSON.stringify(input)} -> ${expected}`, () => {
    assert.equal(typeNameClass(input), expected);
  });
}

// rendersAsJson: declared JSON always; a plain string type by value shape;
// never another type whose text form leads with { or [.
const JSON_CASES: [string, ColumnClass, string, boolean][] = [
  ["jsonb", "json", '{"a":1}', true],
  ["json", "json", "not json", true], // declared type wins; the render path degrades
  ["text", "text", '{"a":1}', true],
  ["unknown", "untyped", "[1,2]", true],
  ["text", "text", "plain", false],
  ["integer", "number", "[1]", false],
  ["ARRAY", "array", "{a,b}", false],
  ["text[]", "array", "{a,b}", false],
  ["integer[]", "array", '{"1","2"}', false],
  ["int4range", "other", "[1,10)", false],
  ["int4multirange", "other", "{[1,3)}", false],
  ["path", "other", "[(0,0),(1,1)]", false],
  ["varchar(255)", "text", '{"a":1}', true],
  ["TEXT", "text", "[1]", true],
  ["", "untyped", "{}", true],
  ["character varying(255)", "text", '{"a":1}', true],
  ["character varying(255)[]", "array", "{a,b}", false],
  ["citext", "text", '{"a":1}', true],
  ["VARYING CHARACTER(20)", "text", "[1]", true],
  ["NVARCHAR2(40)", "text", "[1]", true],
  ["numeric", "number", "[1.5,2.5]", false],
  ["numrange", "other", "[1.5,2.5]", false],
  ["USER-DEFINED", "other", "[1.5,2.5]", false],
  ["_text", "array", "{a,b}", false],
];

for (const [type, cls, raw, expected] of JSON_CASES) {
  test(`rendersAsJson(${JSON.stringify(type)}, ${JSON.stringify(raw)}) -> ${expected}`, () => {
    assert.equal(rendersAsJson({ name: "c", type, class: cls }, raw), expected);
  });
}

const EDGE_CASES: [string, [string, string, string]][] = [
  ["plain", ["", "plain", ""]],
  ["  mug ", ["  ", "mug", " "]],
  ["\tlabel", ["\t", "label", ""]],
  ["line\n", ["", "line", "\n"]],
  ["line\r\n", ["", "line", "\r\n"]],
  ["a  b", ["", "a  b", ""]],
  ["   ", ["   ", "", ""]],
  ["", ["", "", ""]],
  ["\u00A0Team mug", ["\u00A0", "Team mug", ""]],
  ["\uFEFFid", ["\uFEFF", "id", ""]],
  ["x\u200B", ["", "x", "\u200B"]],
];

for (const [raw, [lead, core, trail]] of EDGE_CASES) {
  test(`edgeWhitespace(${JSON.stringify(raw)})`, () => {
    assert.deepEqual(edgeWhitespace(raw), { lead, core, trail });
  });
}

test("whitespaceTitle says how much whitespace and which kind", () => {
  assert.equal(whitespaceTitle("  ", "leading"), "2 leading spaces");
  assert.equal(whitespaceTitle(" ", "trailing"), "1 trailing space");
  assert.equal(whitespaceTitle("\t", "leading"), "1 leading tab");
  assert.equal(whitespaceTitle("\n", "trailing"), "trailing newline");
  assert.equal(whitespaceTitle("\r\n", "trailing"), "trailing newline");
  assert.equal(whitespaceTitle("\n\n", "trailing"), "2 trailing newlines");
  assert.equal(whitespaceTitle(" \t ", "leading"), "3 leading whitespace characters");
  assert.equal(whitespaceTitle("\u00A0", "leading"), "1 leading no-break space");
  assert.equal(whitespaceTitle("\uFEFF", "leading"), "1 leading byte-order mark");
});

test("edgeWhitespace stays linear on a long inner run", () => {
  const raw = `a${" ".repeat(200_000)}x`;
  const started = performance.now();
  assert.equal(edgeWhitespace(raw).core, raw);
  assert.ok(performance.now() - started < 200);
});

test("columnTypeClass falls back to the server's column class when the type name is unknown", () => {
  assert.equal(columnTypeClass({ type: "positive_int", class: "number" }), "number");
  assert.equal(columnTypeClass({ type: "event_time", class: "temporal" }), "date");
  assert.equal(columnTypeClass({ type: "tinyint(1)", class: "number" }), "bool");
  assert.equal(columnTypeClass({ type: "label", class: "text" }), null);
  assert.equal(columnTypeClass({ type: "mystery", class: "other" }), null);
  assert.equal(columnTypeClass({ type: "settings", class: "json" }), "json");
  assert.equal(columnTypeClass({ type: "weight", class: "float" }), "number");
});

test("a domain over json renders as JSON through its class", () => {
  assert.equal(rendersAsJson({ name: "c", type: "settings", class: "json" }, '{"a":1}'), true);
});

test("a text domain still gets JSON shape detection through its class", () => {
  assert.equal(rendersAsJson({ name: "c", type: "settings_text", class: "text" }, '{"a":1}'), true);
  assert.equal(rendersAsJson({ name: "c", type: "positive_int", class: "number" }, "[1]"), false);
});
