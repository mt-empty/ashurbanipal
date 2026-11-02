import type { Column, ConstraintFk } from "../core/types.js";

export interface KeyDescription {
  icon: string;
  label: string;
}

export function fkTarget(ref: { table: string; schema?: string }): string {
  return ref.schema ? `${ref.schema}.${ref.table}` : ref.table;
}

// A column can be its own table's PK and an FK at once (1:1 detail table
// shape): key still reports "pk", but references is populated too
// (spec/protocol.md §5.4.1), so the label surfaces both facts.
export function keyDescription(col: Column, compositeFk?: ConstraintFk): KeyDescription | null {
  const composite =
    compositeFk &&
    `part of foreign key (${compositeFk.columns.map((c) => c.from).join(", ")}) → ` +
      `${fkTarget(compositeFk)}(${compositeFk.columns.map((c) => c.to).join(", ")})`;
  if (col.key === "pk") {
    const also = col.references
      ? `, also references ${fkTarget(col.references)}.${col.references.column}`
      : composite
        ? `, also ${composite}`
        : "";
    return { icon: "🔑", label: `primary key${also}` };
  }
  if (col.references) {
    return { icon: "🔗", label: `foreign key, references ${fkTarget(col.references)}.${col.references.column}` };
  }
  return composite ? { icon: "🔗", label: composite } : null;
}
