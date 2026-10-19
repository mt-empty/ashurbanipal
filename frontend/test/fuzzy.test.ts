import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyFilter, fuzzyScore } from "../src/lib/fuzzy.ts";

test("letters must appear in order, case-insensitively", () => {
  assert.notEqual(fuzzyScore("ordx", "order_extra"), null);
  assert.notEqual(fuzzyScore("OE", "order_extra"), null);
  assert.equal(fuzzyScore("xo", "order_extra"), null);
  assert.equal(fuzzyScore("", "anything"), 0);
});

test("prefix and word-start matches rank above scattered ones, shorter names break ties", () => {
  const tables = ["audit_log_users", "users", "user_sessions", "orders"];
  assert.deepEqual(
    fuzzyFilter("us", tables, (t) => t),
    ["users", "user_sessions", "audit_log_users"],
  );
  assert.deepEqual(fuzzyFilter("ue", ["user_events", "users"], (t) => t)[0], "user_events");
});

test("an empty query keeps every item in order", () => {
  assert.deepEqual(
    fuzzyFilter("  ", ["b", "a"], (t) => t),
    ["b", "a"],
  );
});

test("a word-start jump never skips the only place the rest of the query fits", () => {
  assert.notEqual(fuzzyScore("ui", "build_users"), null);
  assert.notEqual(fuzzyScore("ba", "xbay_b"), null);
  assert.deepEqual(
    fuzzyFilter("ui", ["build_users"], (t) => t),
    ["build_users"],
  );
});
