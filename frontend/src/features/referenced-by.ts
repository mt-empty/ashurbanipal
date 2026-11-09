import { api } from "../core/api.js";
import { $, el } from "../core/dom.js";
import { tableInView } from "../core/state.js";
import type { ReferencedByEntry, Row, TableRef } from "../core/types.js";
import { fkTarget } from "../lib/column-key.js";
import { filterClauses } from "../lib/filter-dsl.js";
import { createPromiseCache } from "../lib/promise-cache.js";
import { near, refKey, tableParams } from "../lib/table-ref.js";
import { navigateWithSeededFilter } from "./view-history.js";

// ---- "referenced by": the incoming FKs that target the viewed table
// (spec/protocol.md §5.9, the reverse of a column's `references`). One
// renderer drives both surfaces — the PK-cell popover and the record
// dialog section — differing only in the container and how it dismisses.
// The drill-in reuses navigateWithSeededFilter, reversed: switch to the
// referencing table and seed `from = row[to]` per column pair. ----

// §5.9 is catalog-only and row-independent — the answer is the same for
// every row of a table — so the result is memoised per (source, schema,
// table). The key namespaces scope, so a source/schema switch invalidates
// implicitly; the refresh button clears it for mid-session DDL.
const cache = createPromiseCache<ReferencedByEntry[]>();

export function clearReferencedByCache(): void {
  cache.clear();
}

export function fetchReferencedBy(ref: TableRef): Promise<ReferencedByEntry[]> {
  return cache.get(refKey(ref), () =>
    api<{ referenced_by: ReferencedByEntry[] }>(`/tables/referenced-by?${tableParams(ref)}`).then(
      (d) => d.referenced_by,
    ),
  );
}

// Same staleness guard as cvRequestToken: a second call targeting the same
// container before the first response lands must not overwrite the list
// now on screen. Keyed per container, not one module-wide counter — the
// popover and the record dialog are two independent containers that can
// each be triggered while the other's fetch is still in flight, and a
// shared counter would let opening one discard the other's completed
// response, leaving it stuck on "loading…".
const renderTokens = new Map<HTMLElement, number>();

function msg(text: string): HTMLParagraphElement {
  const p = el("p", "refby-empty", text);
  return p;
}

// A referrer's `schema` is relative to the table it references (spec/protocol.md §5.9).
function drillIn(target: TableRef, entry: ReferencedByEntry, row: Row, dismiss: () => void): void {
  // Buttons with a null-valued `to` are rendered disabled, so every pair
  // here has an expressible `=` clause.
  const clauses = entry.columns.map((c) => ({ column: c.from, value: row[c.to] as string }));
  dismiss();
  navigateWithSeededFilter(near(target, entry.schema, entry.table), filterClauses(clauses));
}

function renderList(
  container: HTMLElement,
  target: TableRef,
  entries: ReferencedByEntry[],
  row: Row,
  dismiss: () => void,
): void {
  if (entries.length === 0) {
    container.replaceChildren(msg("nothing references this table"));
    return;
  }
  container.replaceChildren(
    ...entries.map((entry) => {
      const label = fkTarget(entry);
      const btn = el("button");
      btn.type = "button";
      btn.className = "refby-entry";
      btn.textContent = `→ ${label} (${entry.columns.map((c) => c.from).join(", ")})`;
      const nullPair = entry.columns.find((c) => row[c.to] == null);
      if (nullPair) {
        btn.disabled = true;
        // `to` names a column absent from `row` itself (not merely null-valued)
        // when the referenced table has no declared primary key — the backend
        // falls back to SQLite's implicit rowid (spec/protocol.md §5.9), which
        // /api/tables/data never exposes as a column. Distinct from a genuine
        // NULL in a real column, which the row data does carry.
        btn.title =
          nullPair.to in row
            ? `${nullPair.to} is null in this row — no filter is expressible`
            : "this table has no primary key — no filter is expressible";
      } else {
        btn.title = `go to ${label} where ${entry.columns.map((c) => `${c.from} = ${row[c.to]}`).join(" AND ")}`;
        btn.onclick = () => drillIn(target, entry, row, dismiss);
      }
      return btn;
    }),
  );
}

export function renderReferencedBy(container: HTMLElement, row: Row, dismiss: () => void): void {
  const token = (renderTokens.get(container) ?? 0) + 1;
  renderTokens.set(container, token);
  // Only offered in a table view: a join row has several tables.
  const table = tableInView();
  if (table === null) return;
  const hit = cache.peek(refKey(table));
  if (hit) {
    renderList(container, table, hit, row, dismiss);
    return;
  }
  container.replaceChildren(msg("loading…"));
  fetchReferencedBy(table)
    .then((entries) => {
      if (renderTokens.get(container) !== token) return;
      renderList(container, table, entries, row, dismiss);
    })
    .catch((e) => {
      if (renderTokens.get(container) !== token) return;
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
