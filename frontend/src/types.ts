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
