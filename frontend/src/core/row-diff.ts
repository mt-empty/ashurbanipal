import { getAppliedFilterAst, state } from "./store.js";
import type { Row, TableData } from "./types.js";

// The new-since-refresh row highlight (ui-guidelines R10): rows present now
// but absent from the previous fetch of the *same view* are tinted. Kept
// apart from store.ts because it is pure derivation over a fetch result,
// not view state.

// Row identity for the highlight. PK-only: whole-row hashing would mark an
// edited row as new and collide on duplicates. Never persisted — a PK value
// can be a data value (R6).
export function rowKey(pkNames: string[], row: Row): string {
  return JSON.stringify(pkNames.map((n) => row[n]));
}

// Identifies "the same view" between two fetches. A sort/filter/page/scope
// change makes every row look new, so the highlight only fires when this
// is unchanged from the fetch it's being diffed against.
export function scopeKey(): string {
  return JSON.stringify([
    state.source,
    state.schema,
    state.table,
    state.sort,
    state.order,
    state.offset,
    state.limit,
    getAppliedFilterAst(),
  ]);
}

let lastPayload: TableData | null = null;
export function getLastPayload(): TableData | null {
  return lastPayload;
}

let lastScopeKey: string | null = null;

// Rows present now but absent from the previous fetch of the same view count
// as new, so a refresh can tint them — but only when the scope is unchanged
// and the table has a PK to identify rows by. Also advances the
// lastPayload/lastScopeKey bookkeeping, since it only ever happens alongside
// this diff.
export function diffNewRows(data: TableData, highlightNew: boolean): { newRowKeys?: Set<string>; pkNames: string[] } {
  const prev = lastPayload;
  const nowScope = scopeKey();
  let newRowKeys: Set<string> | undefined;
  let pkNames: string[] = [];
  if (highlightNew && prev && lastScopeKey === nowScope) {
    pkNames = data.columns.filter((c) => c.key === "pk").map((c) => c.name);
    if (pkNames.length) {
      const prevKeys = new Set(prev.rows.map((r) => rowKey(pkNames, r)));
      newRowKeys = new Set(data.rows.map((r) => rowKey(pkNames, r)).filter((k) => !prevKeys.has(k)));
    }
  }
  lastPayload = data;
  lastScopeKey = nowScope;
  return { newRowKeys, pkNames };
}
