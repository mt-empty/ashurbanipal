/**
 * quoteIdent double-quotes a SQL identifier by plain concatenation, not a
 * JS-string-escaping helper: Postgres quoted-identifier escaping doubles an
 * embedded `"` rather than backslash-escaping it, so a generic string
 * escaper would produce the wrong SQL for that exact input. Callers must
 * only pass a value already exact-matched against a live schema-catalog
 * lookup (spec/protocol.md §6); this function does no validation itself.
 */
export function quoteIdent(name: string): string {
  return `"${name}"`;
}

/** A table/column/sort name did not match the live schema allow-list (spec/protocol.md §6). Maps to 400. */
export class NotAllowedError extends Error {
  constructor(what: string) {
    super(`not allowed: ${what}`);
    this.name = "NotAllowedError";
  }
}

/** A structural violation of the filter AST (spec/protocol.md §5.4.2). Maps to 400. */
export class FilterError extends Error {
  constructor(reason: string) {
    super(`invalid filter: ${reason}`);
    this.name = "FilterError";
  }
}
