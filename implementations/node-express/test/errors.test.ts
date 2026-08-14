import { describe, expect, it } from "vitest";
import { quoteIdent } from "../src/errors.js";

// Mirrors implementations/rust/core/src/db/mod.rs::quote_ident_doubles_embedded_quotes
// and the Spring Boot port's equivalent — the same allow-list-then-escape
// discipline (spec/protocol.md §6) applies here.
describe("quoteIdent", () => {
  it("plain identifiers are just double-quoted", () => {
    expect(quoteIdent("users")).toBe('"users"');
  });

  it("doubles an embedded double-quote rather than letting it close the identifier early", () => {
    expect(quoteIdent('foo"bar')).toBe('"foo""bar"');
    expect(quoteIdent('a"; drop table users; --')).toBe('"a""; drop table users; --"');
  });
});
