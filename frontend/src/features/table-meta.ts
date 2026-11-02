import { scopeIdentity } from "../core/state.js";
import type { ConstraintFk, ReferencedByEntry, StructureResponse } from "../core/types.js";
import { fetchReferencedBy } from "./referenced-by.js";
import { tableStructure } from "./structure.js";

// ---- per-table catalog facts the grid needs beyond §5.4.1's columns:
// incoming references (§5.9) and composite FKs / unique columns (§5.10).
// Fetched after a table view renders; the grid draws without them until
// they arrive, then once more. ----

export interface TableMeta {
  // Distinct tables with an FK into this one; null when the lookup failed.
  referrers: number | null;
  // Multi-column FKs, which §5.4.1 omits from `references`; keyed by member column.
  compositeFkOf: Map<string, ConstraintFk>;
  // Columns unique on their own, by constraint or full (non-partial) index.
  uniqueColumns: Set<string>;
}

// Kept across a refresh until the new answer lands, so the grid's links
// don't flicker off and back on.
const metas = new Map<string, { meta: TableMeta; shape: string }>();

export function tableMeta(table: string): TableMeta | undefined {
  return metas.get(scopeIdentity(table))?.meta;
}

function referrerCount(entries: ReferencedByEntry[]): number {
  return new Set(entries.map((e) => `${e.schema ?? ""}.${e.table}`)).size;
}

function buildMeta(structure: StructureResponse | null, entries: ReferencedByEntry[] | null): TableMeta {
  const compositeFkOf = new Map<string, ConstraintFk>();
  const uniqueColumns = new Set<string>();
  if (structure) {
    for (const fk of structure.constraints.foreign_keys) {
      if (fk.columns.length < 2) continue;
      for (const pair of fk.columns) if (!compositeFkOf.has(pair.from)) compositeFkOf.set(pair.from, fk);
    }
    for (const u of structure.constraints.unique) if (u.columns.length === 1) uniqueColumns.add(u.columns[0]);
    for (const i of structure.indexes)
      if (i.unique && !i.predicate && i.columns.length === 1) uniqueColumns.add(i.columns[0]);
  }
  return { referrers: entries ? referrerCount(entries) : null, compositeFkOf, uniqueColumns };
}

// Resolves true when the stored facts changed, so the caller redraws.
export async function loadTableMeta(table: string): Promise<boolean> {
  const key = scopeIdentity(table);
  const [structure, entries] = await Promise.allSettled([tableStructure(table), fetchReferencedBy(table)]);
  const failed = [structure, entries].filter((r) => r.status === "rejected");
  for (const r of failed) console.warn("ashurbanipal: table metadata lookup failed", r.reason);
  // A failed refresh keeps the last good answer.
  if (failed.length > 0 && metas.has(key)) return false;
  const meta = buildMeta(
    structure.status === "fulfilled" ? structure.value : null,
    entries.status === "fulfilled" ? entries.value : null,
  );
  const shape = JSON.stringify([meta.referrers, [...meta.compositeFkOf], [...meta.uniqueColumns]]);
  if (metas.get(key)?.shape === shape) return false;
  metas.set(key, { meta, shape });
  return true;
}
