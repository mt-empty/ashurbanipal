import { describe, expect, it } from "vitest";
import { quoteIdent } from "../../src/db/types.js";

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
