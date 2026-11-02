import { el } from "../core/dom.js";
import { scopeIdentity } from "../core/state.js";
import type { Column, ConstraintFk, ReferencedByEntry, StructureResponse } from "../core/types.js";
import { type KeyDescription, keyDescription } from "../lib/column-key.js";
import { fetchReferencedBy } from "./referenced-by.js";
import { tableStructure } from "./structure.js";

// ---- per-table catalog facts beyond §5.4.1's columns: incoming references
// (§5.9) and composite FKs / unique columns (§5.10). ----

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

export function tableMeta(table: string | null): TableMeta | undefined {
  return table === null ? undefined : metas.get(scopeIdentity(table))?.meta;
}

// A column's key icon; null keeps an empty slot so names line up. Decorative:
// callers put the key's text in a title or label.
export function keyIcon(key: KeyDescription | null): HTMLElement {
  const icon = el("span", "key-icon", key?.icon ?? "");
  icon.setAttribute("aria-hidden", "true");
  if (key) icon.title = key.label;
  return icon;
}

export function columnKeyOf(col: Column, meta: TableMeta | undefined): KeyDescription | null {
  return keyDescription(col, meta?.compositeFkOf.get(col.name));
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

// One lookup per table since the last refresh, failures included: a load that
// replaces another waits on the same lookup, and an auto-refresh tick never
// repeats one that keeps failing.
const loads = new Map<string, Promise<void>>();

export function expireTableMeta(): void {
  loads.clear();
}

// Never rejects. tableMeta()'s answer changes identity only when the facts do.
export function loadTableMeta(table: string): Promise<void> {
  const key = scopeIdentity(table);
  let load = loads.get(key);
  if (!load) {
    // A lookup from before a refresh must not overwrite the newer answer.
    load = fetchTableMeta(table, key, () => loads.get(key) === load);
    loads.set(key, load);
  }
  return load;
}

async function fetchTableMeta(table: string, key: string, current: () => boolean): Promise<void> {
  const [structure, entries] = await Promise.allSettled([tableStructure(table), fetchReferencedBy(table)]);
  if (!current()) return;
  const failed = [structure, entries].filter((r) => r.status === "rejected");
  for (const r of failed) console.warn("ashurbanipal: table metadata lookup failed", r.reason);
  // A failed refresh keeps the last good answer.
  if (failed.length > 0 && metas.has(key)) return;
  const meta = buildMeta(
    structure.status === "fulfilled" ? structure.value : null,
    entries.status === "fulfilled" ? entries.value : null,
  );
  const shape = JSON.stringify([meta.referrers, [...meta.compositeFkOf], [...meta.uniqueColumns]]);
  if (metas.get(key)?.shape !== shape) metas.set(key, { meta, shape });
}
