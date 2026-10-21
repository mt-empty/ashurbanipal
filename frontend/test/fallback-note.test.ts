import assert from "node:assert/strict";
import { test } from "node:test";
import type { Swap } from "../src/core/types.ts";
import { buildFallbackNote, type NoteSegment, swapsFrom } from "../src/lib/fallback-note.ts";

// Flattens segments so a case reads as the sentence the user sees, with
// `code` and [label] marked.
const plain = (segments: NoteSegment[]) =>
  segments.map((s) => ("code" in s ? `\`${s.code}\`` : "label" in s ? `[${s.label}]` : s.text)).join("");

const here = null;
const swap = (kind: Swap["kind"], asked: string, got: string | null): Swap => ({ kind, asked, got });

test("no swaps, no note", () => {
  assert.deepEqual(buildFallbackNote([], "orders", here), []);
});

test("missing table with its filter", () => {
  const swaps = [swap("table", "orders", "audit_log"), swap("filter", "status = completed", null)];
  assert.equal(
    plain(buildFallbackNote(swaps, "audit_log", here)),
    "There is no table `orders` here. Showing `audit_log` instead, without your filter.",
  );
});

test("missing table without a filter", () => {
  assert.equal(
    plain(buildFallbackNote([swap("table", "orders", "audit_log")], "audit_log", here)),
    "There is no table `orders` here. Showing `audit_log` instead.",
  );
});

test("names follow top-bar order whatever the record order", () => {
  const swaps = [
    swap("table", "orders", "audit_log"),
    swap("schema", "sales", "public"),
    swap("filter", "x = 1", null),
  ];
  assert.equal(
    plain(buildFallbackNote(swaps, "audit_log", here)),
    "There is no schema `sales` or table `orders` here. Showing `public` / `audit_log` instead, without your filter.",
  );
});

test("three names join with a comma, then or", () => {
  const swaps = [swap("source", "replica", "primary"), swap("schema", "sales", "public"), swap("table", "t", "u")];
  assert.equal(
    plain(buildFallbackNote(swaps, "u", here)),
    "There is no source `replica`, schema `sales` or table `t` here. Showing `primary` / `public` / `u` instead.",
  );
});

test("only the filter was dropped", () => {
  assert.equal(
    plain(buildFallbackNote([swap("filter", "nosuchcol = 1", null)], "orders", here)),
    "Your filter doesn't fit `orders` here, so it was removed.",
  );
});

test("a table with nothing to show instead", () => {
  assert.equal(
    plain(buildFallbackNote([swap("table", "orders", null)], null, here)),
    "There is no table `orders` here.",
  );
});

test("an instance label replaces here", () => {
  assert.equal(
    plain(buildFallbackNote([swap("table", "orders", "audit_log")], "audit_log", "int")),
    "There is no table `orders` in [int]. Showing `audit_log` instead.",
  );
});

const settled = (over: Partial<Record<Swap["kind"], string | null>>) => ({
  source: "primary",
  schema: "public",
  table: "orders",
  filter: null,
  ...over,
});

test("nothing asked, or everything granted, gives no swaps", () => {
  assert.deepEqual(swapsFrom({}, settled({ table: "audit_log" })), []);
  assert.deepEqual(swapsFrom({ table: "orders", filter: "x = 1" }, settled({ filter: "x = 1" })), []);
});

test("a missing table and its dropped filter are both swaps, in top-bar order", () => {
  assert.deepEqual(swapsFrom({ filter: "x = 1", table: "nosuch" }, settled({ table: "audit_log" })), [
    swap("table", "nosuch", "audit_log"),
    swap("filter", "x = 1", null),
  ]);
});

test("a hidden source or schema selector is not a swap", () => {
  assert.deepEqual(swapsFrom({ source: "replica", schema: "sales" }, settled({ source: null, schema: null })), []);
});

test("a missing source or schema is a swap; a scope with no tables keeps a null table", () => {
  assert.deepEqual(swapsFrom({ source: "replica", schema: "sales", table: "orders" }, settled({ table: null })), [
    swap("source", "replica", "primary"),
    swap("schema", "sales", "public"),
    swap("table", "orders", null),
  ]);
});
