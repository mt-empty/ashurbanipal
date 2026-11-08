import { ApiError, api } from "../core/api.js";
import { refInScope, state } from "../core/state.js";
import type { Column, TableRef, ViewData } from "../core/types.js";
import type { JoinCatalog } from "../lib/join-dsl.js";
import { refKey, tableParams } from "../lib/table-ref.js";
import { tableStructure } from "./structure.js";
import { listedTableNames } from "./table-chips.js";

// The page learns a table's columns (names, types, keys) from the first row of
// its data; the table listing carries only names. Cached per table, failures
// included, until Refresh: a table the role cannot read is not asked for again
// on every keystroke.
const cache = new Map<string, Promise<Column[]>>();
const resolved = new Map<string, Column[]>();
const indexes = new Map<string, Promise<Set<string>>>();
const indexesRead = new Map<string, Set<string>>();
let generation = 0;
let version = 0;

export function clearJoinCatalog(): void {
  cache.clear();
  resolved.clear();
  indexes.clear();
  indexesRead.clear();
  generation++;
  version++;
}

// Bumped whenever a table's columns become known, so derived results can tell they are stale.
export function catalogVersion(): number {
  return version;
}

// The columns of the table in view arrive with its data; no need to ask again.
export function seedColumns(table: TableRef, columns: Column[]): void {
  const key = refKey(table);
  if (resolved.has(key)) return;
  resolved.set(key, columns);
  version++;
  cache.set(key, Promise.resolve(columns));
}

export function tableColumns(table: TableRef): Promise<Column[]> {
  const key = refKey(table);
  let columns = cache.get(key);
  if (!columns) {
    const params = tableParams(table, { limit: "1", offset: "0" });
    const started = generation;
    const asked = api<ViewData>(`/tables/data?${params}`).then((d) => {
      if (started === generation) {
        resolved.set(key, d.columns);
        version++;
      }
      return d.columns;
    });
    cache.set(key, asked);
    // A missing or unreadable table stays failed; a network error or timeout may pass on the next ask.
    asked.catch((e: unknown) => {
      const lasting = e instanceof ApiError && (e.code === "unknown_table" || e.code === "not_readable");
      if (!lasting && cache.get(key) === asked) cache.delete(key);
    });
    columns = asked;
  }
  return columns;
}

// What is already known, for places that cannot wait on a request.
export function cachedColumns(table: TableRef): Column[] | undefined {
  return resolved.get(refKey(table));
}

// Every table the scope lists, with its columns where they have been read.
export function knownCatalog(): JoinCatalog {
  return Object.fromEntries(
    listedTableNames().map((t) => [t, cachedColumns(refInScope(t))?.map((c) => c.name) ?? null]),
  );
}

// Every listed schema for `schema.table` names: the scope's own with its tables,
// the others not loaded. Undefined while the list is unknown, so nothing is rejected.
export function knownSchemas(): Record<string, JoinCatalog | null> | undefined {
  if (state.schemas.length === 0) return undefined;
  const own = knownCatalog();
  return Object.fromEntries(state.schemas.map((s) => [s, s === state.scope.schema ? own : null]));
}

// Columns that lead an index, so a join on them is cheap. A table whose structure cannot be read has none.
export function indexedColumns(table: TableRef): Promise<Set<string>> {
  const key = refKey(table);
  let found = indexes.get(key);
  if (!found) {
    const asked = generation;
    // A failed lookup counts as read too, with no tags, so callers waiting on it stop asking.
    found = tableStructure(table)
      .then(
        (s) => new Set(s.indexes.map((i) => i.columns[0])),
        () => new Set<string>(),
      )
      .then((set) => {
        if (asked === generation) indexesRead.set(key, set);
        return set;
      });
    indexes.set(key, found);
  }
  return found;
}

export function readIndexedColumns(table: TableRef): ReadonlySet<string> | undefined {
  return indexesRead.get(refKey(table));
}
