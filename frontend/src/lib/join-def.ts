import type { JoinDef, JoinTable, WireJoin } from "../core/types.js";

// ==== Join definition helpers (wire request, labels) ====

// One table of a join as the label, bands, menu headings and record groups name it.
export function tableLabel(t: JoinTable): string {
  return t.alias === null ? t.table : `${t.table} ${t.alias}`;
}

// `orders ⟕ users o` style one-line summary for the meta row and the chips.
export function joinLabel(def: JoinDef): string {
  return def.tables
    .map((t, i) => (i === 0 ? tableLabel(t) : `${def.joins[i - 1].type === "left" ? "⟕" : "⋈"} ${tableLabel(t)}`))
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
