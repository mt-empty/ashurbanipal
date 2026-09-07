import assert from "node:assert/strict";
import { test } from "node:test";
import { type ColumnTypeClass, columnTypeClass } from "../src/lib/format.ts";

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
  ["tinyint", "number"], // bool-vs-int isn't on the wire; accepted gap
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
];

for (const [input, expected] of CASES) {
  test(`${JSON.stringify(input)} -> ${expected}`, () => {
    assert.equal(columnTypeClass(input), expected);
  });
}
