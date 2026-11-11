import { ApiError, api } from "../core/api.js";
import { noCountsFor, refFor, refInScope, schemaRefFor, state } from "../core/state.js";
import type { Column, CountsResponse, SchemaRef, TableListEntry, TableRef, ViewData } from "../core/types.js";
import { formatApproxCount } from "../lib/format.js";
import type { JoinCatalog } from "../lib/join-dsl.js";
import { refKey, scopeQuery, tableParams } from "../lib/table-ref.js";
import { tableStructure } from "./structure.js";
import { listedTableNames, tableChipCount } from "./table-chips.js";

// The page learns a table's columns (names, types, keys) from the first row of
// its data; the table listing carries only names. Cached per table, failures
// included, until Refresh: a table the role cannot read is not asked for again
// on every keystroke.
const cache = new Map<string, Promise<Column[]>>();
const resolved = new Map<string, Column[]>();
const indexes = new Map<string, Promise<Set<string>>>();
const indexesRead = new Map<string, Set<string>>();
// Another schema's table names and their approximate counts, keyed by its scope query.
const schemaTables = new Map<string, Promise<void>>();
const schemaTablesRead = new Map<string, { name: string; count: string }[]>();
const schemaTablesFailed = new Map<string, string>();
let generation = 0;
let version = 0;

export function clearJoinCatalog(): void {
  cache.clear();
  resolved.clear();
  indexes.clear();
  indexesRead.clear();
  schemaTables.clear();
  schemaTablesRead.clear();
  schemaTablesFailed.clear();
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

// The tables of `scope`, a schema other than the current one, for the join
// builder's pickers. Read once until Refresh, failures included, so typing never repeats a refused read.
export function tablesIn(scope: SchemaRef): Promise<void> {
  const key = scopeQuery(scope);
  let read = schemaTables.get(key);
  if (!read) {
    const started = generation;
    const noCounts = noCountsFor(scope.source);
    read = Promise.all([
      api<{ tables: TableListEntry[] }>(`/tables${key}`),
      noCounts
        ? { counts: [] }
        : api<CountsResponse>(`/table-counts${key}`).catch((): CountsResponse => ({ counts: [] })),
    ]).then(([{ tables }, { counts }]) => {
      if (started !== generation) return;
      const countOf = new Map(counts.map((c) => [c.table, c.approx_rows]));
      schemaTablesRead.set(
        key,
        tables.map((t) => ({ name: t.name, count: noCounts ? "" : formatApproxCount(countOf.get(t.name)) })),
      );
      version++;
    });
    schemaTables.set(key, read);
    read.catch((e: unknown) => {
      if (started !== generation) return;
      schemaTablesFailed.set(key, e instanceof Error ? e.message : String(e));
      console.warn("ashurbanipal: the join builder could not list a schema's tables", e);
      version++;
    });
  }
  return read;
}

// Why `schema`'s tables could not be listed, once a read failed.
export function tablesInFailure(schema: string): string | undefined {
  return schemaTablesFailed.get(scopeQuery(schemaRefFor(schema)));
}

// The tables of `schema` once read: the scope's own (absent, or named) from its
// chips, another's from tablesIn().
export function cachedTablesIn(schema: string | undefined): { name: string; count: string }[] | undefined {
  if (schema === undefined || schema === state.scope.schema)
    return listedTableNames().map((name) => ({ name, count: tableChipCount(name) }));
  return schemaTablesRead.get(scopeQuery(schemaRefFor(schema)));
}

// Every listed schema for `schema.table` names, with the tables and columns read
// so far: the scope's own is `own`. Undefined while the list is unknown, so
// nothing is rejected.
export function knownSchemas(own: JoinCatalog): Record<string, JoinCatalog | null> | undefined {
  if (state.schemas.length === 0) return undefined;
  const catalogOf = (schema: string): JoinCatalog | null => {
    if (schema === state.scope.schema) return own;
    const tables = cachedTablesIn(schema);
    if (!tables) return null;
    return Object.fromEntries(
      tables.map((t) => [t.name, cachedColumns(refFor({ schema, table: t.name }))?.map((c) => c.name) ?? null]),
    );
  };
  return Object.fromEntries(state.schemas.map((s) => [s, catalogOf(s)]));
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
