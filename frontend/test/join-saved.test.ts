import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SAVED_PER_SCOPE, sanitizeSaved, scopeEntries, withoutSaved, withSaved } from "../src/lib/join-saved.ts";
import { isScopeKey, scopeKey } from "../src/lib/scope-key.ts";

const entry = (name: string, text = `FROM a JOIN b ON a.x = b.${name}`) => ({ name, text });
// The store uses null-prototype objects, which deepStrictEqual tells apart from literals.
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
const S = scopeKey("primary", "public");
const sanitize = (raw: unknown) => sanitizeSaved(raw, () => true);

test("anything that is not the saved shape is dropped", () => {
  assert.deepEqual(plain(sanitize("x")), {});
  assert.deepEqual(plain(sanitize([])), {});
  assert.deepEqual(
    plain(
      sanitize({
        [S]: [entry("ok"), { name: 1, text: "x" }, "y", { name: " ", text: "x" }, entry("ok")],
      }),
    ),
    {
      [S]: [entry("ok")],
    },
  );
  assert.deepEqual(plain(sanitize({ [S]: "no", t: 3, u: { public: [entry("ok")] } })), {});
});

test("a key the caller does not accept is dropped", () => {
  const raw = { junk: [entry("a")], [scopeKey("a", "b", "c")]: [entry("b")], [S]: [entry("c")] };
  assert.deepEqual(plain(sanitizeSaved(raw, (key) => isScopeKey(key, 2))), { [S]: [entry("c")] });
});

test("a scope key named like an Object.prototype key stays an ordinary key", () => {
  const raw = JSON.parse(`{"__proto__":[${JSON.stringify(entry("a"))}],"constructor":[${JSON.stringify(entry("b"))}]}`);
  const store = sanitize(raw);
  assert.deepEqual(scopeEntries(store, "__proto__"), [entry("a")]);
  assert.deepEqual(scopeEntries(store, "constructor"), [entry("b")]);
  assert.deepEqual(scopeEntries({}, "toString"), []);
  const saved = withSaved({}, "__proto__", entry("c"));
  assert.ok("store" in saved);
  assert.deepEqual(scopeEntries(saved.store, "__proto__"), [entry("c")]);
  assert.equal(({} as Record<string, unknown>).p, undefined);
  assert.equal(typeof Object.keys, "function");
});

test("saved joins are kept per source and schema", () => {
  let store = {};
  store = (withSaved(store, scopeKey("a", "public"), entry("one")) as { store: typeof store }).store;
  store = (withSaved(store, scopeKey("a", "other"), entry("two")) as { store: typeof store }).store;
  assert.deepEqual(
    scopeEntries(store, scopeKey("a", "public")).map((e) => e.name),
    ["one"],
  );
  assert.deepEqual(
    scopeEntries(store, scopeKey("a", "other")).map((e) => e.name),
    ["two"],
  );
  assert.deepEqual(scopeEntries(store, scopeKey("b", "public")), []);
});

test("saving an existing name replaces it and a rename drops the old name", () => {
  let store = (withSaved({}, S, entry("one")) as { store: Record<string, never> }).store;
  store = (withSaved(store, S, { name: "one", text: "FROM c JOIN d ON c.x = d.y" }) as { store: typeof store }).store;
  assert.equal(scopeEntries(store, S).length, 1);
  assert.match(scopeEntries(store, S)[0].text, /FROM c/);
  store = (withSaved(store, S, entry("renamed"), "one") as { store: typeof store }).store;
  assert.deepEqual(
    scopeEntries(store, S).map((e) => e.name),
    ["renamed"],
  );
});

test("a blank name, a long name and a full scope are refused", () => {
  assert.ok("error" in withSaved({}, S, entry("  ")));
  assert.ok("error" in withSaved({}, S, entry("x".repeat(61))));
  let store = {};
  for (let i = 0; i < MAX_SAVED_PER_SCOPE; i++)
    store = (withSaved(store, S, entry(`n${i}`)) as { store: typeof store }).store;
  assert.ok("error" in withSaved(store, S, entry("one more")));
  assert.ok("store" in withSaved(store, S, entry("n3")));
});

test("deleting the last entry leaves no empty scope behind", () => {
  const store = (withSaved({}, S, entry("one")) as { store: Record<string, never> }).store;
  assert.deepEqual(plain(withoutSaved(store, S, "one")), {});
});

test("saving a join already saved renames its entry in place", () => {
  let store = {};
  for (const name of ["first", "second", "third"])
    store = (withSaved(store, S, entry(name)) as { store: typeof store }).store;
  const result = withSaved(store, S, entry("renamed", entry("second").text));
  assert.ok("store" in result);
  assert.deepEqual(
    scopeEntries(result.store, S).map((e) => e.name),
    ["first", "renamed", "third"],
  );
});

test("renaming keeps the entry's place", () => {
  let store = {};
  for (const name of ["first", "second"]) store = (withSaved(store, S, entry(name)) as { store: typeof store }).store;
  const result = withSaved(store, S, entry("new name", "FROM a JOIN b ON a.x = b.z"), "first");
  assert.ok("store" in result);
  assert.deepEqual(
    scopeEntries(result.store, S).map((e) => e.name),
    ["new name", "second"],
  );
});
