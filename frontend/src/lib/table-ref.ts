import type { SchemaRef, TableRef } from "../core/types.js";

// ==== Table references ====
// Every name a request, cache or link uses for a table is a TableRef, so the
// schema it lives in is always stated, never read from the current scope.

export function schemaRef(source: string | null, schema: string | null): SchemaRef {
  return { source, schema } as SchemaRef;
}

export function tableIn(scope: SchemaRef, table: string): TableRef {
  return { source: scope.source, schema: scope.schema, table } as TableRef;
}

// A name the wire gives relative to a table already held: an FK target to its
// column's table, a referrer to the viewed table, a join column to the
// request's scope. An absent schema means the owner's own.
export function near(owner: SchemaRef, schema: string | undefined, table: string): TableRef {
  return tableIn(schema === undefined ? owner : schemaRef(owner.source, schema), table);
}

// The one key for a table (and, with `rest`, something of it) within a visit.
// The JSON array of lib/scope-key.ts's visitKey, so no name can collide.
export function refKey(ref: TableRef, ...rest: string[]): string {
  return JSON.stringify([ref.source, ref.schema, ref.table, ...rest]);
}

export function distinctRefs(refs: readonly TableRef[]): TableRef[] {
  return [...new Map(refs.map((r) => [refKey(r), r])).values()];
}

// The source and schema a scoped request sends: only the names that are known.
export function scopeParams(scope: SchemaRef, params = new URLSearchParams()): URLSearchParams {
  if (scope.source) params.set("source", scope.source);
  if (scope.schema) params.set("schema", scope.schema);
  return params;
}

export function scopeQuery(scope: SchemaRef): string {
  const params = scopeParams(scope);
  return params.size ? `?${params}` : "";
}

export function tableParams(ref: TableRef, extra: Record<string, string> = {}): URLSearchParams {
  return scopeParams(ref, new URLSearchParams({ table: ref.table, ...extra }));
}
