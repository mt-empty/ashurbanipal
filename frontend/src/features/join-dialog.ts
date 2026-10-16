import { loadData } from "../bootstrap/reload.js";
import { $, copyText, reportError } from "../core/dom.js";
import { clearFilter, getAppliedJoin, persist, setAppliedJoin, state } from "../core/state.js";
import type { JoinDef } from "../core/types.js";
import { defToDraft, draftToDef, newDraft } from "../lib/join-draft.js";
import { parseJoin, printJoin } from "../lib/join-dsl.js";
import { mountJoinForm } from "./join-form.js";
import { deleteSavedJoin, renderSavedChips, savedJoinInView, saveJoin } from "./join-saved.js";
import { draftText, mountJoinSql } from "./join-sql.js";

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
const sql = mountJoinSql(onSqlChange);
const formRadio = $<HTMLInputElement>("join-mode-form");
const sqlRadio = $<HTMLInputElement>("join-mode-sql");

function setMode(mode: "form" | "sql"): void {
  formRadio.checked = mode === "form";
  sqlRadio.checked = mode === "sql";
  $("join-form").hidden = mode !== "form";
  $("join-preview-wrap").hidden = mode !== "form";
  $("join-sql-pane").hidden = mode !== "sql";
  $("join-error").textContent = "";
}

function sqlProblem(): string {
  const result = sql.text().trim() ? sql.parse() : null;
  return result && "error" in result
    ? `line ${result.error.line}, column ${result.error.column}: ${result.error.message}`
    : "";
}

// SQL → Form only works while the text parses; the message says where it does not.
function onSqlChange(): void {
  const problem = sqlProblem();
  $("join-sql-error").textContent = problem;
  formRadio.disabled = problem !== "";
  $("join-error").textContent = "";
}

// The name of the saved join being edited, so a new name renames it.
let editingSaved: string | undefined;

// `fresh` starts from the table in view even inside a join view; `focusName`
// is the `Save…` chip, which only wants the name field.
export function openJoinDialog(opts: { error?: string; fresh?: boolean; focusName?: boolean } = {}): void {
  const def = opts.fresh ? null : getAppliedJoin();
  const saved = opts.fresh ? undefined : savedJoinInView();
  editingSaved = saved?.name;
  $<HTMLInputElement>("join-name").value = saved?.name ?? "";
  $("join-delete").hidden = saved === undefined;
  form.setDraft(def ? defToDraft(def) : newDraft(state.table ?? ""));
  setMode("form");
  formRadio.disabled = false;
  $("join-sql-error").textContent = "";
  updatePreview();
  $("join-error").textContent = opts.error ?? "";
  if (!dialog.open) dialog.showModal();
  if (opts.focusName) $<HTMLInputElement>("join-name").focus();
}

// A saved join is canonical text; a name the page cannot parse again is a bug to show, not hide.
function openSaved(text: string): void {
  const parsed = parseJoin(text);
  if ("error" in parsed) reportError(new Error(`saved join: ${parsed.error.message}`));
  else applyJoin(parsed.def);
}

export function refreshSavedChips(): void {
  renderSavedChips({
    open: openSaved,
    startNew: () => openJoinDialog({ fresh: true }),
    saveCurrent: () => openJoinDialog({ focusName: true }),
  });
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
  const result = sqlRadio.checked ? sql.parse() : draftToDef(form.draft());
  if ("error" in result) {
    $("join-error").textContent = typeof result.error === "string" ? result.error : sqlProblem();
    return;
  }
  const name = $<HTMLInputElement>("join-name").value.trim();
  if (name !== "") {
    const problem = saveJoin(name, printJoin(result.def), editingSaved);
    if (problem) {
      $("join-error").textContent = problem;
      return;
    }
  }
  dialog.close();
  applyJoin(result.def);
};
$("join-delete").onclick = () => {
  if (editingSaved !== undefined) deleteSavedJoin(editingSaved);
  dialog.close();
  refreshSavedChips();
};
$("join-link-btn").onclick = () => copyText(location.href, $("join-link-btn"));
formRadio.onchange = () => {
  if (!formRadio.checked) return;
  const parsed = sql.text().trim() ? sql.parse() : null;
  if (parsed && "error" in parsed) return;
  form.setDraft(parsed ? defToDraft(parsed.def) : newDraft(state.table ?? ""));
  setMode("form");
  updatePreview();
};
sqlRadio.onchange = () => {
  if (!sqlRadio.checked) return;
  sql.setText(draftText(form.draft()));
  setMode("sql");
  onSqlChange();
  $<HTMLTextAreaElement>("join-sql").focus();
};
$("join-cancel").onclick = () => dialog.close();
$("join-btn").onclick = () => openJoinDialog();
$("join-edit-btn").onclick = () => openJoinDialog();
