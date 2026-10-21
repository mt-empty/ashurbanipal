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
// Keeps one entry from filling localStorage; whether a join fits the request is checked when it runs.
export const MAX_SAVED_TEXT = 32768;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// Source and schema names are host data. A null prototype and own-key reads keep
// one named `__proto__` or `constructor` from reaching Object.prototype.
const dict = <T>(from?: Record<string, T>): Record<string, T> => Object.assign(Object.create(null), from);
const own = <T>(o: Record<string, T> | undefined, key: string): T | undefined =>
  o && Object.hasOwn(o, key) ? o[key] : undefined;

function sanitizeEntries(raw: unknown): SavedJoin[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SavedJoin[] = [];
  for (const e of raw) {
    if (!isPlainObject(e) || typeof e.name !== "string" || typeof e.text !== "string") continue;
    const name = e.name.trim();
    if (name === "" || name.length > MAX_SAVED_NAME || e.text.length > MAX_SAVED_TEXT) continue;
    if (seen.has(name) || seen.has(`\0${e.text}`)) continue;
    seen.add(name);
    seen.add(`\0${e.text}`);
    out.push({ name, text: e.text });
    if (out.length === MAX_SAVED_PER_SCOPE) break;
  }
  return out;
}

// Anything that is not the expected shape is dropped, never repaired (ui-guidelines R5).
export function sanitizeSaved(raw: unknown): SavedStore {
  const store: SavedStore = dict();
  if (!isPlainObject(raw)) return store;
  for (const [source, schemas] of Object.entries(raw)) {
    if (!isPlainObject(schemas)) continue;
    for (const [schema, entries] of Object.entries(schemas)) {
      const clean = sanitizeEntries(entries);
      if (clean.length === 0) continue;
      store[source] ??= dict();
      store[source][schema] = clean;
    }
  }
  return store;
}

export function scopeEntries(store: SavedStore, source: string | null, schema: string | null): SavedJoin[] {
  return own(own(store, source ?? ""), schema ?? "") ?? [];
}

function withEntries(
  store: SavedStore,
  source: string | null,
  schema: string | null,
  entries: SavedJoin[],
): SavedStore {
  const next = dict(store);
  const schemas = dict(own(store, source ?? ""));
  next[source ?? ""] = schemas;
  if (entries.length) schemas[schema ?? ""] = entries;
  else delete schemas[schema ?? ""];
  return next;
}

// One entry per name and per join: saving under a name that exists replaces it,
// and saving a join already saved, or `replacing`, renames that entry in place.
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
  const entries = scopeEntries(store, source, schema);
  const same = (e: SavedJoin): boolean => e.name === name || e.name === replacing || e.text === entry.text;
  const kept = entries.filter((e) => !same(e));
  if (kept.length >= MAX_SAVED_PER_SCOPE)
    return { error: `You can save at most ${MAX_SAVED_PER_SCOPE} joins here; delete one first.` };
  // Every entry before the first one replaced is kept, so its index is the place in `kept` too.
  const at = entries.findIndex(same);
  kept.splice(at < 0 ? kept.length : at, 0, { name, text: entry.text });
  return { store: withEntries(store, source, schema, kept) };
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
