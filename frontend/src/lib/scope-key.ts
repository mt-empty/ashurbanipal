// The one key for anything remembered per source and schema. A JSON array, so
// no name (a quoted Postgres identifier may hold any character) can make two
// scopes collide.
export function scopeKey(source: string, schema: string, ...rest: string[]): string {
  return visitKey(source, schema, ...rest);
}

// The same encoding for per-visit keys, which may hold a name not resolved
// yet. Never stored: scopeKey's string parts keep a guessed scope out of storage.
export function visitKey(source: string | null, schema: string | null, ...rest: string[]): string {
  return JSON.stringify([source, schema, ...rest]);
}

// A stored key is trusted only when it parses back to `parts` strings.
export function isScopeKey(key: string, parts: number): boolean {
  try {
    const v: unknown = JSON.parse(key);
    return Array.isArray(v) && v.length === parts && v.every((s) => typeof s === "string");
  } catch {
    return false;
  }
}
