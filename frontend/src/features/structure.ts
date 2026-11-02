import { api } from "../core/api.js";
import { $, el } from "../core/dom.js";
import { applyScopeParams, qualifiedTable, scopeIdentity, tableInView } from "../core/state.js";
import type { ConstraintFk, StructureResponse } from "../core/types.js";
import { fkTarget } from "../lib/column-key.js";
import { createPromiseCache } from "../lib/promise-cache.js";

// ---- structure dialog: a table's indexes and constraints (spec/protocol.md
// §5.10), cached per (source, schema, table); errors are never cached. ----

const cache = createPromiseCache<StructureResponse>();

export function clearStructureCache(): void {
  cache.clear();
}

// A second open before the first response lands must not overwrite the
// body now on screen.
let requestToken = 0;

function msg(text: string): HTMLParagraphElement {
  const p = el("p", "refby-empty", text);
  return p;
}

function row(text: string, detail?: string): HTMLDivElement {
  const div = el("div", "structure-row", text);
  if (detail) {
    const d = el("div", "structure-row-detail", detail);
    div.appendChild(d);
  }
  return div;
}

function section(label: string, rows: HTMLElement[], emptyText: string): HTMLDivElement {
  const wrap = el("div", "structure-section");
  const heading = el("span", "section-label", label);
  const list = el("div");
  list.replaceChildren(...(rows.length ? rows : [msg(emptyText)]));
  wrap.append(heading, list);
  return wrap;
}

function fkRow(fk: ConstraintFk): HTMLDivElement {
  const from = fk.columns.map((c) => c.from).join(", ");
  const to = fk.columns.map((c) => c.to).join(", ");
  return row(`${fk.name}  ${from} → ${fkTarget(fk)}(${to})`, `ON DELETE ${fk.on_delete}  ON UPDATE ${fk.on_update}`);
}

function renderStructure(data: StructureResponse): void {
  const { primary_key: pk, unique, foreign_keys, check } = data.constraints;
  $("structure-body").replaceChildren(
    section(
      "indexes",
      data.indexes.map((i) =>
        row(
          `${i.name}  (${i.columns.join(", ")})  — ${i.unique ? "unique, " : ""}${i.method}`,
          i.predicate && `WHERE ${i.predicate}`,
        ),
      ),
      "no indexes",
    ),
    section("primary key", pk ? [row(`${pk.name ?? "(unnamed)"}  (${pk.columns.join(", ")})`)] : [], "no primary key"),
    section(
      "unique",
      unique.map((u) => row(`${u.name}  (${u.columns.join(", ")})`)),
      "none",
    ),
    section("foreign keys", foreign_keys.map(fkRow), "none"),
    section(
      "check",
      check.map((c) => row(c.name, c.expression)),
      "none",
    ),
  );
}

// One table's structure through the same cache the dialog uses.
export function tableStructure(table: string): Promise<StructureResponse> {
  return cache.get(scopeIdentity(table), () => {
    const params = new URLSearchParams({ table });
    applyScopeParams(params);
    return api<StructureResponse>(`/tables/structure?${params}`);
  });
}

export function openStructure(): void {
  const table = tableInView();
  if (table === null) return;
  const token = ++requestToken;
  $("structure-title").textContent = `structure — ${qualifiedTable(table)}`;
  $<HTMLDialogElement>("structure-dialog").showModal();

  const hit = cache.peek(scopeIdentity(table));
  if (hit) {
    renderStructure(hit);
    return;
  }
  $("structure-body").replaceChildren(msg("loading…"));
  tableStructure(table)
    .then((data) => {
      if (token === requestToken) renderStructure(data);
    })
    .catch((e) => {
      if (token === requestToken) $("structure-body").replaceChildren(msg((e as Error).message));
    });
}
