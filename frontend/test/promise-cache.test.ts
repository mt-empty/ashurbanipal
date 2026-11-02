import assert from "node:assert/strict";
import { test } from "node:test";
import { createPromiseCache } from "../src/lib/promise-cache.ts";

test("a request in flight is shared and its answer kept", async () => {
  const cache = createPromiseCache<number>();
  let calls = 0;
  const load = () => Promise.resolve(++calls);
  const [a, b] = await Promise.all([cache.get("k", load), cache.get("k", load)]);
  assert.deepEqual([a, b, calls], [1, 1, 1]);
  assert.equal(cache.peek("k"), 1);
  assert.equal(await cache.get("k", load), 1);
});

test("a failure is not kept", async () => {
  const cache = createPromiseCache<number>();
  await assert.rejects(cache.get("k", () => Promise.reject(new Error("down"))));
  assert.equal(cache.peek("k"), undefined);
  assert.equal(await cache.get("k", () => Promise.resolve(2)), 2);
});

test("clear() stops a request in flight from storing its answer", async () => {
  const cache = createPromiseCache<number>();
  let release: (n: number) => void = () => {};
  const pending = cache.get("k", () => new Promise<number>((r) => (release = r)));
  cache.clear();
  release(1);
  assert.equal(await pending, 1);
  assert.equal(cache.peek("k"), undefined);
});
