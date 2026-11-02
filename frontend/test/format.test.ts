import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ColumnTypeClass,
  cellTypeClass,
  columnTypeClass,
  edgeWhitespace,
  rendersAsJson,
  whitespaceTitle,
} from "../src/lib/format.ts";

// columnTypeClass buckets the DB engine's own catalog type spelling into a
// small render class. It must cover Postgres, MySQL, and SQLite vocabularies
// without a bare-substring match that would mis-bucket Postgres geometry /
// network / range types.
const CASES: [string, ColumnTypeClass | null][] = [
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
    assert.equal(columnTypeClass(input), expected);
  });
}

// rendersAsJson: declared JSON always; a plain string type by value shape;
// never another type whose text form leads with { or [.
const JSON_CASES: [string, string, boolean][] = [
  ["jsonb", '{"a":1}', true],
  ["json", "not json", true], // declared type wins; the render path degrades
  ["text", '{"a":1}', true],
  ["unknown", "[1,2]", true],
  ["text", "plain", false],
  ["integer", "[1]", false],
  ["ARRAY", "{a,b}", false],
  ["text[]", "{a,b}", false],
  ["integer[]", '{"1","2"}', false],
  ["int4range", "[1,10)", false],
  ["int4multirange", "{[1,3)}", false],
  ["path", "[(0,0),(1,1)]", false],
  ["varchar(255)", '{"a":1}', true],
  ["TEXT", "[1]", true],
  ["", "{}", true],
  ["character varying(255)", '{"a":1}', true],
  ["character varying(255)[]", "{a,b}", false],
  ["citext", '{"a":1}', true],
  ["VARYING CHARACTER(20)", "[1]", true],
  ["NVARCHAR2(40)", "[1]", true],
  ["numeric", "[1.5,2.5]", false],
  ["numrange", "[1.5,2.5]", false],
  ["USER-DEFINED", "[1.5,2.5]", false],
  ["_text", "{a,b}", false],
];

for (const [type, raw, expected] of JSON_CASES) {
  test(`rendersAsJson(${JSON.stringify(type)}, ${JSON.stringify(raw)}) -> ${expected}`, () => {
    assert.equal(rendersAsJson({ name: "c", type }, raw), expected);
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

test("cellTypeClass falls back to the server's join class when the type name is unknown", () => {
  assert.equal(cellTypeClass({ type: "positive_int", class: "number" }), "number");
  assert.equal(cellTypeClass({ type: "event_time", class: "temporal" }), "date");
  assert.equal(cellTypeClass({ type: "tinyint(1)", class: "number" }), "bool");
  assert.equal(cellTypeClass({ type: "label", class: "text" }), null);
  assert.equal(cellTypeClass({ type: "mystery" }), null);
});
