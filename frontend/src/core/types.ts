export interface ColumnRef {
  schema?: string;
  table: string;
  column: string;
}

interface ColumnBase {
  name: string;
  type: string;
  comment?: string;
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

export interface TableData {
  columns: Column[];
  rows: Row[];
  total_approx: number;
}

export type FilterOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "LIKE" | "ILIKE" | "IS NULL" | "IS NOT NULL";

export interface FilterCondition {
  logic?: "AND" | "OR";
  not?: boolean;
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
  base_url: string;
  healthy: boolean;
}
