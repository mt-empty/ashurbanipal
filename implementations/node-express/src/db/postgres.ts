import type { Pool, PoolClient } from "pg";
import { NotAllowedError, quoteIdent } from "../errors.js";
import { buildWhereClause } from "../filter.js";
import {
  type ColumnInfo,
  type ColumnRef,
  type CommonValueEntry,
  type CountEntry,
  cellToJson,
  type DbSource,
  findExact,
  type QueryOpts,
  type TableData,
  type TableInfo,
} from "./types.js";

/**
 * The default/reference `DbSource` — ported against
 * implementations/rust/src/db/postgres.rs (also cross-checked against
 * implementations/go-nethttp/catalog.go). Every query (catalog/metadata
 * included, not just row fetches) is bounded by the caller-supplied
 * timeoutMs, applied per-connection via `SET LOCAL statement_timeout`
 * inside a transaction so it never leaks onto a pooled connection reused
 * by another request.
 */
export class PostgresSource implements DbSource {
  constructor(private readonly pool: Pool) {}

  // Runs `fn` against a client with statement_timeout bounded for the
  // duration of this one query, inside its own transaction — SET LOCAL is
  // transaction-scoped, so this is the only way to bound a timeout
  // per-query without mutating the pooled connection's session state for
  // whichever request borrows it next.
  private async withTimeout<T>(timeoutMs: number, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
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

  // Excludes the catalogs themselves (`pg_catalog`, `information_schema`,
  // `pg_toast%`, `pg_temp_%`) and anything the connected role can't
  // actually use, so a schema only ever appears here if it's both a real
  // user namespace and one this role has USAGE on.
  private async allowedSchemas(client: PoolClient): Promise<string[]> {
    const { rows } = await client.query<{ nspname: string }>(
      `select nspname from pg_namespace
       where nspname not in ('pg_catalog', 'information_schema')
         and nspname not like 'pg_toast%'
         and nspname not like 'pg_temp\\_%' escape '\\'
         and has_schema_privilege(nspname, 'USAGE')
       order by nspname`,
    );
    return rows.map((r) => r.nspname);
  }

  // Resolves the schema for one operation exactly once: an explicit
  // request and an absent one (resolved via current_schema()) both go
  // through the same allow-list, so neither path can reach a schema the
  // other would reject (docs/adapter-decisions.md §1). Callers that run
  // more than one query per operation call this once inside their
  // withTimeout transaction, which pins the whole operation to one
  // physical connection — immune to pool sessions with divergent
  // search_path.
  private async resolveSchema(client: PoolClient, requested: string | undefined): Promise<string> {
    const schemas = await this.allowedSchemas(client);
    let resolved: string;
    if (requested !== undefined) {
      resolved = requested;
    } else {
      const { rows } = await client.query<{ current_schema: string }>("select current_schema()");
      resolved = rows[0].current_schema;
    }
    const real = findExact(schemas, resolved);
    if (!real) {
      throw new NotAllowedError(`schema "${resolved}"`);
    }
    return real;
  }

  private async allowedTables(client: PoolClient, schema: string): Promise<string[]> {
    const { rows } = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = $1 and table_type = 'BASE TABLE'
       order by table_name`,
      [schema],
    );
    return rows.map((r) => r.table_name);
  }

  private async allowedColumns(client: PoolClient, schema: string, table: string): Promise<string[]> {
    const { rows } = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = $1 and table_name = $2
       order by ordinal_position`,
      [schema, table],
    );
    return rows.map((r) => r.column_name);
  }

  // Returns the set of primary-key columns and a column -> ColumnRef map
  // for single-column foreign keys. Composite FKs are dropped entirely
  // rather than risk mislabeling which referencing column pairs with which
  // referenced column (spec/protocol.md §5.4.1); composite *primary* keys
  // are NOT dropped this way — every PK column still gets key="pk".
  //
  // The `ccu` join must match on `ccu.constraint_schema` (the schema the
  // constraint itself lives in, always equal to `tc.table_schema`), not
  // `ccu.table_schema` (the schema of the table constraint_column_usage is
  // describing — for a FOREIGN KEY row that's the *referenced* table's
  // schema, which for a cross-schema FK differs from the constraining
  // table's schema). Joining on `ccu.table_schema` instead silently drops
  // every cross-schema FK's metadata (the LEFT JOIN just never matches).
  private async keyMetadata(
    client: PoolClient,
    schema: string,
    table: string,
  ): Promise<{ pkColumns: Set<string>; fkColumns: Map<string, ColumnRef> }> {
    const { rows } = await client.query<{
      constraint_name: string;
      constraint_type: string;
      column_name: string;
      ref_schema: string | null;
      ref_table: string | null;
      ref_column: string | null;
    }>(
      `select tc.constraint_name, tc.constraint_type, kcu.column_name,
              ccu.table_schema as ref_schema, ccu.table_name as ref_table, ccu.column_name as ref_column
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name
        and kcu.table_schema = tc.table_schema
       left join information_schema.constraint_column_usage ccu
         on ccu.constraint_name = tc.constraint_name
        and ccu.constraint_schema = tc.table_schema
        and tc.constraint_type = 'FOREIGN KEY'
       where tc.table_schema = $1
         and tc.table_name = $2
         and tc.constraint_type in ('PRIMARY KEY', 'FOREIGN KEY')`,
      [schema, table],
    );

    const pkColumns = new Set<string>();
    const fkCandidates = new Map<
      string,
      { column: string; refSchema: string | null; refTable: string | null; refColumn: string | null }[]
    >();
    for (const row of rows) {
      if (row.constraint_type === "PRIMARY KEY") {
        pkColumns.add(row.column_name);
      } else if (row.constraint_type === "FOREIGN KEY") {
        const list = fkCandidates.get(row.constraint_name) ?? [];
        list.push({
          column: row.column_name,
          refSchema: row.ref_schema,
          refTable: row.ref_table,
          refColumn: row.ref_column,
        });
        fkCandidates.set(row.constraint_name, list);
      }
    }

    const fkColumns = new Map<string, ColumnRef>();
    for (const members of fkCandidates.values()) {
      const distinctColumns = new Set(members.map((m) => m.column));
      if (distinctColumns.size !== 1) continue; // composite FK: omit entirely
      const first = members[0];
      if (first.refSchema && first.refTable && first.refColumn) {
        // Same-schema is the overwhelming common case; omitting `schema`
        // there keeps the wire payload byte-identical to before this field
        // existed.
        const ref: ColumnRef = { table: first.refTable, column: first.refColumn };
        if (first.refSchema !== schema) ref.schema = first.refSchema;
        fkColumns.set(first.column, ref);
      }
    }
    return { pkColumns, fkColumns };
  }

  async listSchemas(timeoutMs: number): Promise<string[]> {
    return this.withTimeout(timeoutMs, (client) => this.allowedSchemas(client));
  }

  async listTables(schema: string | undefined, timeoutMs: number): Promise<TableInfo[]> {
    return this.withTimeout(timeoutMs, async (client) => {
      const realSchema = await this.resolveSchema(client, schema);
      const { rows } = await client.query<{ relname: string; comment: string | null }>(
        `select c.relname::text, obj_description(c.oid, 'pg_class') as comment
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = $1 and c.relkind = 'r'
         order by c.relname`,
        [realSchema],
      );
      return rows.map((r) => {
        const t: TableInfo = { name: r.relname };
        if (r.comment !== null) t.comment = r.comment;
        return t;
      });
    });
  }

  async tableCounts(schema: string | undefined, timeoutMs: number): Promise<CountEntry[]> {
    return this.withTimeout(timeoutMs, async (client) => {
      const realSchema = await this.resolveSchema(client, schema);
      const { rows } = await client.query<{ relname: string; reltuples: string }>(
        `select c.relname::text, c.reltuples::bigint::text as reltuples
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = $1 and c.relkind = 'r'
         order by c.relname`,
        [realSchema],
      );
      return rows.map((r) => ({ table: r.relname, approx_rows: Number(r.reltuples) }));
    });
  }

  async queryTable(schema: string | undefined, table: string, opts: QueryOpts, timeoutMs: number): Promise<TableData> {
    return this.withTimeout(timeoutMs, async (client) => {
      const realSchema = await this.resolveSchema(client, schema);
      const tables = await this.allowedTables(client, realSchema);
      const realTable = findExact(tables, table);
      if (!realTable) {
        throw new NotAllowedError(`table "${table}"`);
      }

      const columnNames = await this.allowedColumns(client, realSchema, realTable);

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
         where table_schema = $1 and table_name = $2
         order by ordinal_position`,
        [realSchema, realTable],
      );

      // Joins through pg_attribute/pg_class directly: col_description is
      // keyed by attnum, which can diverge from ordinal_position once a
      // column has been dropped.
      const { rows: commentRows } = await client.query<{ attname: string; comment: string | null }>(
        `select a.attname::text, col_description(a.attrelid, a.attnum::int) as comment
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = $1 and c.relname = $2
           and a.attnum > 0 and not a.attisdropped`,
        [realSchema, realTable],
      );
      const columnComments = new Map<string, string>();
      for (const row of commentRows) {
        if (row.comment !== null) columnComments.set(row.attname, row.comment);
      }

      const { pkColumns, fkColumns } = await this.keyMetadata(client, realSchema, realTable);

      const columns: ColumnInfo[] = columnTypeRows.map((ct) => {
        const col: ColumnInfo = { name: ct.column_name, type: ct.data_type };
        if (pkColumns.has(ct.column_name)) {
          col.key = "pk";
          if (fkColumns.has(ct.column_name)) col.references = fkColumns.get(ct.column_name);
        } else if (fkColumns.has(ct.column_name)) {
          col.key = "fk";
          col.references = fkColumns.get(ct.column_name);
        }
        const comment = columnComments.get(ct.column_name);
        if (comment !== undefined) col.comment = comment;
        return col;
      });

      const selectList = columns.map((col) => `${quoteIdent(col.name)}::text`).join(", ");

      // Table-qualified (by relation name, not schema — a FROM item's
      // correlation name is its own relation name regardless of whether
      // FROM itself is schema-qualified): an unqualified `order by "col"`
      // would resolve to the ::text-cast output column in selectList,
      // sorting lexicographically instead of by the real typed value.
      let orderClause = "";
      if (sort !== undefined) {
        const direction = opts.descending ? "desc" : "asc";
        orderClause = ` order by ${quoteIdent(realTable)}.${quoteIdent(sort)} ${direction}`;
      }

      // Identifiers spliced here are schema-validated (realSchema via
      // resolveSchema, realTable/columns via allowedTables/allowedColumns,
      // sort via the findExact check above, filter columns via
      // buildWhereClause's own allow-list check); every value is a bound
      // $N parameter.
      const query = `select ${selectList} from ${quoteIdent(realSchema)}.${quoteIdent(realTable)}${whereClause}${orderClause} limit $1 offset $2`;
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
         where n.nspname = $1 and c.relname = $2`,
        [realSchema, realTable],
      );
      const totalApprox = countRows.length > 0 ? Number(countRows[0].reltuples) : -1;

      return { columns, rows: outRows, total_approx: totalApprox };
    });
  }

  async commonValues(
    schema: string | undefined,
    table: string,
    column: string,
    timeoutMs: number,
  ): Promise<CommonValueEntry[]> {
    return this.withTimeout(timeoutMs, async (client) => {
      const realSchema = await this.resolveSchema(client, schema);
      const tables = await this.allowedTables(client, realSchema);
      const realTable = findExact(tables, table);
      if (!realTable) {
        throw new NotAllowedError(`table "${table}"`);
      }
      const columnNames = await this.allowedColumns(client, realSchema, realTable);
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
         where schemaname = $1 and tablename = $2 and attname = $3
         order by t.freq desc`,
        [realSchema, realTable, realColumn],
      );

      const { rows: typeRows } = await client.query<{ data_type: string }>(
        `select data_type from information_schema.columns
         where table_schema = $1 and table_name = $2 and column_name = $3`,
        [realSchema, realTable, realColumn],
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
