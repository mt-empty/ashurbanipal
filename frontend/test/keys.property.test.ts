import assert from "node:assert/strict";
import { test } from "node:test";
import { rowKey } from "../src/lib/row-diff.ts";
import { isScopeKey, scopeKey, visitKey } from "../src/lib/scope-key.ts";
import { fc, TRICKY_CHARS } from "./support/property.ts";

// Names a quoted Postgres identifier may hold, biased toward separators an ad hoc key
// encoding would collide on.
const part = fc.oneof(
  fc.string({ unit: "binary", maxLength: 6 }),
  fc.constantFrom("", ",", ".", "/", ":", '"', "\\", "[", "]", "null", ...TRICKY_CHARS),
);
const parts = fc.array(part, { minLength: 2, maxLength: 4 });

test("property: different scopes never share a key, and every scope key reads back as one", () => {
  fc.assert(
    fc.property(parts, parts, (a, b) => {
      const [sa, ca, ...ra] = a;
      const [sb, cb, ...rb] = b;
      const ka = scopeKey(sa, ca, ...ra);
      assert.equal(ka === scopeKey(sb, cb, ...rb), JSON.stringify(a) === JSON.stringify(b));
      assert.ok(isScopeKey(ka, a.length), ka);
      assert.ok(!isScopeKey(ka, a.length + 1), ka);
    }),
  );
});

test("property: a visit key with an unresolved part never equals one with that part named", () => {
  fc.assert(
    fc.property(fc.option(part), fc.option(part), fc.array(part, { maxLength: 2 }), (source, schema, rest) => {
      const named = visitKey(source ?? "null", schema ?? "null", ...rest);
      const unresolved = visitKey(source, schema, ...rest);
      assert.equal(named === unresolved, source !== null && schema !== null);
    }),
  );
});

// A cell crosses the wire as a string or null (spec/protocol.md §5.4.3).
const cell = fc.option(part);

test("property: rows share a key only when their primary key values are the same", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.string({ maxLength: 4 }), { minLength: 1, maxLength: 3 }),
      fc.array(cell, { minLength: 3, maxLength: 3 }),
      fc.array(cell, { minLength: 3, maxLength: 3 }),
      (pk, va, vb) => {
        const row = (values: (string | null)[]) => Object.fromEntries(pk.map((n, i) => [n, values[i]]));
        const same = pk.every((_, i) => va[i] === vb[i]);
        assert.equal(rowKey(pk, row(va)) === rowKey(pk, row(vb)), same);
      },
    ),
  );
});
