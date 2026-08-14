/**
 * Escapes an identifier for splicing into SQL text by doubling embedded
 * `"` (the standard Postgres quoted-identifier escape). Callers must only
 * pass a value already exact-matched against a live schema-catalog lookup
 * (spec/protocol.md §6); this function does no validation itself, it only
 * makes an already-validated name syntactically safe to splice.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Guards a value about to be spliced into SQL text as a raw integer (SET LOCAL /
 * query-hint syntax that Postgres/MySQL don't accept bound parameters for).
 * Mirrors the guarantee Rust gets for free from timeout_secs: u32 — TS's
 * `number` type doesn't survive to runtime, so this is the runtime equivalent.
 */
export function assertSafeTimeoutMs(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 3_600_000) {
    throw new Error(`invalid timeoutMs: ${timeoutMs}`);
  }
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
