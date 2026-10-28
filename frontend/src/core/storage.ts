// Best-effort localStorage: access throws where site data is blocked, and a
// write throws at the quota. A caller must never be aborted by either.

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// null removes the key. A value that grows (a JSON blob) can hit the quota, so
// its caller passes `failure` to get a warning, not a silent loss.
export function writeStored(key: string, value: string | null, failure?: string): boolean {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch (e) {
    if (failure) console.warn(failure, e);
    return false;
  }
}

// Keys whose entries were written under an older scope shape. They are
// dropped, never migrated.
const RETIRED_KEYS = ["ashurbanipal_ui", "ashurbanipal_joins"];

export function dropRetiredKeys(): void {
  for (const key of RETIRED_KEYS) writeStored(key, null);
}
