import { ApiError, api } from "../core/api.js";
import { applyScopeParams, requestTableKey } from "../core/state.js";
import type { Column, ViewData } from "../core/types.js";
import type { JoinCatalog } from "../lib/join-dsl.js";
import { tableStructure } from "./structure.js";
import { listedTableNames } from "./table-chips.js";

// The page learns a table's columns (names, types, keys) from the first row of
// its data; the table listing carries only names. Cached per scope, failures
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
export function seedColumns(table: string, columns: Column[]): void {
  const key = requestTableKey(table);
  if (resolved.has(key)) return;
  resolved.set(key, columns);
  version++;
  cache.set(key, Promise.resolve(columns));
}

export function tableColumns(table: string): Promise<Column[]> {
  const key = requestTableKey(table);
  let columns = cache.get(key);
  if (!columns) {
    const params = new URLSearchParams({ table, limit: "1", offset: "0" });
    applyScopeParams(params);
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
export function cachedColumns(table: string): Column[] | undefined {
  return resolved.get(requestTableKey(table));
}

// Every listed table, with its columns where they have been read.
export function knownCatalog(): JoinCatalog {
  return Object.fromEntries(listedTableNames().map((t) => [t, cachedColumns(t)?.map((c) => c.name) ?? null]));
}

// Columns that lead an index, so a join on them is cheap. A table whose structure cannot be read has none.
export function indexedColumns(table: string): Promise<Set<string>> {
  const key = requestTableKey(table);
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

export function readIndexedColumns(table: string): ReadonlySet<string> | undefined {
  return indexesRead.get(requestTableKey(table));
}
