import { reportError } from "../core/dom.js";
import { joinInView, state, viewHref } from "../core/state.js";
import { readStored, writeStored } from "../core/storage.js";
import type { JoinDef } from "../core/types.js";
import { joinLabel } from "../lib/join-def.js";
import { parseJoin } from "../lib/join-dsl.js";
import {
  type SavedJoin,
  type SavedStore,
  sanitizeSaved,
  scopeEntries,
  withoutSaved,
  withSaved,
} from "../lib/join-saved.js";
import { hasJoinChips, type JoinChip, setJoinChips } from "./table-chips.js";

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
    stored = sanitizeSaved(JSON.parse(readStored(SAVED_KEY) || "{}"));
  } catch (e) {
    console.warn("ashurbanipal: discarding unreadable saved joins", e);
    stored = {};
  }
  return stored;
}

function write(store: SavedStore): boolean {
  if (!writeStored(SAVED_KEY, JSON.stringify(store), "ashurbanipal: could not save joins")) return false;
  stored = store;
  return true;
}

export function savedJoins(): SavedJoin[] {
  return scopeEntries(read(), state.source, state.schema);
}

export function savedJoinFor(text: string): SavedJoin | undefined {
  return savedJoins().find((s) => s.text === text);
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
  open: (def: JoinDef) => void;
  edit: () => void;
  startNew: () => void;
  saveCurrent: () => void;
}

// What the chips were last built from; every data load asks, and most change nothing.
let lastRendered = "";

// The chips after the table chips: saved joins, the unsaved join in view, `+ new join`.
export function renderSavedChips(actions: ChipActions): void {
  const saved = savedJoins();
  const current = joinInView();
  const key = JSON.stringify([state.source, state.schema, current?.text, saved]);
  // The table list drops chips built for another scope, so a match with none shown still rebuilds.
  if (key === lastRendered && hasJoinChips()) return;
  lastRendered = key;
  const inSaved = saved.some((s) => s.text === current?.text);
  // The chip of the join in view opens it for editing, which is also where it is renamed or deleted.
  const chips: JoinChip[] = saved.map((s) => {
    const active = s.text === current?.text;
    const label = `⋈ ${s.name}`;
    if (active)
      return {
        label,
        title: `${s.name}: click to edit, rename or delete`,
        className: "saved",
        active,
        run: actions.edit,
      };
    const chip = { label, title: `${s.name} — ${s.text.replaceAll("\n", " ")}`, className: "saved", active };
    // A saved join is canonical text; one the page cannot parse again is a bug to show, not hide.
    const parsed = parseJoin(s.text);
    if ("error" in parsed) return { ...chip, run: () => reportError(new Error(`saved join: ${parsed.error.message}`)) };
    const { def } = parsed;
    return { ...chip, run: () => actions.open(def), href: viewHref({ kind: "join", def, text: s.text, hidden: [] }) };
  });
  if (current && !inSaved) {
    chips.push({
      label: `⋈ ${joinLabel(current.def)}`,
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
