import type { Column } from "../core/types.js";
import { addJoin, type Draft, type DraftJoin, type DraftPair, emptyPair, removeJoin } from "../lib/join-draft.js";
import { JOIN_MAX_PAIRS, JOIN_MAX_TABLES } from "../lib/join-dsl.js";
import { joinMismatch, unjoinableReason } from "../lib/join-types.js";
import { createDropdown, lastDropdownLabel } from "./dropdown.js";
import { tableColumns } from "./join-catalog.js";
import { listedTableNames, tableChipCount } from "./sidebar.js";

// The Form half of the join overlay (board O): edits a Draft in place and tells
// the dialog when it changed. Menus and buttons re-render the form; typing in an
// alias box does not, so the caret stays put.

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function textButton(text: string, className: string, label: string, run: () => void): HTMLButtonElement {
  const b = el("button", className, text);
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.onclick = run;
  return b;
}

export interface JoinForm {
  setDraft(draft: Draft): void;
  draft(): Draft;
  // The first pair whose two column types cannot be joined, as a sentence.
  problem(): string | null;
}

export function mountJoinForm(root: HTMLElement, onChange: () => void): JoinForm {
  let draft: Draft = { table: "", alias: "", joins: [], columns: [null] };
  const loaded = new Map<string, Column[]>();
  let loadToken = 0;

  const tableAt = (pos: number): string => (pos === 0 ? draft.table : draft.joins[pos - 1].table);
  const nameAt = (pos: number): string => (pos === 0 ? draft.alias : draft.joins[pos - 1].alias).trim() || tableAt(pos);
  const columnsAt = (pos: number): Column[] => loaded.get(tableAt(pos)) ?? [];
  const typeOf = (pos: number, column: string): string | undefined =>
    columnsAt(pos).find((c) => c.name === column)?.type;

  const mismatch = (pos: number, pair: DraftPair) => {
    const left = typeOf(pair.leftJoin, pair.leftColumn);
    const right = typeOf(pos, pair.rightColumn);
    return left && right ? joinMismatch(left, right) : null;
  };

  // The foreign key between this table and an earlier one, written as a pair; the first match wins.
  function foreignKey(pos: number): DraftPair | null {
    for (let p = 0; p < pos; p++) {
      for (const c of columnsAt(p)) {
        if (c.references?.table === tableAt(pos))
          return { leftJoin: p, leftColumn: c.name, rightColumn: c.references.column };
      }
      for (const c of columnsAt(pos)) {
        if (c.references?.table === tableAt(p))
          return { leftJoin: p, leftColumn: c.references.column, rightColumn: c.name };
      }
    }
    return null;
  }

  // Columns arrive lazily; a table whose lookup fails shows no columns rather than blocking the form.
  async function load(): Promise<void> {
    const missing = [...new Set([draft.table, ...draft.joins.map((j) => j.table)])].filter((t) => t && !loaded.has(t));
    if (missing.length === 0) return;
    const token = ++loadToken;
    await Promise.all(
      missing.map(async (t) => {
        try {
          loaded.set(t, await tableColumns(t));
        } catch (e) {
          console.warn("ashurbanipal: could not read the columns of", t, e);
          loaded.set(t, []);
        }
      }),
    );
    if (token !== loadToken) return;
    // A foreign key between the new table and an earlier one is suggested, not required.
    draft.joins.forEach((j, i) => {
      const first = j.on[0];
      const fk = first && first.leftColumn === "" && first.rightColumn === "" ? foreignKey(i + 1) : null;
      if (fk) j.on[0] = fk;
    });
    render();
    onChange();
  }

  const changed = (): void => {
    const focused = lastDropdownLabel();
    render();
    if (focused) root.querySelector<HTMLElement>(`[aria-label="${CSS.escape(focused)}"]`)?.focus();
    onChange();
  };

  const aliasInput = (value: string, label: string, set: (v: string) => void): HTMLInputElement => {
    const input = el("input", "j-alias");
    input.value = value;
    input.placeholder = "alias";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("aria-label", label);
    input.oninput = () => {
      set(input.value);
      onChange();
    };
    return input;
  };

  function pairLine(join: DraftJoin, pos: number, pair: DraftPair, first: boolean): HTMLElement {
    const line = el("div", "j-line");
    const clash = mismatch(pos, pair);
    const rightType = typeOf(pos, pair.rightColumn);
    const leftType = typeOf(pair.leftJoin, pair.leftColumn);
    const leftOptions = Array.from({ length: pos }, (_, p) => p).flatMap((p) =>
      columnsAt(p).map((c) => {
        const note =
          rightType === undefined ? unjoinableReason(c.type) : (joinMismatch(c.type, rightType)?.note ?? null);
        return {
          value: `${p}|${c.name}`,
          label: `${nameAt(p)}.${c.name}`,
          note: note ?? c.type,
          blocked: note !== null,
        };
      }),
    );
    const rightOptions = columnsAt(pos).map((c) => {
      const note = leftType === undefined ? unjoinableReason(c.type) : (joinMismatch(c.type, leftType)?.note ?? null);
      return { value: c.name, label: c.name, note: note ?? c.type, blocked: note !== null };
    });
    line.append(
      el("span", "j-kw", first ? "on" : "and"),
      createDropdown({
        ariaLabel: `join ${pos}${first ? "" : ` pair ${join.on.indexOf(pair) + 1}`}: column of an earlier table`,
        options: leftOptions,
        value: pair.leftColumn ? `${pair.leftJoin}|${pair.leftColumn}` : "",
        display: pair.leftColumn ? `${nameAt(pair.leftJoin)}.${pair.leftColumn}` : undefined,
        placeholder: "choose column",
        mono: true,
        onPick: (v) => {
          const [p, ...rest] = v.split("|");
          pair.leftJoin = Number(p);
          pair.leftColumn = rest.join("|");
          changed();
        },
      }),
      el("span", "j-eq", "="),
      createDropdown({
        ariaLabel: `join ${pos}${first ? "" : ` pair ${join.on.indexOf(pair) + 1}`}: column of ${nameAt(pos) || "this table"}`,
        options: rightOptions,
        value: pair.rightColumn,
        display: pair.rightColumn ? `${nameAt(pos)}.${pair.rightColumn}` : undefined,
        placeholder: "choose column",
        mono: true,
        invalid: clash !== null,
        onPick: (v) => {
          pair.rightColumn = v;
          changed();
        },
      }),
    );
    if (leftType && rightType && !clash) line.appendChild(el("span", "j-ok", `${leftType} = ${rightType} ✓`));
    if (!first) {
      line.appendChild(
        textButton("✕", "j-rm", `remove column pair from join ${pos}`, () => {
          join.on.splice(join.on.indexOf(pair), 1);
          changed();
        }),
      );
    }
    return line;
  }

  function joinRow(join: DraftJoin, i: number): HTMLElement {
    const pos = i + 1;
    const box = el("div", "j-row");
    const head = el("div", "j-line");
    head.append(
      createDropdown({
        ariaLabel: `join ${pos} type`,
        options: [
          { value: "inner", label: "INNER" },
          { value: "left", label: "LEFT" },
        ],
        value: join.type,
        placeholder: "type",
        onPick: (v) => {
          join.type = v === "left" ? "left" : "inner";
          changed();
        },
      }),
      createDropdown({
        ariaLabel: `join ${pos} table`,
        options: listedTableNames().map((t) => ({ value: t, label: t, note: tableChipCount(t) })),
        value: join.table,
        placeholder: "choose a table",
        mono: true,
        onPick: (v) => {
          join.table = v;
          join.on = [emptyPair()];
          draft.columns[pos] = null;
          changed();
          load();
        },
      }),
      el("span", "j-kw", "as"),
      aliasInput(join.alias, `join ${pos} alias`, (v) => {
        join.alias = v;
      }),
    );
    box.appendChild(head);
    if (join.table !== "") {
      join.on.forEach((pair, k) => {
        const line = pairLine(join, pos, pair, k === 0);
        if (k === 0) head.append(...[...line.childNodes]);
        else box.appendChild(line);
      });
      const first = join.on[0];
      const fk = foreignKey(pos);
      const suggested =
        fk &&
        first &&
        first.leftJoin === fk.leftJoin &&
        first.leftColumn === fk.leftColumn &&
        first.rightColumn === fk.rightColumn;
      const hint = el("p", "j-hint");
      if (suggested)
        hint.append(
          `Suggested from the foreign key ${nameAt(fk.leftJoin)}.${fk.leftColumn} → ${nameAt(pos)}.${fk.rightColumn}.`,
        );
      else if (fk) {
        hint.appendChild(
          textButton(
            `use the foreign key ${nameAt(fk.leftJoin)}.${fk.leftColumn} = ${nameAt(pos)}.${fk.rightColumn}`,
            "j-link",
            `use the foreign key between ${nameAt(fk.leftJoin)} and ${nameAt(pos)}`,
            () => {
              join.on = [fk];
              changed();
            },
          ),
        );
      }
      if (join.on.length < JOIN_MAX_PAIRS) {
        hint.appendChild(
          textButton("add another pair", "j-link", `add a column pair to join ${pos}`, () => {
            join.on.push(emptyPair());
            changed();
          }),
        );
        hint.append(el("span", "jmuted", `up to ${JOIN_MAX_PAIRS}`));
      }
      box.appendChild(hint);
      const bad = join.on.map((p) => mismatch(pos, p)).find((m) => m !== null);
      if (bad) box.appendChild(el("p", "j-bad", bad.message));
    }
    head.appendChild(
      textButton("✕", "j-rm", `remove join ${pos}`, () => {
        removeJoin(draft, i);
        changed();
      }),
    );
    return box;
  }

  function columnCards(): HTMLElement | null {
    let total = 0;
    let picked = 0;
    const cards: HTMLElement[] = [];
    for (let pos = 0; pos <= draft.joins.length; pos++) {
      const cols = columnsAt(pos);
      if (cols.length === 0) continue;
      const chosen = draft.columns[pos];
      const count = chosen === null ? cols.length : chosen.length;
      total += cols.length;
      picked += count;
      const card = el("div", "j-card");
      const h = el("h3");
      const title = el("span", "j-card-name", nameAt(pos));
      const tally = el("span", undefined, `${count} of ${cols.length}`);
      h.append(title, tally);
      card.appendChild(h);
      const boxes: HTMLInputElement[] = [];
      for (const c of cols) {
        const label = el("label");
        const box = el("input");
        box.type = "checkbox";
        box.checked = chosen === null || chosen.includes(c.name);
        box.dataset.col = c.name;
        box.setAttribute("aria-label", `${nameAt(pos)}.${c.name}`);
        box.onchange = () => {
          const names = boxes.filter((b) => b.checked).map((b) => b.dataset.col as string);
          draft.columns[pos] = names.length === cols.length ? null : names;
          changed();
        };
        boxes.push(box);
        label.append(box, c.name);
        card.appendChild(label);
      }
      cards.push(card);
    }
    if (cards.length === 0) return null;
    const wrap = el("div");
    const grid = el("div", "j-cols");
    grid.append(...cards);
    wrap.append(el("div", "jlab", `Columns · ${picked} of ${total}`), grid);
    return wrap;
  }

  function render(): void {
    const parts: HTMLElement[] = [];
    parts.push(el("div", "jlab", "Start from"));
    const start = el("div", "j-start");
    const chip = el("span", "j-chip jmono", draft.table);
    const count = tableChipCount(draft.table);
    if (count) chip.append(" ", el("i", undefined, count));
    start.append(
      chip,
      aliasInput(draft.alias, "start table alias", (v) => {
        draft.alias = v;
      }),
      el("span", "jmuted", "the table you are viewing"),
    );
    parts.push(start);
    parts.push(el("div", "jlab", `Joins · ${draft.joins.length} of ${JOIN_MAX_TABLES - 1}`));
    draft.joins.forEach((j, i) => {
      parts.push(joinRow(j, i));
    });
    const add = el("p", "j-add");
    const full = draft.joins.length + 1 >= JOIN_MAX_TABLES;
    const addBtn = textButton("+ add table", "j-link", "add a table to the join", () => {
      addJoin(draft);
      changed();
    });
    addBtn.disabled = full;
    add.append(
      addBtn,
      " ",
      el(
        "span",
        "jmuted",
        full
          ? "Joins are limited to 4 tables. Remove one to add another."
          : "· inner and left joins only · equality only",
      ),
    );
    parts.push(add);
    const cards = columnCards();
    if (cards) parts.push(cards);
    root.replaceChildren(...parts);
    load();
  }

  return {
    setDraft(next) {
      draft = next;
      render();
    },
    draft: () => draft,
    problem() {
      for (const [i, j] of draft.joins.entries()) {
        for (const p of j.on) {
          const m = mismatch(i + 1, p);
          if (m) return m.message;
        }
      }
      return null;
    },
  };
}
