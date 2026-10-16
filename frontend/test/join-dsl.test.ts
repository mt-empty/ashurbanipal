import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { toWire } from "../src/lib/join-def.ts";
import type { JoinCatalog } from "../src/lib/join-dsl.ts";
import { parseJoin, printJoin } from "../src/lib/join-dsl.ts";
import { joinBlocker, unjoinableReason } from "../src/lib/join-types.ts";

// The single join-text -> JoinDef parser (spec/join-dsl.md). Cases come from
// spec/fixtures/join-parser-tests.json, generated from the doc's §5 table.

interface JoinCase {
  name: string;
  input: string;
  no_catalog?: boolean;
  expect?: unknown;
  canonical?: string;
  expect_error?: { code: string; line?: number; column?: number; suggest?: string };
}

const fixtureUrl = new URL("../../spec/fixtures/join-parser-tests.json", import.meta.url);
const fixture: { catalog: JoinCatalog; cases: JoinCase[] } = JSON.parse(readFileSync(fixtureUrl, "utf8"));

for (const c of fixture.cases) {
  test(`${c.name}: ${JSON.stringify(c.input.slice(0, 60))}`, () => {
    const result = parseJoin(c.input, c.no_catalog ? undefined : fixture.catalog);
    if (c.expect) {
      assert.ok("def" in result, "error" in result ? result.error.message : "");
      assert.deepEqual(result.def, c.expect);
      assert.equal(printJoin(result.def), c.canonical);
      // text -> definition -> text is stable
      const again = parseJoin(c.canonical as string, c.no_catalog ? undefined : fixture.catalog);
      assert.ok("def" in again);
      assert.deepEqual(again.def, c.expect);
      return;
    }
    assert.ok("error" in result, "expected a rejection");
    const want = c.expect_error as NonNullable<JoinCase["expect_error"]>;
    assert.equal(result.error.code, want.code, result.error.message);
    if (want.line !== undefined) assert.equal(result.error.line, want.line);
    if (want.column !== undefined) assert.equal(result.error.column, want.column);
    assert.equal(result.error.suggest, want.suggest);
  });
}

test("toWire merges tables into joins and omits columns for all columns", () => {
  const parsed = parseJoin("FROM orders o LEFT JOIN users u ON o.user_id = u.id", fixture.catalog);
  assert.ok("def" in parsed);
  assert.deepEqual(
    toWire(parsed.def, () => []),
    {
      table: "orders",
      joins: [{ type: "left", table: "users", on: [{ left: { join: 0, column: "user_id" }, right: "id" }] }],
    },
  );
});

test("toWire expands alias.* in catalog order beside explicit columns", () => {
  const parsed = parseJoin("SELECT o.*, u.email FROM orders o JOIN users u ON o.user_id = u.id", fixture.catalog);
  assert.ok("def" in parsed);
  const wire = toWire(parsed.def, (join) => fixture.catalog[parsed.def.tables[join].table] ?? []);
  assert.deepEqual(wire.columns?.slice(0, 2), [
    { join: 0, column: "id" },
    { join: 0, column: "user_id" },
  ]);
  assert.deepEqual(wire.columns?.at(-1), { join: 1, column: "email" });
});

test("join type hints grey incompatible and unjoinable columns, and allow what they cannot tell", () => {
  assert.equal(joinBlocker("uuid", "uuid"), null);
  assert.equal(joinBlocker("integer", "bigint"), null);
  assert.equal(joinBlocker("USER-DEFINED", "uuid"), "custom type ≠ uuid");
  assert.equal(joinBlocker("USER-DEFINED", "text"), null);
  assert.equal(joinBlocker("jsonb", "text"), "jsonb: not joinable");
  assert.equal(joinBlocker("text", "ARRAY"), "ARRAY: not joinable");
  assert.equal(joinBlocker("geometry", "uuid"), null);
  assert.equal(unjoinableReason("double precision"), "double precision: not joinable");
  assert.equal(unjoinableReason("uuid"), null);
});
