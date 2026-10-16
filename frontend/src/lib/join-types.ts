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
  custom: "custom type",
};

function classOf(type: string): JoinClass | "none" | null {
  const t = type.toLowerCase();
  if (NOT_JOINABLE.has(t) || t.endsWith("[]")) return "none";
  return CLASS_OF[t] ?? null;
}

// Why a column of type `candidate` cannot pair with one of type `other`, or null
// when it can or the page cannot tell.
export function joinBlocker(candidate: string, other: string): string | null {
  const a = classOf(candidate);
  const b = classOf(other);
  if (a === "none") return `${candidate}: not joinable`;
  if (b === "none") return `${other}: not joinable`;
  if (a === null || b === null || a === b) return null;
  // A custom type may be citext, which pairs with text.
  if ((a === "custom" && b === "text") || (a === "text" && b === "custom")) return null;
  return `${LABEL[a]} ≠ ${LABEL[b]}`;
}

// A column that cannot join anything, whatever the other side is.
export function unjoinableReason(type: string): string | null {
  return classOf(type) === "none" ? `${type}: not joinable` : null;
}
