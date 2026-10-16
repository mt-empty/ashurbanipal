import { api } from "../core/api.js";
import { applyScopeParams, state } from "../core/state.js";
import type { Column, TableData } from "../core/types.js";

// The page learns a table's columns (names, types, keys) from the first row of
// its data; the table listing carries only names. Cached per scope, since a
// join view and its form both ask for the same tables repeatedly.
const cache = new Map<string, Promise<Column[]>>();

export function clearJoinCatalog(): void {
  cache.clear();
}

export function tableColumns(table: string): Promise<Column[]> {
  const params = new URLSearchParams({ table, limit: "1", offset: "0" });
  applyScopeParams(params);
  const key = `${state.source}|${state.schema}|${table}`;
  let columns = cache.get(key);
  if (!columns) {
    columns = api<TableData>(`/tables/data?${params}`).then((d) => d.columns);
    cache.set(key, columns);
    // A failed lookup must not be remembered.
    columns.catch(() => cache.delete(key));
  }
  return columns;
}
