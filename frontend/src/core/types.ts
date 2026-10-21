export interface ColumnRef {
  schema?: string;
  table: string;
  column: string;
}

interface ColumnBase {
  name: string;
  type: string;
  comment?: string;
  // Join responses only (spec/protocol.md §5.11.4): `name` is a unique label;
  // these locate the column. Never parse the label.
  join?: number;
  table?: string;
  column?: string;
}

// spec/openapi.yaml ColumnInfo: `references` is present exactly when the
// column is a foreign key, independent of `key` — a column that is both its
// table's primary key and a foreign key reports `key: "pk"` but still carries
// `references`. So an `fk` column always has it; a `pk` column may.
export type Column =
  | (ColumnBase & { key?: undefined; references?: undefined })
  | (ColumnBase & { key: "pk"; references?: ColumnRef })
  | (ColumnBase & { key: "fk"; references: ColumnRef });

export interface Row {
  [column: string]: string | null;
}

export interface ViewData {
  columns: Column[];
  rows: Row[];
  // /tables/data carries total_approx, /tables/join carries has_more (§5.11.4).
  total_approx?: number;
  has_more?: boolean;
}

// spec/openapi.yaml StructureResponse (§5.10): one table's indexes and
// whole-object constraints. FK `schema` is the *referenced* table's schema,
// present only when it differs from the resolved one.
export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  method: string;
  predicate?: string;
}

export interface ConstraintFk {
  name: string;
  table: string;
  schema?: string;
  columns: ColumnPair[];
  on_delete: string;
  on_update: string;
}

export interface StructureResponse {
  indexes: IndexInfo[];
  constraints: {
    primary_key?: { name?: string; columns: string[] };
    unique: { name: string; columns: string[] }[];
    foreign_keys: ConstraintFk[];
    check: { name: string; expression?: string }[];
  };
}

export type FilterOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "LIKE" | "ILIKE" | "IS NULL" | "IS NOT NULL";

export interface FilterCondition {
  logic?: "AND" | "OR";
  not?: boolean;
  // Table position in a join view (spec/protocol.md §5.11.3); absent otherwise.
  join?: number;
  column: string;
  op: FilterOp;
  value?: string;
}

export interface CommonValue {
  value: string;
  freq: number;
}

// spec/openapi.yaml ReferencedByResponse (§5.9): one entry per FK constraint
// elsewhere that targets the viewed table. `columns` is paired {from,to}, not
// two parallel arrays. `schema` is the *referencing* table's schema, present
// only when it differs from the resolved one — the opposite end of the arrow
// from ColumnRef.schema. `constraint` may be engine-synthesized.
export interface ColumnPair {
  from: string;
  to: string;
}
export interface ReferencedByEntry {
  table: string;
  schema?: string;
  constraint: string;
  columns: ColumnPair[];
}

export interface TableListEntry {
  name: string;
  comment?: string;
}

export interface SourceEntry {
  name: string;
}

export interface Sibling {
  name: string;
  label?: string;
  base_url: string;
  healthy: boolean;
}

// Labels are opaque host strings (spec/protocol.md §5.6): compared for
// equality, never parsed.
export interface SiblingInstance {
  name: string;
  label: string;
}

export interface SiblingsResponse {
  instance?: SiblingInstance;
  siblings: Sibling[];
}

// A name the page URL asked for that this instance lacks, and what the page
// showed instead; `got` is null when nothing replaced it (a dropped filter,
// or a schema with no tables).
export type SwapKind = "source" | "schema" | "table" | "filter";
export interface Swap {
  kind: SwapKind;
  asked: string;
  got: string | null;
}

// ---- Join (spec/join-dsl.md §3, spec/protocol.md §5.11) ----

export type JoinType = "inner" | "left";

export interface JoinTable {
  table: string;
  alias: string | null;
}

export interface JoinPair {
  left: { join: number; column: string };
  right: string;
}

export interface JoinClause {
  type: JoinType;
  on: JoinPair[];
}

export type JoinColumn = { join: number; column: string } | { join: number; all: true };

// The one object the join text, the form and the request all view.
export interface JoinDef {
  tables: JoinTable[];
  joins: JoinClause[];
  columns: JoinColumn[] | null;
}

// What the page shows. A table view is the only one with a single table that
// per-table requests (structure, common values, referenced-by) can name.
export interface TableView {
  readonly kind: "table";
  readonly table: string;
}
export interface JoinView {
  readonly kind: "join";
  readonly def: JoinDef;
  // Canonical text (spec/join-dsl.md §3); it rides in the URL, never in localStorage.
  readonly text: string;
  // Not persisted: kept while the same join stays in view.
  readonly hidden: readonly string[];
}
export type View = TableView | JoinView;

export interface WireJoin {
  table: string;
  joins: { type: JoinType; table: string; on: JoinPair[] }[];
  columns?: { join: number; column: string }[];
}
