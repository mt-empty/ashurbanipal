import type { Column } from "../core/types.js";
import { addJoin, type Draft, type DraftJoin, type DraftPair, emptyPair, removeLastJoin } from "../lib/join-draft.js";
import { JOIN_MAX_PAIRS, JOIN_MAX_TABLES } from "../lib/join-dsl.js";
import { joinBlocker, unjoinableReason } from "../lib/join-types.js";
import { tableColumns } from "./join-catalog.js";
import { listedTableNames } from "./sidebar.js";

// The Form half of the join overlay: edits a Draft in place and tells the
// dialog when it changed. Selects and buttons re-render the form; typing in an
// alias box does not, so the caret stays put.

interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

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

function select(label: string, options: Option[], value: string, onPick: (v: string) => void): HTMLSelectElement {
  const s = el("select");
  s.setAttribute("aria-label", label);
  for (const o of options) {
    const opt = el("option", undefined, o.label);
    opt.value = o.value;
    opt.disabled = o.disabled ?? false;
    s.appendChild(opt);
  }
  s.value = value;
  s.onchange = () => onPick(s.value);
  return s;
}

function button(text: string, label: string, run: () => void): HTMLButtonElement {
  const b = el("button", undefined, text);
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.onclick = run;
  return b;
}

export interface JoinForm {
  setDraft(draft: Draft): void;
  draft(): Draft;
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
    if (token === loadToken) render();
  }

  const changed = (): void => {
    render();
    onChange();
  };

  const tableOptions = (): Option[] => [
    { value: "", label: "choose a table" },
    ...listedTableNames().map((t) => ({ value: t, label: t })),
  ];

  const aliasInput = (value: string, label: string, set: (v: string) => void): HTMLInputElement => {
    const input = el("input");
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

  // A column that cannot pair with the other side is disabled and says why in its label.
  const columnOption = (c: Column, otherType: string | undefined): Option => {
    const reason = otherType === undefined ? unjoinableReason(c.type) : joinBlocker(c.type, otherType);
    return { value: c.name, label: `${c.name} (${c.type})${reason ? ` — ${reason}` : ""}`, disabled: reason !== null };
  };

  function pairRow(join: DraftJoin, pos: number, pair: DraftPair): HTMLElement {
    const row = el("div", "jf-pair");
    const leftType = typeOf(pair.leftJoin, pair.leftColumn);
    const rightType = (columnsAt(pos).find((c) => c.name === pair.rightColumn) ?? { type: undefined }).type;
    const left = el("select");
    left.setAttribute("aria-label", `join ${pos}: column of an earlier table`);
    left.appendChild(Object.assign(el("option", undefined, "choose column"), { value: "" }));
    for (let p = 0; p < pos; p++) {
      const group = el("optgroup");
      group.label = nameAt(p);
      for (const c of columnsAt(p)) {
        const o = columnOption(c, rightType);
        group.appendChild(
          Object.assign(el("option", undefined, o.label), { value: `${p}|${c.name}`, disabled: o.disabled }),
        );
      }
      left.appendChild(group);
    }
    left.value = pair.leftColumn ? `${pair.leftJoin}|${pair.leftColumn}` : "";
    left.onchange = () => {
      const [p, ...rest] = left.value.split("|");
      pair.leftJoin = left.value ? Number(p) : 0;
      pair.leftColumn = rest.join("|");
      changed();
    };
    const right = select(
      `join ${pos}: column of ${nameAt(pos) || "this table"}`,
      [{ value: "", label: "choose column" }, ...columnsAt(pos).map((c) => columnOption(c, leftType))],
      pair.rightColumn,
      (v) => {
        pair.rightColumn = v;
        changed();
      },
    );
    row.append(left, el("span", "jf-eq", "="), right);
    if (join.on.length > 1) {
      row.appendChild(
        button("✕", `remove column pair from join ${pos}`, () => {
          join.on.splice(join.on.indexOf(pair), 1);
          changed();
        }),
      );
    }
    return row;
  }

  // A foreign key between this table and an earlier one is a suggestion, never required.
  function foreignKeySuggestion(join: DraftJoin, pos: number): DraftPair | null {
    for (let p = 0; p < pos; p++) {
      for (const c of columnsAt(p)) {
        if (c.references?.table === join.table)
          return { leftJoin: p, leftColumn: c.name, rightColumn: c.references.column };
      }
      for (const c of columnsAt(pos)) {
        if (c.references?.table === tableAt(p))
          return { leftJoin: p, leftColumn: c.references.column, rightColumn: c.name };
      }
    }
    return null;
  }

  function joinBlock(join: DraftJoin, pos: number): HTMLElement {
    const box = el("fieldset", "jf-join");
    box.appendChild(el("legend", undefined, `join ${pos}`));
    const head = el("div", "jf-row");
    head.append(
      select(
        `join ${pos} type`,
        [
          { value: "inner", label: "INNER" },
          { value: "left", label: "LEFT" },
        ],
        join.type,
        (v) => {
          join.type = v === "left" ? "left" : "inner";
          changed();
        },
      ),
      select(`join ${pos} table`, tableOptions(), join.table, (v) => {
        join.table = v;
        join.on = [emptyPair()];
        draft.columns[pos] = null;
        changed();
        load();
      }),
      aliasInput(join.alias, `join ${pos} alias`, (v) => {
        join.alias = v;
      }),
    );
    if (pos === draft.joins.length) {
      head.appendChild(
        button("✕", `remove join ${pos}`, () => {
          removeLastJoin(draft);
          changed();
        }),
      );
    }
    box.appendChild(head);
    if (join.table !== "") {
      for (const pair of join.on) box.appendChild(pairRow(join, pos, pair));
      const tools = el("div", "jf-row");
      if (join.on.length < JOIN_MAX_PAIRS) {
        tools.appendChild(
          button("+ add pair", `add a column pair to join ${pos}`, () => {
            join.on.push(emptyPair());
            changed();
          }),
        );
      }
      const fk = foreignKeySuggestion(join, pos);
      if (fk && !join.on.some((p) => p.leftColumn === fk.leftColumn && p.rightColumn === fk.rightColumn)) {
        tools.appendChild(
          button(
            `use foreign key: ${nameAt(fk.leftJoin)}.${fk.leftColumn} = ${nameAt(pos)}.${fk.rightColumn}`,
            `use the foreign key between ${nameAt(fk.leftJoin)} and ${nameAt(pos)}`,
            () => {
              join.on = [fk];
              changed();
            },
          ),
        );
      }
      box.appendChild(tools);
    }
    return box;
  }

  function columnsBlock(pos: number): HTMLElement | null {
    const cols = columnsAt(pos);
    if (cols.length === 0) return null;
    const details = el("details", "jf-columns");
    const summary = el("summary");
    const sync = (): void => {
      const picked = draft.columns[pos];
      summary.textContent = `${nameAt(pos)}: ${picked === null ? "all columns" : `${picked.length} of ${cols.length} columns`}`;
    };
    details.appendChild(summary);
    const list = el("div", "jf-column-list");
    for (const c of cols) {
      const label = el("label");
      const box = el("input");
      box.type = "checkbox";
      box.checked = draft.columns[pos] === null || (draft.columns[pos] as string[]).includes(c.name);
      box.onchange = () => {
        const checked = [...list.querySelectorAll("input")]
          .filter((i) => i.checked)
          .map((i) => i.dataset.col as string);
        draft.columns[pos] = checked.length === cols.length ? null : checked;
        sync();
        onChange();
      };
      box.dataset.col = c.name;
      label.append(box, `${c.name} `, Object.assign(el("code", "col-type"), { textContent: c.type }));
      list.appendChild(label);
    }
    details.appendChild(list);
    sync();
    return details;
  }

  function render(): void {
    const start = el("div", "jf-row");
    start.append(
      el("span", "jf-label", "from"),
      select("start table", tableOptions(), draft.table, (v) => {
        draft.table = v;
        // The pairs name columns of the old table.
        for (const j of draft.joins) j.on = [emptyPair()];
        draft.columns[0] = null;
        changed();
        load();
      }),
      aliasInput(draft.alias, "start table alias", (v) => {
        draft.alias = v;
      }),
    );
    const parts: HTMLElement[] = [start];
    draft.joins.forEach((j, i) => {
      parts.push(joinBlock(j, i + 1));
    });
    if (draft.joins.length + 1 < JOIN_MAX_TABLES) {
      parts.push(
        button("+ add table", "add a table to the join", () => {
          addJoin(draft);
          changed();
        }),
      );
    }
    const cols = el("div", "jf-columns-wrap");
    for (let pos = 0; pos <= draft.joins.length; pos++) {
      const block = columnsBlock(pos);
      if (block) cols.appendChild(block);
    }
    if (cols.children.length) parts.push(el("h3", "jf-heading", "columns"), cols);
    root.replaceChildren(...parts);
    load();
  }

  return {
    setDraft(next) {
      draft = next;
      render();
    },
    draft: () => draft,
  };
}
