export interface ColumnRef {
  schema?: string;
  table: string;
  column: string;
}

// spec/protocol.md §5.4.1, §5.11.2: the server's class for a column, the one it
// checks join pairs with. `float`, `json`, `array` and `other` cannot be joined.
export type ColumnClass =
  | "number"
  | "text"
  | "uuid"
  | "boolean"
  | "temporal"
  | "time"
  | "binary"
  | "enum"
  | "untyped"
  | "float"
  | "json"
  | "array"
  | "other";

interface ColumnBase {
  name: string;
  type: string;
  class: ColumnClass;
  // The enumerated type's identity; set only when class is "enum".
  enum_type?: string;
  // The collation where two text columns can clash (spec/protocol.md §5.4.1).
  collation?: string;
  comment?: string;
  // Join responses only (spec/protocol.md §5.11.4): `name` is a unique label;
  // these locate the column. Never parse the label. `schema` is present only
  // when the table is outside the request's schema.
  join?: number;
  schema?: string;
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

/** The part of a column that decides its column class and display bucket. */
export type ClassedColumn = Pick<Column, "type" | "class" | "enum_type" | "collation">;

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

/** `default` is the source an absent `source` param resolves to (spec/protocol.md §5.8). */
export interface SourcesResponse {
  sources: SourceEntry[];
  default: string;
}

/** `default` is what an absent `schema` param resolves to; null when the connection has none (spec/protocol.md §5.7). */
export interface SchemasResponse {
  schemas: { name: string }[];
  default: string | null;
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
  // Config mistakes the server corrected; human-readable, never parsed.
  warnings?: string[];
}

// A name the page URL asked for that this instance lacks, and what the page
// showed instead; `got` is null when nothing replaced it (a dropped filter,
// or a schema with no tables).
export type SwapKind = "source" | "schema" | "table" | "filter";
export type UrlIntent = Partial<Record<SwapKind, string>>;
export interface Swap {
  kind: SwapKind;
  asked: string;
  got: string | null;
}

// ---- Join (spec/join-dsl.md §3, spec/protocol.md §5.11) ----

export type JoinType = "inner" | "left";

export interface JoinTable {
  // Present only when the text names one; absent means the scope's schema.
  schema?: string;
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

// What the page shows. A table view names one table; a join view's per-table
// requests (structure, common values, referenced-by) name each of its tables.
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
  schema?: string;
  joins: { type: JoinType; table: string; schema?: string; on: JoinPair[] }[];
  columns?: { join: number; column: string }[];
}

// Where a table lives. Built only by lib/table-ref.ts (and refInScope in
// core/store.ts), so a function that takes one cannot be handed a bare name
// that silently means "the current scope". A null name is the server's
// default, sent only when the scope's lists failed to load.
declare const schemaRefBrand: unique symbol;
declare const tableRefBrand: unique symbol;
export interface SchemaRef {
  readonly source: string | null;
  readonly schema: string | null;
  readonly [schemaRefBrand]: true;
}
export interface TableRef extends SchemaRef {
  readonly table: string;
  readonly [tableRefBrand]: true;
}

// The source and schema every scoped request runs in. Per-scope memory (sort,
// hidden columns, widths, saved joins) is keyed by the `known` names only.
export type Scope =
  // Names to try, from storage, the URL or a switch; not yet checked against the lists.
  | { readonly kind: "loading"; readonly source: string | null; readonly schema: string | null }
  | { readonly kind: "known"; readonly source: string; readonly schema: string }
  // A list lookup failed; requests send only the names that did resolve.
  | { readonly kind: "failed"; readonly source: string | null; readonly schema: string | null };
