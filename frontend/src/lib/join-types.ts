import type { Column } from "../core/types.js";

// ==== Join type hints (spec/protocol.md §5.11.2) ====
// Which column types a join can pair, so the form can grey the ones that
// cannot. Only a hint: the page does not know the engine, so native type
// names are matched across Postgres, MySQL/MariaDB and SQLite together, and
// a type this table does not know is allowed. The server is the authority.

type JoinClass = "number" | "text" | "uuid" | "boolean" | "temporal" | "time" | "binary" | "enum" | "custom";

const CLASS_OF: Record<string, JoinClass> = {};
function assign(cls: JoinClass, names: string): void {
  for (const n of names.split(",")) CLASS_OF[n] = cls;
}
assign("number", "smallint,integer,bigint,int,int2,int4,int8,tinyint,mediumint,numeric,decimal");
assign("text", "character varying,character,char,varchar,text,tinytext,mediumtext,longtext,citext,clob");
assign("uuid", "uuid");
assign("boolean", "boolean,bool");
assign("temporal", "date,datetime,timestamp,timestamp without time zone,timestamp with time zone");
assign("time", "time,time without time zone,time with time zone");
assign("binary", "bytea,binary,varbinary,tinyblob,blob,mediumblob,longblob");
assign("enum", "enum");
// Postgres reports every enum (and citext) as USER-DEFINED; the page cannot tell which.
assign("custom", "user-defined");

const NOT_JOINABLE = new Set([
  "json",
  "jsonb",
  "array",
  "real",
  "double precision",
  "float",
  "double",
  "money",
  "interval",
  "set",
  "bit",
  "year",
  "inet",
]);

const LABEL: Record<JoinClass, string> = {
  number: "number",
  text: "text",
  uuid: "uuid",
  boolean: "boolean",
  temporal: "date/time",
  time: "time",
  binary: "binary",
  enum: "enum",
  // Postgres reports an enum (or citext) as USER-DEFINED, and an enum is far the likelier.
  custom: "enum",
};

function classOf(type: string): JoinClass | "none" | null {
  const t = type.toLowerCase();
  if (NOT_JOINABLE.has(t) || t.endsWith("[]")) return "none";
  return CLASS_OF[t] ?? null;
}

const shown = (type: string): string => (type.toLowerCase() === "user-defined" ? "enum" : type);

export interface JoinMismatch {
  // Short, for a menu row: `text ≠ uuid`, `jsonb: not joinable`.
  note: string;
  // A sentence for under the pair.
  message: string;
}

// Why a column of type `candidate` cannot pair with one of type `other`, or null
// when it can or the page cannot tell.
export function joinMismatch(candidate: string, other: string): JoinMismatch | null {
  const a = classOf(candidate);
  const b = classOf(other);
  if (a === "none" || b === "none") {
    const type = shown(a === "none" ? candidate : other);
    return { note: `${type}: not joinable`, message: `${type} columns cannot be joined. Pick another column.` };
  }
  if (a === null || b === null || a === b) return null;
  // A custom type may be citext, which pairs with text.
  if ((a === "custom" && b === "text") || (a === "text" && b === "custom")) return null;
  return {
    note: `${shown(candidate)} ≠ ${shown(other)}`,
    message: `${LABEL[a]} cannot be joined to ${LABEL[b]}. Pick columns of the same kind.`,
  };
}

// A column that cannot join anything, whatever the other side is.
export function unjoinableReason(type: string): string | null {
  return classOf(type) === "none" ? `${shown(type)}: not joinable` : null;
}

// The note a menu row shows for a column of `type` when the other side has
// `otherType` (or nothing picked yet); a non-null note means the row is greyed.
export function pairNote(type: string, otherType: string | undefined): string | null {
  return otherType === undefined ? unjoinableReason(type) : (joinMismatch(type, otherType)?.note ?? null);
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
