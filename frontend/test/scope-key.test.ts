import assert from "node:assert/strict";
import { test } from "node:test";
import { isScopeKey, scopeKey, visitKey } from "../src/lib/scope-key.ts";

test("names that hold separators never make two scopes collide", () => {
  assert.notEqual(scopeKey("a|b", "c"), scopeKey("a", "b|c"));
  assert.notEqual(scopeKey("a", "b", "c"), scopeKey("a", 'b","c'));
  assert.notEqual(scopeKey("a,b", "c"), scopeKey("a", "b,c"));
  assert.notEqual(scopeKey("[a", "b]"), scopeKey("[a,b]", ""));
  assert.notEqual(scopeKey("a", "b"), scopeKey("a", "b", ""));
});

test("a key reads back as its parts", () => {
  const key = scopeKey('we"ird|src', "pub,lic", "t[1]");
  assert.ok(isScopeKey(key, 3));
  assert.deepEqual(JSON.parse(key), ['we"ird|src', "pub,lic", "t[1]"]);
});

test("a key of the wrong shape is refused", () => {
  assert.ok(!isScopeKey(scopeKey("a", "b"), 3));
  assert.ok(!isScopeKey(scopeKey("a", "b", "c"), 2));
  assert.ok(!isScopeKey(JSON.stringify([null, "public", "orders"]), 3));
  assert.ok(!isScopeKey(JSON.stringify({ 0: "a", 1: "b" }), 2));
  assert.ok(!isScopeKey("a|b", 2));
  assert.ok(!isScopeKey("", 2));
});

test("a per-visit key tells an unresolved name from one spelled null", () => {
  assert.notEqual(visitKey(null, "public"), visitKey("null", "public"));
  assert.equal(visitKey("a", "b", "t"), scopeKey("a", "b", "t"));
});
