import type { JoinDef, JoinTable, WireJoin } from "../core/types.js";

// ==== Join definition helpers (wire request, labels) ====

// `orders ⟕ users o` style one-line summary for the meta row and the chips.
export function joinLabel(def: JoinDef): string {
  const ref = (t: JoinTable): string => (t.alias === null ? t.table : `${t.table} ${t.alias}`);
  return def.tables
    .map((t, i) => (i === 0 ? ref(t) : `${def.joins[i - 1].type === "left" ? "⟕" : "⋈"} ${ref(t)}`))
    .join(" ");
}

// Positions whose `alias.*` has to be expanded to column names for the request:
// the wire has no "all of this table" form, only a whole-list omission.
export function tablesToExpand(def: JoinDef): number[] {
  if (def.columns === null || def.columns.every((c) => "all" in c)) return [];
  return [...new Set(def.columns.filter((c) => "all" in c).map((c) => c.join))];
}

// `columnsOf` must answer for every position in tablesToExpand(def).
export function toWire(def: JoinDef, columnsOf: (join: number) => readonly string[]): WireJoin {
  const wire: WireJoin = {
    table: def.tables[0].table,
    joins: def.joins.map((j, i) => ({ type: j.type, table: def.tables[i + 1].table, on: j.on })),
  };
  if (def.columns !== null && !def.columns.every((c) => "all" in c)) {
    wire.columns = def.columns.flatMap((c) =>
      "all" in c ? columnsOf(c.join).map((column) => ({ join: c.join, column })) : [c],
    );
  }
  return wire;
}
