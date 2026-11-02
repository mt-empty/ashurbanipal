import type { Column, JoinClass } from "../core/types.js";

// ==== Join pair checks (spec/protocol.md §5.11.2) ====
// The server reports each column's join class, so the form greys exactly the
// pairs it would reject: a different class, two different enumerated types
// (an equal `type` means the same enum), or a column with no class at all.

type Typed = Pick<Column, "type" | "class">;

const LABEL: Record<JoinClass, string> = {
  number: "number",
  text: "text",
  uuid: "uuid",
  boolean: "boolean",
  temporal: "date/time",
  time: "time",
  binary: "binary",
  enum: "enum",
  untyped: "untyped",
};

export interface JoinMismatch {
  // Short, for a menu row: `text ≠ uuid`, `jsonb: not joinable`.
  note: string;
  // A sentence for under the pair.
  message: string;
}

// Why column `candidate` cannot pair with `other`, or null when it can.
export function joinMismatch(candidate: Typed, other: Typed): JoinMismatch | null {
  const blocked = unjoinableReason(candidate) ?? unjoinableReason(other);
  if (blocked) {
    const type = candidate.class ? other.type : candidate.type;
    return { note: blocked, message: `${type} columns cannot be joined. Pick another column.` };
  }
  const a = candidate.class as JoinClass;
  const b = other.class as JoinClass;
  if (a === b && (a !== "enum" || candidate.type === other.type)) return null;
  return {
    note: `${candidate.type} ≠ ${other.type}`,
    message:
      a === b
        ? `${candidate.type} cannot be joined to ${other.type}: they are different enumerated types.`
        : `${LABEL[a]} cannot be joined to ${LABEL[b]}. Pick columns of the same kind.`,
  };
}

// A column that cannot join anything, whatever the other side is.
export function unjoinableReason(column: Typed): string | null {
  return column.class ? null : `${column.type}: not joinable`;
}

// The note a menu row shows for `column` when the other side is `other` (or
// nothing picked yet); a non-null note means the row is greyed.
export function pairNote(column: Typed, other: Typed | undefined): string | null {
  return other === undefined ? unjoinableReason(column) : (joinMismatch(column, other)?.note ?? null);
}

export interface ForeignKeyPair {
  // Index into the `earlier` list.
  at: number;
  leftColumn: string;
  rightColumn: string;
}

// A foreign key between `table` (with columns `own`) and one of the earlier
// tables, in either direction, as an ON pair; the first match wins.
export function findForeignKey(
  earlier: readonly { table: string; columns: readonly Column[] }[],
  table: string,
  own: readonly Column[],
): ForeignKeyPair | null {
  for (const [at, e] of earlier.entries()) {
    const out = e.columns.find((c) => c.references?.table === table);
    if (out?.references) return { at, leftColumn: out.name, rightColumn: out.references.column };
    const back = own.find((c) => c.references?.table === e.table);
    if (back?.references) return { at, leftColumn: back.references.column, rightColumn: back.name };
  }
  return null;
}
