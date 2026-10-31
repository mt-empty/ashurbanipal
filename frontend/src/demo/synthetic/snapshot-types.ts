// The synthetic demo's data: what node-express's PostgresSource answered for
// the seeded sources at build time (build/snapshot.ts), served without a database.
import type {
  ColumnInfo,
  CommonValueEntry,
  ReferencedByEntry,
  Structure,
  TableInfo,
} from "../../../../implementations/node-express/src/db/types.js";

export interface SnapshotTable {
  columns: ColumnInfo[];
  /** The first rows by primary key, cells in `columns` order. */
  rows: (string | null)[][];
  /** The backend's estimate, clamped to `rows.length`; -1 when it had none. */
  approxRows: number;
  structure: Structure;
  referencedBy: ReferencedByEntry[];
  commonValues: Record<string, CommonValueEntry[]>;
}

export interface SnapshotSource {
  name: string;
  schemas: string[];
  defaultSchema: string | null;
  bySchema: Record<string, { tables: TableInfo[]; tableData: Record<string, SnapshotTable> }>;
}

export interface Snapshot {
  /** In /api/sources order; the first is the default. */
  sources: SnapshotSource[];
}
