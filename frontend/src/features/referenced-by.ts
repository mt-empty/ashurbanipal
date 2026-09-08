import { api } from "../core/api.js";
import { $ } from "../core/dom.js";
import { applyScopeParams, state } from "../core/state.js";
import type { ReferencedByEntry, Row } from "../core/types.js";
import { applyFilterClauses } from "./filter-ui.js";
import { navigateWithSeededFilter } from "./nav.js";

// ---- "referenced by": the incoming FKs that target the viewed table
// (spec/protocol.md §5.9, the reverse of a column's `references`). One
// renderer drives both surfaces — the PK-cell popover and the record
// dialog section — differing only in the container and how it dismisses.
// The drill-in reuses navigateWithSeededFilter, reversed: switch to the
// referencing table and seed `from = row[to]` per column pair. ----

// §5.9 is catalog-only and row-independent — the answer is the same for
// every row of a table — so the result is memoised per (source, schema,
// table). Browsing a wide table row by row through the record dialog then
// costs one fetch, not one per open. The key namespaces scope, so a
// source/schema switch invalidates implicitly; only mid-session DDL goes
// stale, which nothing else in the app guards against either.
const cache = new Map<string, ReferencedByEntry[]>();
const cacheKey = (table: string) => `${state.source ?? ""}\x1f${state.schema ?? ""}\x1f${table}`;

// Same staleness guard as cvRequestToken: a second PK cell clicked before
// the first response lands must not overwrite the list now on screen. One
// module token is enough — both surfaces share this renderer.
let refbyToken = 0;

function msg(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "refby-empty";
  p.textContent = text;
  return p;
}

function drillIn(entry: ReferencedByEntry, row: Row, dismiss: () => void): void {
  // Buttons with a null-valued `to` are rendered disabled, so every pair
  // here has an expressible `=` clause.
  const clauses = entry.columns.map((c) => ({ column: c.from, value: row[c.to] as string }));
  dismiss();
  navigateWithSeededFilter(entry.table, entry.schema, () => applyFilterClauses(clauses));
}

function renderList(container: HTMLElement, entries: ReferencedByEntry[], row: Row, dismiss: () => void): void {
  if (entries.length === 0) {
    container.replaceChildren(msg("nothing references this table"));
    return;
  }
  container.replaceChildren(
    ...entries.map((entry) => {
      const label = entry.schema ? `${entry.schema}.${entry.table}` : entry.table;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "refby-entry";
      btn.textContent = `→ ${label} (${entry.columns.map((c) => c.from).join(", ")})`;
      const nullPair = entry.columns.find((c) => row[c.to] == null);
      if (nullPair) {
        btn.disabled = true;
        btn.title = `${nullPair.to} is null in this row — no filter is expressible`;
      } else {
        btn.title = `go to ${label} where ${entry.columns.map((c) => `${c.from} = ${row[c.to]}`).join(" AND ")}`;
        btn.onclick = () => drillIn(entry, row, dismiss);
      }
      return btn;
    }),
  );
}

export function renderReferencedBy(container: HTMLElement, row: Row, dismiss: () => void): void {
  const token = ++refbyToken;
  const table = state.table ?? "";
  // Key captured now, alongside applyScopeParams' read of the same scope,
  // so a mid-flight scope switch can't file the result under the wrong key.
  const key = cacheKey(table);
  const hit = cache.get(key);
  if (hit) {
    renderList(container, hit, row, dismiss);
    return;
  }
  container.replaceChildren(msg("loading…"));

  const params = new URLSearchParams({ table });
  applyScopeParams(params);
  api<{ referenced_by: ReferencedByEntry[] }>(`/tables/referenced-by?${params}`)
    .then((data) => {
      cache.set(key, data.referenced_by);
      if (token !== refbyToken) return;
      renderList(container, data.referenced_by, row, dismiss);
    })
    .catch((e) => {
      if (token !== refbyToken) return;
      container.replaceChildren(msg((e as Error).message));
    });
}

// Surface A: anchor the popover to the clicked PK cell (mirror of the
// FK-cell click). Separate anchor-name from #cell-pop's — both can be
// resolved from one render pass.
let refbyAnchor: HTMLElement | null = null;
export function openReferencedByPopover(e: MouseEvent, row: Row): void {
  if (refbyAnchor) refbyAnchor.style.anchorName = "";
  refbyAnchor = e.currentTarget as HTMLElement;
  refbyAnchor.style.anchorName = "--refby-anchor";
  $("refby-pop").showPopover();
  renderReferencedBy($("refby-pop-list"), row, () => $("refby-pop").hidePopover());
}
