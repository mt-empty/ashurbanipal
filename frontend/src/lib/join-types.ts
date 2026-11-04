import type { ClassedColumn, Column, ColumnClass } from "../core/types.js";

// ==== Join pair checks (spec/protocol.md §5.11.2) ====
// The server reports each column's column class, so the form greys the pairs
// it would reject by type: a different class, two different enumerated types
// (`enum_type`), or a class that cannot be joined at all. A MySQL collation
// clash between two text columns is still only caught by the server.

const NOT_JOINABLE: ReadonlySet<ColumnClass> = new Set(["float", "json", "array", "other"]);

const LABEL: Record<ColumnClass, string> = {
  number: "number",
  text: "text",
  uuid: "uuid",
  boolean: "boolean",
  temporal: "date/time",
  time: "time",
  binary: "binary",
  enum: "enum",
  untyped: "untyped",
  float: "float",
  json: "json",
  array: "array",
  other: "other",
};

export interface JoinMismatch {
  // Short, for a menu row: `text ≠ uuid`, `jsonb: not joinable`.
  note: string;
  // A sentence for under the pair.
  message: string;
}

// A full type can be long (MySQL `enum('a','b',…)`), so notes cut it to fit a menu row.
export const truncateType = (type: string): string => (type.length > 24 ? `${type.slice(0, 23)}…` : type);

// Why column `candidate` cannot pair with `other`, or null when it can.
export function joinMismatch(candidate: ClassedColumn, other: ClassedColumn): JoinMismatch | null {
  const candidateReason = unjoinableReason(candidate);
  const blocked = candidateReason ?? unjoinableReason(other);
  if (blocked) {
    const type = truncateType(candidateReason ? candidate.type : other.type);
    return { note: blocked, message: `${type} columns cannot be joined. Pick another column.` };
  }
  const a = candidate.class;
  const b = other.class;
  if (a === b && (a !== "enum" || candidate.enum_type === other.enum_type)) return null;
  const left = truncateType(candidate.type);
  const right = truncateType(other.type);
  return {
    note: `${left} ≠ ${right}`,
    message:
      a === b
        ? `${left} cannot be joined to ${right}: they are different enumerated types.`
        : `${LABEL[a]} cannot be joined to ${LABEL[b]}. Pick columns of the same kind.`,
  };
}

// A column that cannot join anything, whatever the other side is.
export function unjoinableReason(column: ClassedColumn): string | null {
  return NOT_JOINABLE.has(column.class) ? `${truncateType(column.type)}: not joinable` : null;
}

// The note a menu row shows for `column` when the other side is `other` (or
// nothing picked yet); a non-null note means the row is greyed.
export function pairNote(column: ClassedColumn, other: ClassedColumn | undefined): string | null {
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
