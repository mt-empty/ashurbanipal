import { api } from "../core/api.js";
import { $ } from "../core/dom.js";
import { applyScopeParams, state } from "../core/state.js";
import type { ConstraintFk, StructureResponse } from "../core/types.js";

// ---- structure dialog: a table's indexes and constraints (spec/protocol.md
// §5.10), cached per (source, schema, table); errors are never cached. ----

const cache = new Map<string, StructureResponse>();
const cacheKey = (table: string) => `${state.source ?? ""}\x1f${state.schema ?? ""}\x1f${table}`;

// Bumped by the refresh button so a response already in flight cannot write
// its pre-refresh result back into the cache.
let cacheGeneration = 0;
export function clearStructureCache(): void {
  cache.clear();
  cacheGeneration++;
}

// A second open before the first response lands must not overwrite the
// body now on screen.
let requestToken = 0;

function msg(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "refby-empty";
  p.textContent = text;
  return p;
}

function row(text: string, detail?: string): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "structure-row";
  div.textContent = text;
  if (detail) {
    const d = document.createElement("div");
    d.className = "structure-row-detail";
    d.textContent = detail;
    div.appendChild(d);
  }
  return div;
}

function section(label: string, rows: HTMLElement[], emptyText: string): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "structure-section";
  const heading = document.createElement("span");
  heading.className = "section-label";
  heading.textContent = label;
  const list = document.createElement("div");
  list.replaceChildren(...(rows.length ? rows : [msg(emptyText)]));
  wrap.append(heading, list);
  return wrap;
}

function fkRow(fk: ConstraintFk): HTMLDivElement {
  const target = fk.schema ? `${fk.schema}.${fk.table}` : fk.table;
  const from = fk.columns.map((c) => c.from).join(", ");
  const to = fk.columns.map((c) => c.to).join(", ");
  return row(`${fk.name}  ${from} → ${target}(${to})`, `ON DELETE ${fk.on_delete}  ON UPDATE ${fk.on_update}`);
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

export function openStructure(): void {
  const table = state.table;
  if (!table) return;
  const token = ++requestToken;
  $("structure-title").textContent = `structure — ${state.schema ? `${state.schema}.${table}` : table}`;
  $<HTMLDialogElement>("structure-dialog").showModal();

  // Key captured now, alongside applyScopeParams' read of the same scope,
  // so a mid-flight scope switch can't file the result under the wrong key.
  const key = cacheKey(table);
  const generation = cacheGeneration;
  const hit = cache.get(key);
  if (hit) {
    renderStructure(hit);
    return;
  }
  $("structure-body").replaceChildren(msg("loading…"));

  const params = new URLSearchParams({ table });
  applyScopeParams(params);
  api<StructureResponse>(`/tables/structure?${params}`)
    .then((data) => {
      if (generation === cacheGeneration) cache.set(key, data);
      if (token === requestToken) renderStructure(data);
    })
    .catch((e) => {
      if (token === requestToken) $("structure-body").replaceChildren(msg((e as Error).message));
    });
}
