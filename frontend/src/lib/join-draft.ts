import type { JoinColumn, JoinDef, JoinType } from "../core/types.js";

// ==== Join form draft ====
// What the form edits: a join that may still be incomplete (no table chosen
// yet, an ON pair half filled). draftToDef is the one place it becomes a
// JoinDef, or says what is missing.

export interface DraftPair {
  leftJoin: number;
  leftColumn: string;
  rightColumn: string;
}

export interface DraftJoin {
  type: JoinType;
  table: string;
  alias: string;
  on: DraftPair[];
}

export interface Draft {
  table: string;
  alias: string;
  joins: DraftJoin[];
  // Per table position: null selects every column, a list selects just those.
  columns: (string[] | null)[];
}

export const emptyPair = (): DraftPair => ({ leftJoin: 0, leftColumn: "", rightColumn: "" });

export function newDraft(table: string): Draft {
  return {
    table,
    alias: "",
    joins: [{ type: "inner", table: "", alias: "", on: [emptyPair()] }],
    columns: [null, null],
  };
}

export function defToDraft(def: JoinDef): Draft {
  const columns = def.tables.map((_, join): string[] | null => {
    if (def.columns === null) return null;
    const mine = def.columns.filter((c) => c.join === join);
    return mine.some((c) => "all" in c) ? null : mine.map((c) => ("column" in c ? c.column : ""));
  });
  return {
    table: def.tables[0].table,
    alias: def.tables[0].alias ?? "",
    joins: def.joins.map((j, i) => ({
      type: j.type,
      table: def.tables[i + 1].table,
      alias: def.tables[i + 1].alias ?? "",
      on: j.on.map((p) => ({ leftJoin: p.left.join, leftColumn: p.left.column, rightColumn: p.right })),
    })),
    columns,
  };
}

export function draftToDef(draft: Draft): { def: JoinDef } | { error: string } {
  const tables = [
    { table: draft.table, alias: draft.alias.trim() || null },
    ...draft.joins.map((j) => ({ table: j.table, alias: j.alias.trim() || null })),
  ];
  const seen = new Set<string>();
  for (const [i, t] of tables.entries()) {
    if (t.table === "") return { error: i === 0 ? "Choose the table to start from." : `Choose a table for join ${i}.` };
    const name = t.alias ?? t.table;
    if (seen.has(name))
      return {
        error:
          t.alias === null
            ? `${t.table} is used twice; give the second use an alias.`
            : `The alias ${name} is used twice.`,
      };
    seen.add(name);
  }
  const joins = [];
  for (const [i, j] of draft.joins.entries()) {
    if (j.on.length === 0) return { error: `Add a column pair to join ${i + 1}.` };
    for (const p of j.on) {
      if (p.leftColumn === "" || p.rightColumn === "") return { error: `Finish the column pair of join ${i + 1}.` };
    }
    joins.push({
      type: j.type,
      on: j.on.map((p) => ({ left: { join: p.leftJoin, column: p.leftColumn }, right: p.rightColumn })),
    });
  }
  let columns: JoinColumn[] | null = null;
  if (draft.columns.some((c) => c !== null)) {
    columns = draft.columns.flatMap((c, join): JoinColumn[] =>
      c === null ? [{ join, all: true }] : c.map((column) => ({ join, column })),
    );
    if (columns.length === 0) return { error: "Select at least one column." };
  }
  return { def: { tables, joins, columns } };
}

// Keeps `columns` one entry per table after the table list changes.
export function addJoin(draft: Draft): void {
  draft.joins.push({ type: "inner", table: "", alias: "", on: [emptyPair()] });
  draft.columns.push(null);
}

export function removeLastJoin(draft: Draft): void {
  draft.joins.pop();
  draft.columns.pop();
}
