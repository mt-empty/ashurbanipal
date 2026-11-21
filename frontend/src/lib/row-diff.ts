import type { Row, ViewData } from "../core/types.js";

// The since-refresh highlight (ui-guidelines R10): rows present now but absent
// from the previous fetch of the *same view* are tinted as new, and cells whose
// value differs from the same row's previous value are tinted as changed. Pure
// over a pair of fetch results — the "same view" test and the previous payload
// are the caller's (store.ts) to hold.

// Row identity for the highlight. PK-only: whole-row hashing would mark an
// edited row as new and collide on duplicates. Never persisted — a PK value
// can be a data value (R6).
export function rowKey(pkNames: string[], row: Row): string {
  return JSON.stringify(pkNames.map((n) => row[n]));
}

export interface RowChanges {
  newRowKeys?: Set<string>;
  // rowKey → names of the columns whose value differs from the previous fetch.
  changedCells?: Map<string, Set<string>>;
  pkNames: string[];
}

// Diffs `next` against the previous same-view fetch, but only when the
// highlight is on, the scope is unchanged, and the table has a PK to identify
// rows by. A column present in only one of the two fetches is not a change.
export function collectRowChanges(
  prev: ViewData | null,
  next: ViewData,
  opts: { highlightNew: boolean; sameScope: boolean },
): RowChanges {
  if (!opts.highlightNew || !prev || !opts.sameScope) return { pkNames: [] };
  const pkNames = next.columns.filter((c) => c.key === "pk").map((c) => c.name);
  if (!pkNames.length) return { pkNames: [] };
  const prevNames = new Set(prev.columns.map((c) => c.name));
  const shared = next.columns.map((c) => c.name).filter((n) => prevNames.has(n));
  const prevRows = new Map(prev.rows.map((r) => [rowKey(pkNames, r), r]));
  const newRowKeys = new Set<string>();
  const changedCells = new Map<string, Set<string>>();
  for (const row of next.rows) {
    const key = rowKey(pkNames, row);
    const before = prevRows.get(key);
    if (!before) {
      newRowKeys.add(key);
      continue;
    }
    const changed = shared.filter((n) => before[n] !== row[n]);
    if (changed.length) changedCells.set(key, new Set(changed));
  }
  return { newRowKeys, changedCells, pkNames };
}

// The changed-rows count for the chip and #status: rows with any changed cell.
// When every change is in a hidden column there is no tint to see, so the text
// says where the change is.
export function changedRowsText(
  changedCells: Map<string, Set<string>> | undefined,
  hidden: ReadonlySet<string>,
): string {
  if (!changedCells?.size) return "";
  const columns = new Set<string>();
  for (const names of changedCells.values()) for (const name of names) columns.add(name);
  const hiddenCount = [...columns].filter((name) => hidden.has(name)).length;
  if (hiddenCount < columns.size) return `${changedCells.size} changed`;
  return `${changedCells.size} changed in ${hiddenCount === 1 ? "a hidden column" : "hidden columns"}`;
}
