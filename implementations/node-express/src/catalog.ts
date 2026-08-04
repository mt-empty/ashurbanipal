import type { Pool, PoolClient } from "pg";
import { buildWhereClause, type Condition } from "./filter.js";
import { NotAllowedError, quoteIdent } from "./errors.js";

export type KeyKind = "pk" | "fk";

export interface ColumnRef {
  table: string;
  column: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  key?: KeyKind;
  references?: ColumnRef;
  comment?: string;
}

export interface TableInfo {
  name: string;
  comment?: string;
}

export interface TableData {
  columns: ColumnInfo[];
  rows: Record<string, string | null>[];
  total_approx: number;
}

export interface CountEntry {
  table: string;
  approx_rows: number;
}

export interface CommonValueEntry {
  value: string;
  freq: number;
}

export interface QueryOpts {
  limit: number;
  offset: number;
  sort?: string;
  descending: boolean;
  filter: Condition[];
}

function findExact(haystack: string[], needle: string): string | undefined {
  return haystack.find((s) => s === needle);
}

// Every SELECTed column is already `::text`-cast in the query text itself
// (never decoded into a native JS type and reformatted — spec/protocol.md
// §5.4.3's cast-in-SQL requirement), so node-postgres always hands back a
// string or null for these columns. Anything else (a driver decode this
// port doesn't expect) falls back to the sentinel rather than throwing and
// aborting the whole row.
function cellToJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "<undecodable>";
}

/**
 * Catalog is the one seam to the database — route handlers never touch
 * `pg` directly. Every query (catalog/metadata included, not just row
 * fetches) is bounded by the same configured statement_timeout, applied
 * per-connection via `SET LOCAL statement_timeout` inside a transaction so
 * it never leaks onto a pooled connection reused by another request.
 */
export class Catalog {
  constructor(
    private readonly pool: Pool,
    private readonly queryTimeoutMs: number,
  ) {}

  // Runs `fn` against a client with statement_timeout bounded for the
  // duration of this one query, inside its own transaction — SET LOCAL is
  // transaction-scoped, so this is the only way to bound a timeout
  // per-query without mutating the pooled connection's session state for
  // whichever request borrows it next.
  private async withTimeout<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = ${this.queryTimeoutMs}`);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async allowedTables(client: PoolClient): Promise<string[]> {
    const { rows } = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = current_schema() and table_type = 'BASE TABLE'
       order by table_name`,
    );
    return rows.map((r) => r.table_name);
  }

  async allowedColumns(client: PoolClient, table: string): Promise<string[]> {
    const { rows } = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = current_schema() and table_name = $1
       order by ordinal_position`,
      [table],
    );
    return rows.map((r) => r.column_name);
  }

  // Returns the set of primary-key columns and a column -> ColumnRef map
  // for single-column foreign keys. Composite FKs are dropped entirely
  // rather than risk mislabeling which referencing column pairs with which
  // referenced column (spec/protocol.md §5.4.1); composite *primary* keys
  // are NOT dropped this way — every PK column still gets key="pk".
  private async keyMetadata(
    client: PoolClient,
    table: string,
  ): Promise<{ pkColumns: Set<string>; fkColumns: Map<string, ColumnRef> }> {
    const { rows } = await client.query<{
      constraint_name: string;
      constraint_type: string;
      column_name: string;
      ref_table: string | null;
      ref_column: string | null;
    }>(
      `select tc.constraint_name, tc.constraint_type, kcu.column_name,
              ccu.table_name as ref_table, ccu.column_name as ref_column
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name
        and kcu.table_schema = tc.table_schema
       left join information_schema.constraint_column_usage ccu
         on ccu.constraint_name = tc.constraint_name
        and ccu.table_schema = tc.table_schema
        and tc.constraint_type = 'FOREIGN KEY'
       where tc.table_schema = current_schema()
         and tc.table_name = $1
         and tc.constraint_type in ('PRIMARY KEY', 'FOREIGN KEY')`,
      [table],
    );

    const pkColumns = new Set<string>();
    const fkCandidates = new Map<
      string,
      { column: string; refTable: string | null; refColumn: string | null }[]
    >();
    for (const row of rows) {
      if (row.constraint_type === "PRIMARY KEY") {
        pkColumns.add(row.column_name);
      } else if (row.constraint_type === "FOREIGN KEY") {
        const list = fkCandidates.get(row.constraint_name) ?? [];
        list.push({ column: row.column_name, refTable: row.ref_table, refColumn: row.ref_column });
        fkCandidates.set(row.constraint_name, list);
      }
    }

    const fkColumns = new Map<string, ColumnRef>();
    for (const members of fkCandidates.values()) {
      const distinctColumns = new Set(members.map((m) => m.column));
      if (distinctColumns.size !== 1) continue; // composite FK: omit entirely
      const first = members[0];
      if (first.refTable && first.refColumn) {
        fkColumns.set(first.column, { table: first.refTable, column: first.refColumn });
      }
    }
    return { pkColumns, fkColumns };
  }

  /** Serves GET /api/tables. */
  async listTables(): Promise<TableInfo[]> {
    return this.withTimeout(async (client) => {
      const { rows } = await client.query<{ relname: string; comment: string | null }>(
        `select c.relname::text, obj_description(c.oid, 'pg_class') as comment
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = current_schema() and c.relkind = 'r'
         order by c.relname`,
      );
      return rows.map((r) => {
        const t: TableInfo = { name: r.relname };
        if (r.comment !== null) t.comment = r.comment;
        return t;
      });
    });
  }

  /** Serves GET /api/table-counts. */
  async tableCounts(): Promise<CountEntry[]> {
    return this.withTimeout(async (client) => {
      const { rows } = await client.query<{ relname: string; reltuples: string }>(
        `select c.relname::text, c.reltuples::bigint::text as reltuples
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = current_schema() and c.relkind = 'r'
         order by c.relname`,
      );
      return rows.map((r) => ({ table: r.relname, approx_rows: Number(r.reltuples) }));
    });
  }

  /** Serves GET /api/tables/data: validates table/sort/filter columns against the live schema, then runs one parameterized SELECT. */
  async queryTable(table: string, opts: QueryOpts): Promise<TableData> {
    return this.withTimeout(async (client) => {
      const tables = await this.allowedTables(client);
      const realTable = findExact(tables, table);
      if (!realTable) {
        throw new NotAllowedError(`table "${table}"`);
      }

      const columnNames = await this.allowedColumns(client, realTable);

      let sort: string | undefined;
      if (opts.sort !== undefined) {
        sort = findExact(columnNames, opts.sort);
        if (!sort) {
          throw new NotAllowedError(`column "${opts.sort}"`);
        }
      }

      let whereClause = "";
      let filterValues: string[] = [];
      if (opts.filter.length > 0) {
        const built = buildWhereClause(opts.filter, columnNames, 3);
        whereClause = built.where;
        filterValues = built.values;
      }

      const { rows: columnTypeRows } = await client.query<{ column_name: string; data_type: string }>(
        `select column_name, data_type from information_schema.columns
         where table_schema = current_schema() and table_name = $1
         order by ordinal_position`,
        [realTable],
      );

      // Joins through pg_attribute/pg_class directly: col_description is
      // keyed by attnum, which can diverge from ordinal_position once a
      // column has been dropped.
      const { rows: commentRows } = await client.query<{ attname: string; comment: string | null }>(
        `select a.attname::text, col_description(a.attrelid, a.attnum::int) as comment
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = current_schema() and c.relname = $1
           and a.attnum > 0 and not a.attisdropped`,
        [realTable],
      );
      const columnComments = new Map<string, string>();
      for (const row of commentRows) {
        if (row.comment !== null) columnComments.set(row.attname, row.comment);
      }

      const { pkColumns, fkColumns } = await this.keyMetadata(client, realTable);

      const columns: ColumnInfo[] = columnTypeRows.map((ct) => {
        const col: ColumnInfo = { name: ct.column_name, type: ct.data_type };
        if (pkColumns.has(ct.column_name)) {
          col.key = "pk";
        } else if (fkColumns.has(ct.column_name)) {
          col.key = "fk";
          col.references = fkColumns.get(ct.column_name);
        }
        const comment = columnComments.get(ct.column_name);
        if (comment !== undefined) col.comment = comment;
        return col;
      });

      const selectList = columns.map((col) => `${quoteIdent(col.name)}::text`).join(", ");

      // Table-qualified: an unqualified `order by "col"` would resolve to
      // the ::text-cast output column in selectList, sorting
      // lexicographically instead of by the real typed value.
      let orderClause = "";
      if (sort !== undefined) {
        const direction = opts.descending ? "desc" : "asc";
        orderClause = ` order by ${quoteIdent(realTable)}.${quoteIdent(sort)} ${direction}`;
      }

      // Identifiers spliced here are schema-validated (realTable/columns
      // via allowedTables/allowedColumns, sort via the findExact check
      // above, filter columns via buildWhereClause's own allow-list
      // check); every value is a bound $N parameter.
      const query = `select ${selectList} from ${quoteIdent(realTable)}${whereClause}${orderClause} limit $1 offset $2`;
      const args: unknown[] = [opts.limit, opts.offset, ...filterValues];

      const { rows: dataRows } = await client.query(query, args);
      const outRows: Record<string, string | null>[] = dataRows.map((row: Record<string, unknown>) => {
        const out: Record<string, string | null> = {};
        for (const col of columns) {
          out[col.name] = cellToJson(row[col.name]);
        }
        return out;
      });

      const { rows: countRows } = await client.query<{ reltuples: string }>(
        `select reltuples::bigint::text as reltuples from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = current_schema() and c.relname = $1`,
        [realTable],
      );
      const totalApprox = countRows.length > 0 ? Number(countRows[0].reltuples) : -1;

      return { columns, rows: outRows, total_approx: totalApprox };
    });
  }

  /** Serves GET /api/tables/common-values. */
  async commonValues(table: string, column: string): Promise<CommonValueEntry[]> {
    return this.withTimeout(async (client) => {
      const tables = await this.allowedTables(client);
      const realTable = findExact(tables, table);
      if (!realTable) {
        throw new NotAllowedError(`table "${table}"`);
      }
      const columnNames = await this.allowedColumns(client, realTable);
      const realColumn = findExact(columnNames, column);
      if (!realColumn) {
        throw new NotAllowedError(`column "${column}"`);
      }

      // most_common_vals is anyarray; ::text::text[] reads it uniformly.
      // NULL (no ANALYZE stats yet) unnests to zero rows, not an error.
      const { rows } = await client.query<{ val: string; freq: number }>(
        `select t.val, t.freq
         from pg_stats,
              lateral unnest(most_common_vals::text::text[], most_common_freqs) as t(val, freq)
         where schemaname = current_schema() and tablename = $1 and attname = $2
         order by t.freq desc`,
        [realTable, realColumn],
      );

      const { rows: typeRows } = await client.query<{ data_type: string }>(
        `select data_type from information_schema.columns
         where table_schema = current_schema() and table_name = $1 and column_name = $2`,
        [realTable, realColumn],
      );
      const isBoolean = typeRows.length > 0 && typeRows[0].data_type === "boolean";

      // boolean's array-literal text form is "t"/"f", not "true"/"false" —
      // normalize to match queryTable's rendering.
      return rows.map((r) => {
        let value = r.val;
        if (isBoolean) {
          if (value === "t") value = "true";
          else if (value === "f") value = "false";
        }
        return { value, freq: r.freq };
      });
    });
  }
}
