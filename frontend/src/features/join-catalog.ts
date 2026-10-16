import { api } from "../core/api.js";
import { applyScopeParams, state } from "../core/state.js";
import type { Column, TableData } from "../core/types.js";
import type { JoinCatalog } from "../lib/join-dsl.js";
import { listedTableNames } from "./sidebar.js";
import { tableStructure } from "./structure.js";

// The page learns a table's columns (names, types, keys) from the first row of
// its data; the table listing carries only names. Cached per scope, since a
// join view and its form both ask for the same tables repeatedly.
const cache = new Map<string, Promise<Column[]>>();
const resolved = new Map<string, Column[]>();
const keyOf = (table: string): string => `${state.source}|${state.schema}|${table}`;

export function clearJoinCatalog(): void {
  cache.clear();
  resolved.clear();
}

export function tableColumns(table: string): Promise<Column[]> {
  const params = new URLSearchParams({ table, limit: "1", offset: "0" });
  applyScopeParams(params);
  const key = keyOf(table);
  let columns = cache.get(key);
  if (!columns) {
    columns = api<TableData>(`/tables/data?${params}`).then((d) => {
      resolved.set(key, d.columns);
      return d.columns;
    });
    cache.set(key, columns);
    // A failed lookup must not be remembered.
    columns.catch(() => cache.delete(key));
  }
  return columns;
}

// What is already known, for places that cannot wait on a request.
export function cachedColumns(table: string): Column[] | undefined {
  return resolved.get(keyOf(table));
}

// Every listed table, with its columns where they have been read.
export function knownCatalog(): JoinCatalog {
  return Object.fromEntries(listedTableNames().map((t) => [t, cachedColumns(t)?.map((c) => c.name) ?? null]));
}

// Columns that lead an index, so a join on them is cheap.
export async function indexedColumns(table: string): Promise<Set<string>> {
  try {
    return new Set((await tableStructure(table)).indexes.map((i) => i.columns[0]));
  } catch {
    return new Set();
  }
}
