import type { Column, ConstraintFk } from "../core/types.js";

export interface KeyDescription {
  icon: string;
  label: string;
}

export function fkTarget(ref: { table: string; schema?: string }): string {
  return ref.schema ? `${ref.schema}.${ref.table}` : ref.table;
}

// The column a single-column foreign key points at, as `table.column`.
export function refTarget(ref: { table: string; schema?: string; column: string }): string {
  return `${fkTarget(ref)}.${ref.column}`;
}

export function compositeLabel(fk: ConstraintFk): string {
  const from = fk.columns.map((c) => c.from).join(", ");
  const to = fk.columns.map((c) => c.to).join(", ");
  return `part of foreign key (${from}) → ${fkTarget(fk)}(${to})`;
}

// A column can be its own table's PK and an FK at once (1:1 detail table
// shape): key still reports "pk", but references is populated too
// (spec/protocol.md §5.4.1), so the label surfaces both facts.
export function keyDescription(col: Column, compositeFk?: ConstraintFk): KeyDescription | null {
  const composite = compositeFk && compositeLabel(compositeFk);
  if (col.key === "pk") {
    const also = col.references
      ? `, also references ${refTarget(col.references)}`
      : composite
        ? `, also ${composite}`
        : "";
    return { icon: "🔑", label: `primary key${also}` };
  }
  if (col.references) {
    return { icon: "🔗", label: `foreign key, references ${refTarget(col.references)}` };
  }
  return composite ? { icon: "🔗", label: composite } : null;
}
