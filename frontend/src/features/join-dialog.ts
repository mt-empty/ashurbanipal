import { loadData } from "../bootstrap/reload.js";
import { $, copyText, el } from "../core/dom.js";
import { clearJoin, joinInView, joinRequest, persist, startTable, state, viewIsShown } from "../core/state.js";
import type { JoinDef } from "../core/types.js";
import { type Draft, defToDraft, draftToDef, newDraft } from "../lib/join-draft.js";
import { printJoin } from "../lib/join-dsl.js";
import { tokenizeJoinText } from "../lib/join-tokens.js";
import { mountJoinForm } from "./join-form.js";
import { deleteSavedJoin, renderSavedChips, savedJoinFor, saveJoin } from "./join-saved.js";
import { draftText, mountJoinSql } from "./join-sql.js";

// The join overlay: one JoinDef edited in a form (the SQL text mode builds on
// the same dialog). Show result applies it and closes; the server's answer to a
// bad join comes back through openJoinDialog's `error`.
const dialog = $<HTMLDialogElement>("join-dialog");
const formTab = $<HTMLButtonElement>("join-mode-form");
const sqlTab = $<HTMLButtonElement>("join-mode-sql");
const runBtn = $<HTMLButtonElement>("join-run");
let mode: "form" | "sql" = "form";
// The form as it was when SQL took over. A half-finished form prints as text
// that does not parse; until that text is edited, Form goes back to this draft.
let handoff: { text: string; draft: Draft } | null = null;
const untouched = (): boolean => handoff !== null && sql.text() === handoff.text;

// The one thing wrong with the join as it stands, or "": a pair that cannot be
// joined (form) or text that does not parse (SQL).
function problem(): string {
  if (mode === "form") return form.problem() ?? "";
  const result = sql.text().trim() ? sql.parse() : null;
  return result && "error" in result ? `Line ${result.error.line}: ${result.error.message}` : "";
}

function refresh(): void {
  const bad = problem();
  runBtn.disabled = bad !== "" || (mode === "sql" && sql.text().trim() === "");
  if (mode === "form") {
    $("join-preview").replaceChildren(...coloured(draftText(form.draft())));
    return;
  }
  const back = untouched();
  $("join-sql-error").textContent = back ? "" : bad;
  formTab.disabled = bad !== "" && !back;
  $("join-sql-tip").hidden = bad === "" || back;
}

function coloured(text: string): Node[] {
  return tokenizeJoinText(text).map((t) => {
    const span = el("span", t.kind === "keyword" ? "t-keyword" : "", text.slice(t.start, t.end));
    return span;
  });
}

// A message from the server or a failed save stays until the user changes something.
const clearError = (e: Event): void => {
  if (!(e.target as HTMLElement).closest("#join-run")) $("join-error").textContent = "";
};
dialog.addEventListener("input", clearError);
dialog.addEventListener("click", clearError);

const form = mountJoinForm($("join-form"), refresh);
const sql = mountJoinSql(refresh);

function setMode(next: "form" | "sql"): void {
  mode = next;
  formTab.setAttribute("aria-selected", String(next === "form"));
  sqlTab.setAttribute("aria-selected", String(next === "sql"));
  $("join-form-pane").hidden = next !== "form";
  $("join-sql-pane").hidden = next !== "sql";
  formTab.disabled = false;
  $("join-sql-tip").hidden = true;
}

// The name of the saved join being edited, so a new name renames it.
let editingSaved: string | undefined;

// `def` is the join to edit, by default the one in view; `fresh` starts from
// the table in view instead. `focusName` is the `Save…` chip, which only wants
// the name field.
export function openJoinDialog(
  opts: { error?: string; def?: JoinDef; fresh?: boolean; focusName?: boolean } = {},
): void {
  // Reopened while its join was loading: the server's answer must not replace what is being typed.
  if (opts.error !== undefined && dialog.open) {
    $("join-error").textContent = opts.error;
    return;
  }
  const def = opts.fresh ? undefined : (opts.def ?? joinInView()?.def);
  const saved = def ? savedJoinFor(printJoin(def)) : undefined;
  editingSaved = saved?.name;
  $<HTMLInputElement>("join-name").value = saved?.name ?? "";
  $("join-delete").hidden = saved === undefined;
  form.setDraft(def ? defToDraft(def) : newDraft(startTable(state.view) ?? ""));
  handoff = null;
  setMode("form");
  $("join-sql-error").textContent = "";
  refresh();
  $("join-error").textContent = opts.error ?? "";
  if (!dialog.open) dialog.showModal();
  if (opts.focusName) $<HTMLInputElement>("join-name").focus();
}

export function refreshSavedChips(): void {
  renderSavedChips({
    open: applyJoin,
    edit: () => openJoinDialog(),
    startNew: () => openJoinDialog({ fresh: true }),
    saveCurrent: () => openJoinDialog({ focusName: true }),
  });
}

export function applyJoin(def: JoinDef): void {
  loadData({ next: joinRequest(def) });
}

export function switchToLeftJoin(): void {
  const def = joinInView()?.def;
  if (def) applyJoin({ ...def, joins: def.joins.map((j) => ({ ...j, type: "left" })) });
}

runBtn.onclick = () => {
  const result = mode === "sql" ? sql.parse() : draftToDef(form.draft());
  if ("error" in result) {
    $("join-error").textContent = typeof result.error === "string" ? result.error : problem();
    return;
  }
  const name = $<HTMLInputElement>("join-name").value.trim();
  if (name !== "") {
    const failure = saveJoin(name, printJoin(result.def), editingSaved);
    if (failure) {
      $("join-error").textContent = failure;
      return;
    }
  }
  committed = true;
  dialog.close();
  applyJoin(result.def);
};
// Set by Show result, whose join is already loading when the close event arrives.
let committed = false;
// A join from a link or history that the server refused has never been shown;
// closing its dialog any other way opens its start table instead.
dialog.addEventListener("close", () => {
  if (committed) committed = false;
  else if (joinInView() && !viewIsShown()) {
    clearJoin();
    persist();
    loadData();
  }
});
$("join-delete").onclick = () => {
  if (editingSaved !== undefined) deleteSavedJoin(editingSaved);
  dialog.close();
  refreshSavedChips();
};
$("join-link-btn").onclick = () => copyText(location.href, $("join-link-btn"));
formTab.onclick = () => {
  if (mode === "form" || formTab.disabled) return;
  if (handoff && untouched()) form.setDraft(handoff.draft);
  else {
    const parsed = sql.text().trim() ? sql.parse() : null;
    if (parsed && "error" in parsed) return;
    form.setDraft(parsed ? defToDraft(parsed.def) : newDraft(startTable(state.view) ?? ""));
  }
  setMode("form");
  refresh();
};
sqlTab.onclick = () => {
  if (mode === "sql") return;
  handoff = { text: draftText(form.draft()), draft: form.draft() };
  sql.setText(handoff.text);
  setMode("sql");
  refresh();
  $<HTMLTextAreaElement>("join-sql").focus();
};
$("join-cancel").onclick = () => dialog.close();
$("join-btn").onclick = () => openJoinDialog();
$("join-edit-btn").onclick = () => openJoinDialog();
