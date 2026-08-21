export interface ColumnRef {
  schema?: string;
  table: string;
  column: string;
}

export interface Column {
  name: string;
  type: string;
  key?: "pk" | "fk";
  comment?: string;
  references?: ColumnRef;
}

export interface Row {
  [column: string]: string | null;
}

export interface TableData {
  columns: Column[];
  rows: Row[];
  total_approx: number;
}

export interface FilterCondition {
  logic?: "AND" | "OR";
  not?: boolean;
  column: string;
  op: string;
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
  dbviewer_url: string;
  healthy: boolean;
}
