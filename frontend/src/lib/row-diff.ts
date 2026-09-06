import type { Row, TableData } from "../core/types.js";

// The new-since-refresh row highlight (ui-guidelines R10): rows present now
// but absent from the previous fetch of the *same view* are tinted. Pure over
// a pair of fetch results — the "same view" test and the previous payload are
// the caller's (store.ts) to hold.

// Row identity for the highlight. PK-only: whole-row hashing would mark an
// edited row as new and collide on duplicates. Never persisted — a PK value
// can be a data value (R6).
export function rowKey(pkNames: string[], row: Row): string {
  return JSON.stringify(pkNames.map((n) => row[n]));
}

// Rows in `next` absent from the previous same-view fetch, so a refresh can
// tint them — but only when the highlight is on, the scope is unchanged, and
// the table has a PK to identify rows by.
export function collectNewRowKeys(
  prev: TableData | null,
  next: TableData,
  opts: { highlightNew: boolean; sameScope: boolean },
): { newRowKeys?: Set<string>; pkNames: string[] } {
  if (!opts.highlightNew || !prev || !opts.sameScope) return { pkNames: [] };
  const pkNames = next.columns.filter((c) => c.key === "pk").map((c) => c.name);
  if (!pkNames.length) return { pkNames: [] };
  const prevKeys = new Set(prev.rows.map((r) => rowKey(pkNames, r)));
  const newRowKeys = new Set(next.rows.map((r) => rowKey(pkNames, r)).filter((k) => !prevKeys.has(k)));
  return { newRowKeys, pkNames };
}
