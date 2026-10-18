import { getAppliedJoin, state } from "../core/state.js";
import { joinLabel } from "../lib/join-def.js";
import {
  type SavedJoin,
  type SavedStore,
  sanitizeSaved,
  scopeEntries,
  withoutSaved,
  withSaved,
} from "../lib/join-saved.js";
import { type JoinChip, setJoinChips } from "./sidebar.js";

// Saved joins live in their own localStorage key, outside the view blob: they
// are the user's own list, grouped by source and schema, and the server never
// sees them. Text is canonical, so equal joins compare equal as strings.
const SAVED_KEY = "ashurbanipal_joins";

// Read once and kept until this page writes or another tab does.
let stored: SavedStore | null = null;
window.addEventListener("storage", (e) => {
  if (e.key === SAVED_KEY || e.key === null) stored = null;
});

function read(): SavedStore {
  if (stored) return stored;
  try {
    stored = sanitizeSaved(JSON.parse(localStorage.getItem(SAVED_KEY) || "{}"));
  } catch (e) {
    console.warn("ashurbanipal: discarding unreadable saved joins", e);
    stored = {};
  }
  return stored;
}

function write(store: SavedStore): boolean {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(store));
    stored = store;
    return true;
  } catch (e) {
    console.warn("ashurbanipal: could not save joins", e);
    return false;
  }
}

export function savedJoins(): SavedJoin[] {
  return scopeEntries(read(), state.source, state.schema);
}

// The saved entry for the join in view, if it was saved.
export function savedJoinInView(): SavedJoin | undefined {
  return state.join === "" ? undefined : savedJoins().find((s) => s.text === state.join);
}

export function saveJoin(name: string, text: string, replacing?: string): string | null {
  const result = withSaved(read(), state.source, state.schema, { name, text }, replacing);
  if ("error" in result) return result.error;
  return write(result.store) ? null : "This browser would not store the join.";
}

export function deleteSavedJoin(name: string): void {
  write(withoutSaved(read(), state.source, state.schema, name));
}

interface ChipActions {
  open: (text: string) => void;
  edit: () => void;
  startNew: () => void;
  saveCurrent: () => void;
}

// What the chips were last built from; every data load asks, and most change nothing.
let lastRendered = "";

// The chips after the table chips: saved joins, the unsaved join in view, `+ new join`.
export function renderSavedChips(actions: ChipActions): void {
  const saved = savedJoins();
  const key = JSON.stringify([state.source, state.schema, state.join, saved]);
  if (key === lastRendered) return;
  lastRendered = key;
  const current = getAppliedJoin();
  const inSaved = saved.some((s) => s.text === state.join);
  // The chip of the join in view opens it for editing, which is also where it is renamed or deleted.
  const chips: JoinChip[] = saved.map((s) => {
    const active = s.text === state.join;
    return {
      label: `⋈ ${s.name}`,
      title: active ? `${s.name}: click to edit, rename or delete` : `${s.name} — ${s.text.replaceAll("\n", " ")}`,
      className: "saved",
      active,
      run: active ? actions.edit : () => actions.open(s.text),
    };
  });
  if (current && !inSaved) {
    chips.push({
      label: `⋈ ${joinLabel(current)}`,
      title: "this join is not saved",
      className: "unsaved",
      active: true,
      run: () => {},
    });
    chips.push({
      label: "Save…",
      title: "name this join and keep it in this browser",
      className: "save-link muted",
      active: false,
      run: actions.saveCurrent,
    });
  }
  chips.push({
    label: "+ new join",
    title: "build a join from the table in view",
    className: "new-join muted",
    active: false,
    run: actions.startNew,
  });
  setJoinChips(chips);
}
