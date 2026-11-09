import type { JoinDef, JoinTable, WireJoin } from "../core/types.js";

// ==== Join definition helpers (wire request, labels) ====

// The schema each table of a join is labelled with. A join within one schema
// names none; one that spans schemas names every table's, the scope's for a
// table the canonical definition leaves unqualified.
export function labelSchemas(def: JoinDef, scopeSchema: string | null): (string | undefined)[] {
  if (scopeSchema === null || def.tables.every((t) => t.schema === undefined)) return def.tables.map((t) => t.schema);
  return def.tables.map((t) => t.schema ?? scopeSchema);
}

// One table of a join as the label, bands, menu headings and record groups name it.
export function tableLabel(t: JoinTable, schema: string | undefined): string {
  const name = schema === undefined ? t.table : `${schema}.${t.table}`;
  return t.alias === null ? name : `${name} ${t.alias}`;
}

// `orders ⟕ users o` style one-line summary for the meta row and the chips.
export function joinLabel(def: JoinDef, scopeSchema: string | null): string {
  const schemas = labelSchemas(def, scopeSchema);
  return def.tables
    .map((t, i) => {
      const label = tableLabel(t, schemas[i]);
      return i === 0 ? label : `${def.joins[i - 1].type === "left" ? "⟕" : "⋈"} ${label}`;
    })
    .join(" ");
}

// The wire has no "all of this table" form, only a whole-list omission, which
// the server answers in table order: right only for every `alias.*` in that order.
function selectsEverything(def: JoinDef): boolean {
  if (def.columns === null) return true;
  return def.columns.length === def.tables.length && def.columns.every((c, i) => "all" in c && c.join === i);
}

// Positions whose `alias.*` has to be expanded to column names for the request.
export function tablesToExpand(def: JoinDef): number[] {
  if (selectsEverything(def)) return [];
  return [...new Set((def.columns ?? []).filter((c) => "all" in c).map((c) => c.join))];
}

// `columnsOf` must answer for every position in tablesToExpand(def).
export function toWire(def: JoinDef, columnsOf: (join: number) => readonly string[]): WireJoin {
  const schemaOf = (t: JoinTable): { schema?: string } => (t.schema === undefined ? {} : { schema: t.schema });
  const wire: WireJoin = {
    table: def.tables[0].table,
    ...schemaOf(def.tables[0]),
    joins: def.joins.map((j, i) => ({
      type: j.type,
      table: def.tables[i + 1].table,
      ...schemaOf(def.tables[i + 1]),
      on: j.on,
    })),
  };
  if (def.columns !== null && !selectsEverything(def)) {
    wire.columns = def.columns.flatMap((c) =>
      "all" in c ? columnsOf(c.join).map((column) => ({ join: c.join, column })) : [c],
    );
  }
  return wire;
}

// The canonical definition for a scope: a schema the text names that is the
// scope's own is dropped, so the same join prints, compares and keys the same
// whether or not it was written qualified.
export function dropScopeSchema(def: JoinDef, scopeSchema: string | null): JoinDef {
  if (scopeSchema === null || def.tables.every((t) => t.schema !== scopeSchema)) return def;
  return {
    ...def,
    tables: def.tables.map((t) => (t.schema === scopeSchema ? { table: t.table, alias: t.alias } : t)),
  };
}
