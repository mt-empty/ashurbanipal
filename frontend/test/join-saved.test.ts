import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SAVED_PER_SCOPE, sanitizeSaved, scopeEntries, withoutSaved, withSaved } from "../src/lib/join-saved.ts";

const entry = (name: string) => ({ name, text: "FROM a JOIN b ON a.x = b.y" });

test("anything that is not the saved shape is dropped", () => {
  assert.deepEqual(sanitizeSaved("x"), {});
  assert.deepEqual(sanitizeSaved([]), {});
  assert.deepEqual(
    sanitizeSaved({ s: { public: [entry("ok"), { name: 1, text: "x" }, "y", { name: " ", text: "x" }, entry("ok")] } }),
    {
      s: { public: [entry("ok")] },
    },
  );
  assert.deepEqual(sanitizeSaved({ s: { public: "no" }, t: 3 }), {});
});

test("saved joins are kept per source and schema", () => {
  let store = {};
  store = (withSaved(store, "a", "public", entry("one")) as { store: typeof store }).store;
  store = (withSaved(store, "a", "other", entry("two")) as { store: typeof store }).store;
  assert.deepEqual(
    scopeEntries(store, "a", "public").map((e) => e.name),
    ["one"],
  );
  assert.deepEqual(
    scopeEntries(store, "a", "other").map((e) => e.name),
    ["two"],
  );
  assert.deepEqual(scopeEntries(store, null, null), []);
});

test("saving an existing name replaces it and a rename drops the old name", () => {
  let store = (withSaved({}, null, null, entry("one")) as { store: Record<string, never> }).store;
  store = (withSaved(store, null, null, { name: "one", text: "FROM c JOIN d ON c.x = d.y" }) as { store: typeof store })
    .store;
  assert.equal(scopeEntries(store, null, null).length, 1);
  assert.match(scopeEntries(store, null, null)[0].text, /FROM c/);
  store = (withSaved(store, null, null, entry("renamed"), "one") as { store: typeof store }).store;
  assert.deepEqual(
    scopeEntries(store, null, null).map((e) => e.name),
    ["renamed"],
  );
});

test("a blank name, a long name and a full scope are refused", () => {
  assert.ok("error" in withSaved({}, null, null, entry("  ")));
  assert.ok("error" in withSaved({}, null, null, entry("x".repeat(61))));
  let store = {};
  for (let i = 0; i < MAX_SAVED_PER_SCOPE; i++)
    store = (withSaved(store, null, null, entry(`n${i}`)) as { store: typeof store }).store;
  assert.ok("error" in withSaved(store, null, null, entry("one more")));
  assert.ok("store" in withSaved(store, null, null, entry("n3")));
});

test("deleting the last entry leaves no empty scope behind", () => {
  const store = (withSaved({}, "a", "p", entry("one")) as { store: Record<string, Record<string, never>> }).store;
  assert.deepEqual(withoutSaved(store, "a", "p", "one"), { a: {} });
});
