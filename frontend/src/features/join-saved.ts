import { $ } from "../core/dom.js";
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

// Saved joins live in their own localStorage key, outside the view blob: they
// are the user's own list, grouped by source and schema, and the server never
// sees them. Text is canonical, so equal joins compare equal as strings.
const SAVED_KEY = "ashurbanipal_joins";

function read(): SavedStore {
  try {
    return sanitizeSaved(JSON.parse(localStorage.getItem(SAVED_KEY) || "{}"));
  } catch (e) {
    console.warn("ashurbanipal: discarding unreadable saved joins", e);
    return {};
  }
}

function write(store: SavedStore): boolean {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(store));
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
  startNew: () => void;
  saveCurrent: () => void;
}

function chip(
  label: string,
  opts: { className?: string; title?: string; active?: boolean; run: () => void },
): HTMLLIElement {
  const li = document.createElement("li");
  if (opts.className) li.className = opts.className;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.title = opts.title ?? label;
  if (opts.active) {
    btn.classList.add("active");
    btn.setAttribute("aria-current", "true");
  }
  btn.onclick = opts.run;
  li.appendChild(btn);
  return li;
}

// The chips after the table chips: saved joins, the unsaved join in view, `+ new join`.
export function renderSavedChips(actions: ChipActions): void {
  const saved = savedJoins();
  const current = getAppliedJoin();
  const inSaved = saved.some((s) => s.text === state.join);
  const items = saved.map((s) =>
    chip(s.name, {
      title: `${s.name} — ${s.text.replaceAll("\n", " ")}`,
      active: s.text === state.join,
      run: () => actions.open(s.text),
    }),
  );
  if (current && !inSaved) {
    items.push(
      chip(`⋈ ${joinLabel(current)}`, {
        className: "unsaved",
        title: "this join is not saved",
        active: true,
        run: () => {},
      }),
    );
    items.push(
      chip("Save…", {
        className: "save-link",
        title: "name this join and keep it in this browser",
        run: actions.saveCurrent,
      }),
    );
  }
  items.push(
    chip("+ new join", { className: "new-join", title: "build a join from the table in view", run: actions.startNew }),
  );
  $("saved-joins").replaceChildren(...items);
  // Nothing to show before the first table is in view.
  $("saved-joins-bar").hidden = state.table === null;
}
