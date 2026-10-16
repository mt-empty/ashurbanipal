import { loadData } from "../bootstrap/reload.js";
import { $ } from "../core/dom.js";
import { clearFilter, getAppliedJoin, persist, setAppliedJoin, state } from "../core/state.js";
import type { JoinDef } from "../core/types.js";
import { defToDraft, draftToDef, newDraft } from "../lib/join-draft.js";
import { printJoin } from "../lib/join-dsl.js";
import { mountJoinForm } from "./join-form.js";

// The join overlay: one JoinDef edited in a form (the SQL text mode builds on
// the same dialog). Show result applies it and closes; the server's answer to a
// bad join comes back through openJoinDialog's `error`.
const dialog = $<HTMLDialogElement>("join-dialog");

function updatePreview(): void {
  const result = draftToDef(form.draft());
  $("join-preview").textContent = "def" in result ? printJoin(result.def) : result.error;
  $("join-error").textContent = "";
}

const form = mountJoinForm($("join-form"), updatePreview);

export function openJoinDialog(opts: { error?: string } = {}): void {
  const def = getAppliedJoin();
  form.setDraft(def ? defToDraft(def) : newDraft(state.table ?? ""));
  updatePreview();
  $("join-error").textContent = opts.error ?? "";
  if (!dialog.open) dialog.showModal();
}

// A new join starts from the default view: the sort and filter were written
// against other columns, and the first page is the place to look.
export function applyJoin(def: JoinDef): void {
  setAppliedJoin(def);
  state.sort = null;
  state.order = "asc";
  state.offset = 0;
  clearFilter();
  persist();
  loadData();
}

$("join-run").onclick = () => {
  const result = draftToDef(form.draft());
  if ("error" in result) {
    $("join-error").textContent = result.error;
    return;
  }
  dialog.close();
  applyJoin(result.def);
};
$("join-cancel").onclick = () => dialog.close();
$("join-btn").onclick = () => openJoinDialog();
$("join-edit-btn").onclick = () => openJoinDialog();
