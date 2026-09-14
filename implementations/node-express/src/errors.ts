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

/** Guards a timeout interpolated into SQL syntax that cannot use bound parameters. */
export function assertSafeTimeoutMs(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 3_600_000) {
    throw new Error(`invalid timeoutMs: ${timeoutMs}`);
  }
}

/**
 * Which allow-list (or privilege check) rejected the request — maps 1:1
 * onto spec/protocol.md §2's `unknown_source`/`unknown_schema`/
 * `unknown_table`/`unknown_column`/`not_readable` error codes.
 */
export type NotAllowedKind = "source" | "schema" | "table" | "column" | "not_readable";

export const NOT_ALLOWED_CODE: Record<NotAllowedKind, string> = {
  source: "unknown_source",
  schema: "unknown_schema",
  table: "unknown_table",
  column: "unknown_column",
  not_readable: "not_readable",
};

/** A table/column/sort name did not match the live schema allow-list (spec/protocol.md §6). Maps to 400. */
export class NotAllowedError extends Error {
  readonly kind: NotAllowedKind;

  constructor(what: string, kind: NotAllowedKind) {
    super(`not allowed: ${what}`);
    this.name = "NotAllowedError";
    this.kind = kind;
  }
}

/** A structural violation of the filter AST (spec/protocol.md §5.4.2). Maps to 400. */
export class FilterError extends Error {
  constructor(reason: string) {
    super(`invalid filter: ${reason}`);
    this.name = "FilterError";
  }
}

/**
 * The allow-list already rejects tables the role can't SELECT, so a
 * `permission denied` (SQLSTATE 42501) reaching the row fetch is a
 * residual edge; report it as NotAllowedError (→ 400) rather than letting
 * the raw driver error surface as a 500. Also maps a filter value
 * Postgres's text encoding rejects (SQLSTATE 22021/22P05) to FilterError,
 * also 400, never a raw 500 (docs/adapter-decisions.md §5.4.2 has the
 * cross-backend rationale).
 */
export function mapSelectDenied(err: unknown, table: string): unknown {
  const code = typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
  if (code === "42501") {
    return new NotAllowedError(`table "${table}"`, "not_readable");
  }
  if (code === "22021" || code === "22P05") {
    const message = err instanceof Error ? err.message : String(err);
    return new FilterError(`value invalid for this backend: ${message}`);
  }
  return err;
}

/**
 * MySQL/MariaDB analog of {@link mapSelectDenied}: information_schema.tables
 * lists a table the role holds *any* privilege on, not just SELECT, and
 * there is no has_table_privilege function to gate the listing on (see
 * docs/adapter-decisions.md §5.2/§5.3). A residual
 * ER_TABLEACCESS_DENIED_ERROR (errno 1142, both engines) at the row fetch
 * becomes NotAllowedError (→ 400) instead of a raw 500.
 */
export function mapSelectDeniedMysql(err: unknown, table: string): unknown {
  if (typeof err === "object" && err !== null && "errno" in err && (err as { errno?: unknown }).errno === 1142) {
    return new NotAllowedError(`table "${table}"`, "not_readable");
  }
  return err;
}
