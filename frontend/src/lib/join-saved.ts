// ==== Saved joins ====
// A named join is its canonical text, kept in the browser per source and
// schema (the same table names mean different tables in another schema). The
// server never sees them.

export interface SavedJoin {
  name: string;
  text: string;
}

export type SavedStore = Record<string, Record<string, SavedJoin[]>>;

export const MAX_SAVED_PER_SCOPE = 30;
export const MAX_SAVED_NAME = 60;
// The request bound of spec/protocol.md §5.11.1; longer text can never run.
export const MAX_SAVED_TEXT = 8192;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function sanitizeEntries(raw: unknown): SavedJoin[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SavedJoin[] = [];
  for (const e of raw) {
    if (!isPlainObject(e) || typeof e.name !== "string" || typeof e.text !== "string") continue;
    const name = e.name.trim();
    if (name === "" || name.length > MAX_SAVED_NAME || e.text.length > MAX_SAVED_TEXT || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, text: e.text });
    if (out.length === MAX_SAVED_PER_SCOPE) break;
  }
  return out;
}

// Anything that is not the expected shape is dropped, never repaired (ui-guidelines R5).
export function sanitizeSaved(raw: unknown): SavedStore {
  const store: SavedStore = {};
  if (!isPlainObject(raw)) return store;
  for (const [source, schemas] of Object.entries(raw)) {
    if (!isPlainObject(schemas)) continue;
    for (const [schema, entries] of Object.entries(schemas)) {
      const clean = sanitizeEntries(entries);
      if (clean.length === 0) continue;
      store[source] ??= {};
      store[source][schema] = clean;
    }
  }
  return store;
}

export function scopeEntries(store: SavedStore, source: string | null, schema: string | null): SavedJoin[] {
  return store[source ?? ""]?.[schema ?? ""] ?? [];
}

function withEntries(
  store: SavedStore,
  source: string | null,
  schema: string | null,
  entries: SavedJoin[],
): SavedStore {
  const next: SavedStore = { ...store, [source ?? ""]: { ...store[source ?? ""] } };
  if (entries.length) next[source ?? ""][schema ?? ""] = entries;
  else delete next[source ?? ""][schema ?? ""];
  return next;
}

// Saving under a name that exists replaces it; `replacing` renames an entry.
export function withSaved(
  store: SavedStore,
  source: string | null,
  schema: string | null,
  entry: SavedJoin,
  replacing?: string,
): { store: SavedStore } | { error: string } {
  const name = entry.name.trim();
  if (name === "") return { error: "Give the join a name to save it." };
  if (name.length > MAX_SAVED_NAME) return { error: `A name can be at most ${MAX_SAVED_NAME} characters.` };
  if (entry.text.length > MAX_SAVED_TEXT) return { error: "This join is too long to save." };
  const kept = scopeEntries(store, source, schema).filter((e) => e.name !== name && e.name !== replacing);
  if (kept.length >= MAX_SAVED_PER_SCOPE)
    return { error: `You can save at most ${MAX_SAVED_PER_SCOPE} joins here; delete one first.` };
  return { store: withEntries(store, source, schema, [...kept, { name, text: entry.text }]) };
}

export function withoutSaved(
  store: SavedStore,
  source: string | null,
  schema: string | null,
  name: string,
): SavedStore {
  return withEntries(
    store,
    source,
    schema,
    scopeEntries(store, source, schema).filter((e) => e.name !== name),
  );
}
