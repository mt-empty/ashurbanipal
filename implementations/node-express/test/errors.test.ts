import { describe, expect, it } from "vitest";
import { assertSafeTimeoutMs, quoteIdent } from "../src/errors.js";

// Identifiers require allow-list validation before escaping (spec/protocol.md §6).
describe("quoteIdent", () => {
  it("plain identifiers are just double-quoted", () => {
    expect(quoteIdent("users")).toBe('"users"');
  });

  it("doubles an embedded double-quote rather than letting it close the identifier early", () => {
    expect(quoteIdent('foo"bar')).toBe('"foo""bar"');
    expect(quoteIdent('a"; drop table users; --')).toBe('"a""; drop table users; --"');
  });
});

// Guards the SET LOCAL / query-hint splice points (postgres.ts's withTimeout,
// mysql.ts's timedSelect) that can't use a bound parameter — same
// allow-list-before-splice discipline as quoteIdent, applied to an integer.
describe("assertSafeTimeoutMs", () => {
  it("accepts a normal config-derived value", () => {
    expect(() => assertSafeTimeoutMs(5000)).not.toThrow();
    expect(() => assertSafeTimeoutMs(0)).not.toThrow();
  });

  it("rejects non-integer, negative, and oversized values", () => {
    expect(() => assertSafeTimeoutMs(1.5)).toThrow("invalid timeoutMs");
    expect(() => assertSafeTimeoutMs(-1)).toThrow("invalid timeoutMs");
    expect(() => assertSafeTimeoutMs(3_600_001)).toThrow("invalid timeoutMs");
    expect(() => assertSafeTimeoutMs(Number.NaN)).toThrow("invalid timeoutMs");
  });
});
