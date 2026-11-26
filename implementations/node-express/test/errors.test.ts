import { describe, expect, it, vi } from "vitest";
import { assertSafeTimeoutMs, quoteIdent } from "../src/errors.js";
import { errorResult } from "../src/handlers.js";

describe("errorResult", () => {
  it("gives a database error a title with no engine text, and logs the detail", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("select secret from t");
    const result = errorResult(err);
    expect(result.status).toBe(500);
    expect(JSON.parse(result.body)).toMatchObject({ code: "database_error", title: "database error" });
    expect(result.body).not.toContain("secret");
    expect(log).toHaveBeenCalledWith("ashurbanipal: database error", err);
    log.mockRestore();
  });
});

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
