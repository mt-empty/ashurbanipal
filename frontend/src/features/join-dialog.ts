import { loadData } from "../bootstrap/reload.js";
import { $ } from "../core/dom.js";
import { clearFilter, getAppliedJoin, persist, setAppliedJoin, state } from "../core/state.js";
import type { JoinDef } from "../core/types.js";
import { defToDraft, draftToDef, newDraft } from "../lib/join-draft.js";
import { printJoin } from "../lib/join-dsl.js";
import { mountJoinForm } from "./join-form.js";
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

export function openJoinDialog(opts: { error?: string } = {}): void {
  const def = getAppliedJoin();
  form.setDraft(def ? defToDraft(def) : newDraft(state.table ?? ""));
  setMode("form");
  formRadio.disabled = false;
  $("join-sql-error").textContent = "";
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
  const result = sqlRadio.checked ? sql.parse() : draftToDef(form.draft());
  if ("error" in result) {
    $("join-error").textContent = typeof result.error === "string" ? result.error : sqlProblem();
    return;
  }
  dialog.close();
  applyJoin(result.def);
};
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
