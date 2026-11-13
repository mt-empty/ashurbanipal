import type { Pool, PoolClient } from "pg";
import { assertSafeTimeoutMs, mapSelectDenied, NotAllowedError, quoteIdent } from "../errors.js";
import { buildWhereClause } from "../filter.js";
import {
  buildJoinSelect,
  type ColMeta,
  type ColumnClass,
  columnInfo,
  groupUniqueKeys,
  type JoinData,
  type JoinDialect,
  type JoinOpts,
  type JoinSpec,
  joinColumnInfos,
  joinRows,
  joinTableRefs,
  planJoin,
  type TableMeta,
  tableOrderClause,
  tableSchemas,
  tieBreakKeys,
  type UniqueKey,
  unknownJoinTable,
} from "../join.js";
import {
  type ColumnInfo,
  type ColumnRef,
  type CommonValueEntry,
  type CountEntry,
  cellToJson,
  type DbSource,
  emptyStructure,
  findExact,
  groupReferencedBy,
  type QueryOpts,
  type ReferencedByEntry,
  type SchemaListing,
  type Structure,
  schemaListing,
  type TableData,
  type TableInfo,
} from "./types.js";

const JOIN_DIALECT: JoinDialect = {
  quote: quoteIdent,
  castText: (expr) => `${expr}::text`,
  numbered: true,
  ilike: "native",
};

/** `spec/protocol.md` §5.11.2; the mapping is in `docs/adapter-decisions.md` §5.11. */
export function pgColumnClass(dataType: string, udtSchema: string, udtName: string, isEnum: boolean): ColumnClass {
  switch (dataType) {
    case "smallint":
    case "integer":
    case "bigint":
    case "numeric":
      return { kind: "number" };
    case "character varying":
    case "character":
    case "text":
      return { kind: "text" };
    case "uuid":
      return { kind: "uuid" };
    case "boolean":
      return { kind: "boolean" };
    case "bytea":
      return { kind: "binary" };
    case "date":
    case "timestamp without time zone":
    case "timestamp with time zone":
      return { kind: "temporal" };
    case "time without time zone":
    case "time with time zone":
      return { kind: "time" };
    case "real":
    case "double precision":
      return { kind: "float" };
    case "json":
    case "jsonb":
      return { kind: "json" };
    case "ARRAY":
      return { kind: "array" };
    case "USER-DEFINED":
      if (isEnum) return { kind: "enum", enumType: `${udtSchema}.${udtName}` };
      if (udtName === "citext") return { kind: "text" };
      return { kind: "other" };
    default:
      return { kind: "other" };
  }
}

/** Postgres `DbSource`; `SET LOCAL` scopes query timeouts (`spec/protocol.md` §6). */
export class PostgresSource implements DbSource {
  readonly engine = "postgres";
  constructor(private readonly pool: Pool) {}

  // `SET LOCAL` prevents timeout settings leaking through the connection pool.
  private async withTimeout<T>(timeoutMs: number, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    assertSafeTimeoutMs(timeoutMs);
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

  // Null when no schema on the session's search_path exists.
  private async defaultSchema(client: PoolClient): Promise<string | null> {
    const { rows } = await client.query<{ current_schema: string | null }>("select current_schema()");
    return rows[0].current_schema;
  }

  // Resolve inside the operation transaction to prevent pool-session drift
  // (spec/protocol.md §5).
  private async resolveSchema(client: PoolClient, requested: string | undefined): Promise<string> {
    return this.resolveSchemaAmong(client, await this.allowedSchemas(client), requested);
  }

  // resolveSchema against a schema list already fetched in this transaction.
  private async resolveSchemaAmong(
    client: PoolClient,
    schemas: string[],
    requested: string | undefined,
  ): Promise<string> {
    let resolved: string;
    if (requested !== undefined) {
      resolved = requested;
    } else {
      const defaultSchema = await this.defaultSchema(client);
      if (defaultSchema === null) {
        throw new NotAllowedError("no schema requested and this connection has no default schema", "schema");
      }
      resolved = defaultSchema;
    }
    const real = findExact(schemas, resolved);
    if (!real) {
      throw new NotAllowedError(`schema "${resolved}"`, "schema");
    }
    return real;
  }

  // Resolves table to its OID iff it's a readable base table in schema —
  // the single existence-and-privilege check every table-scoped operation
  // needs before touching request-supplied SQL. Mirrors listTables' own
  // pg_class/relkind = 'r' predicate, not information_schema.tables'
  // broader BASE TABLE (which also matches partitioned tables) — keeps
  // this gate and listTables in lockstep (docs/adapter-decisions.md
  // §5.2/§5.3). One targeted row instead of fetching every table name in
  // the schema to check membership of one.
  private async readableTableOid(client: PoolClient, schema: string, table: string): Promise<number> {
    // Postgres text can never hold a NUL byte, so no real relname could ever
    // match one; short-circuit before it reaches the driver, which otherwise
    // throws its own encoding error ahead of the query ever getting a chance
    // to just say "no match" (spec/protocol.md §5.2).
    if (table.includes("\0")) {
      throw new NotAllowedError(`table "${table}"`, "table");
    }
    const { rows } = await client.query<{ oid: number }>(
      `select c.oid::int4 as oid from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relname = $2 and c.relkind = 'r'
         and has_table_privilege(c.oid, 'SELECT')`,
      [schema, table],
    );
    if (rows.length === 0) {
      throw new NotAllowedError(`table "${table}"`, "table");
    }
    return rows[0].oid;
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

  // pg_constraint has no privilege filter, so a role that doesn't own the
  // table still sees its keys. Composite foreign keys, and ones whose target
  // the role can't open, are left out (spec/protocol.md §5.4.1).
  private async keyMetadata(
    client: PoolClient,
    schema: string,
    oid: number,
  ): Promise<{ pkColumns: Set<string>; fkColumns: Map<string, ColumnRef> }> {
    const { rows } = await client.query<{
      is_pk: boolean;
      column_name: string;
      ref_schema: string | null;
      ref_table: string | null;
      ref_column: string | null;
    }>(
      `select con.contype = 'p' as is_pk, a.attname::text as column_name,
              rn.nspname::text as ref_schema, rc.relname::text as ref_table,
              ra.attname::text as ref_column
       from pg_constraint con
       cross join lateral unnest(con.conkey) k(attnum)
       join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
       left join pg_class rc on con.contype = 'f' and rc.oid = con.confrelid
       left join pg_namespace rn on rn.oid = rc.relnamespace
       left join pg_attribute ra on ra.attrelid = rc.oid and ra.attnum = con.confkey[1]
       where con.conrelid = $1
         and (con.contype = 'p'
              or (con.contype = 'f' and cardinality(con.conkey) = 1 and rc.relkind = 'r'
                  and has_schema_privilege(rc.relnamespace, 'USAGE') and has_table_privilege(rc.oid, 'SELECT')))`,
      [oid],
    );

    const pkColumns = new Set<string>();
    const fkColumns = new Map<string, ColumnRef>();
    for (const row of rows) {
      if (row.is_pk) {
        pkColumns.add(row.column_name);
      } else if (row.ref_schema && row.ref_table && row.ref_column) {
        // Same-schema references omit `schema` on the wire (spec/protocol.md §5.4.1).
        const ref: ColumnRef = { table: row.ref_table, column: row.ref_column };
        if (row.ref_schema !== schema) ref.schema = row.ref_schema;
        fkColumns.set(row.column_name, ref);
      }
    }
    return { pkColumns, fkColumns };
  }

  async listSchemas(timeoutMs: number): Promise<SchemaListing> {
    return this.withTimeout(timeoutMs, async (client) =>
      schemaListing(await this.allowedSchemas(client), await this.defaultSchema(client)),
    );
  }

  async listTables(schema: string | undefined, timeoutMs: number): Promise<TableInfo[]> {
    return this.withTimeout(timeoutMs, async (client) => {
      const realSchema = await this.resolveSchema(client, schema);
      const { rows } = await client.query<{ relname: string; comment: string | null }>(
        `select c.relname::text, obj_description(c.oid, 'pg_class') as comment
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = $1 and c.relkind = 'r'
           and has_table_privilege(c.oid, 'SELECT')
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
           and has_table_privilege(c.oid, 'SELECT')
         order by c.relname`,
        [realSchema],
      );
      return rows.map((r) => ({ table: r.relname, approx_rows: Number(r.reltuples) }));
    });
  }

  // Column metadata of a table already cleared by readableTableOid, which supplies `oid`.
  private async tableMeta(client: PoolClient, schema: string, table: string, oid: number): Promise<TableMeta> {
    const { rows } = await client.query<{
      column_name: string;
      data_type: string;
      udt_schema: string;
      udt_name: string;
      is_enum: boolean;
      full_type: string;
      comment: string | null;
      collation: string | null;
    }>(
      // information_schema.columns drives the list (column privileges, order);
      // pg_attribute adds the full type spelling, comment and collation, keyed
      // by attnum, which can diverge from ordinal_position after a drop. The
      // default collation (oid 100) is left out: it yields to an explicit one
      // in a comparison, so it never clashes.
      `select c.column_name, c.data_type, c.udt_schema, c.udt_name,
              exists (select 1 from pg_type t
                      join pg_namespace n on n.oid = t.typnamespace
                      where n.nspname = c.udt_schema and t.typname = c.udt_name
                        and t.typtype = 'e') as is_enum,
              format_type(a.atttypid, a.atttypmod) as full_type,
              col_description(a.attrelid, a.attnum::int) as comment,
              (select case when n.nspname = 'pg_catalog' then co.collname
                           else n.nspname || '.' || co.collname end
                 from pg_collation co
                 join pg_namespace n on n.oid = co.collnamespace
                where co.oid = a.attcollation and a.attcollation not in (0, 100)) as collation
       from information_schema.columns c
       join pg_attribute a on a.attrelid = $3 and a.attname = c.column_name
       where c.table_schema = $1 and c.table_name = $2
       order by c.ordinal_position`,
      [schema, table, oid],
    );
    const { pkColumns, fkColumns } = await this.keyMetadata(client, schema, oid);
    const columns = rows.map((r): ColMeta => {
      const col: ColMeta = {
        name: r.column_name,
        type: r.full_type,
        class: pgColumnClass(r.data_type, r.udt_schema, r.udt_name, r.is_enum),
      };
      if (r.collation) col.collation = r.collation;
      if (pkColumns.has(r.column_name)) {
        col.key = "pk";
        if (fkColumns.has(r.column_name)) col.references = fkColumns.get(r.column_name);
      } else if (fkColumns.has(r.column_name)) {
        col.key = "fk";
        col.references = fkColumns.get(r.column_name);
      }
      if (r.comment !== null) col.comment = r.comment;
      return col;
    });
    const orderKeys = tieBreakKeys(columns, await this.uniqueKeys(client, oid));
    return { schema, name: table, columns, orderKeys };
  }

  // The primary key and every unique index that can break ties: plain key
  // columns (INCLUDE columns left out), not partial, all NOT NULL, and each in
  // its column's own collation, so the key is unique under the order by.
  // pg_index has no privilege filter, unlike information_schema, so a role
  // with only SELECT still sees the key.
  private async uniqueKeys(client: PoolClient, oid: number): Promise<UniqueKey[]> {
    const { rows } = await client.query<{ index: string; primary: boolean; column: string; usable: boolean }>(
      `select c.relname as index, i.indisprimary as primary, a.attname as column,
              a.attnotnull and i.indcollation[k.n::int - 1] = a.attcollation as usable
       from pg_index i
       join pg_class c on c.oid = i.indexrelid
       cross join lateral unnest(i.indkey::int2[]) with ordinality k(attnum, n)
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
       where i.indrelid = $1 and i.indisunique and i.indisvalid
         and i.indpred is null and i.indexprs is null and k.n <= i.indnkeyatts
       order by c.relname, k.n`,
      [oid],
    );
    return groupUniqueKeys(rows.map((r) => ({ ...r, usable: r.primary || r.usable })));
  }

  async queryJoin(schema: string | undefined, spec: JoinSpec, opts: JoinOpts, timeoutMs: number): Promise<JoinData> {
    return this.withTimeout(timeoutMs, async (client) => {
      const listed = await this.allowedSchemas(client);
      const realSchema = await this.resolveSchemaAmong(client, listed, schema);
      const refs = joinTableRefs(spec);
      const schemas = tableSchemas(refs, realSchema, listed);
      const metas = new Map<string, TableMeta>();
      const tables: TableMeta[] = [];
      for (const [i, { table }] of refs.entries()) {
        const key = JSON.stringify([schemas[i], table]);
        if (!metas.has(key)) {
          try {
            const oid = await this.readableTableOid(client, schemas[i], table);
            metas.set(key, await this.tableMeta(client, schemas[i], table, oid));
          } catch (err) {
            throw unknownJoinTable(err, table);
          }
        }
        tables.push(metas.get(key) as TableMeta);
      }
      const plan = planJoin(spec, tables, opts);

      // The statement is built from catalog names and generated aliases
      // only; every value is a bound $N parameter.
      const { body, values } = buildJoinSelect(plan, JOIN_DIALECT);
      const { rows } = await client
        .query(`select ${body}`, [opts.limit + 1, opts.offset, ...values])
        .catch((err: unknown) => {
          throw mapSelectDenied(err, spec.table, opts.sort);
        });
      const out = joinRows(plan, rows as Record<string, unknown>[], opts.limit, cellToJson);
      return { columns: joinColumnInfos(plan, realSchema), rows: out.rows, has_more: out.hasMore };
    });
  }

  async queryTable(schema: string | undefined, table: string, opts: QueryOpts, timeoutMs: number): Promise<TableData> {
    return this.withTimeout(timeoutMs, async (client) => {
      const realSchema = await this.resolveSchema(client, schema);
      const oid = await this.readableTableOid(client, realSchema, table);
      const realTable = table;

      // The join route's lookup, so both routes report the same columns; its
      // names are the live catalog's, so they also serve as the allow-list.
      const meta = await this.tableMeta(client, realSchema, realTable, oid);
      const columns: ColumnInfo[] = meta.columns.map(columnInfo);
      const columnNames = columns.map((c) => c.name);

      let sort: string | undefined;
      if (opts.sort !== undefined) {
        sort = findExact(columnNames, opts.sort);
        if (!sort) {
          throw new NotAllowedError(`column "${opts.sort}"`, "column");
        }
      }

      let whereClause = "";
      let filterValues: string[] = [];
      if (opts.filter.length > 0) {
        const built = buildWhereClause(opts.filter, columnNames, 3);
        whereClause = built.where;
        filterValues = built.values;
      }

      const selectList = columns.map((col) => `${quoteIdent(col.name)}::text`).join(", ");

      // Table-qualified (by relation name, not schema — a FROM item's
      // correlation name is its own relation name regardless of whether
      // FROM itself is schema-qualified): an unqualified `order by "col"`
      // would resolve to the ::text-cast output column in selectList,
      // sorting lexicographically instead of by the real typed value.
      const orderClause = tableOrderClause(meta, sort, opts.descending, quoteIdent);

      // Identifiers spliced here are schema-validated (realSchema via
      // resolveSchema, realTable/columns via allowedTables/allowedColumns,
      // sort via the findExact check above, filter columns via
      // buildWhereClause's own allow-list check); every value is a bound
      // $N parameter.
      const query = `select ${selectList} from ${quoteIdent(realSchema)}.${quoteIdent(realTable)}${whereClause}${orderClause} limit $1 offset $2`;
      const args: unknown[] = [opts.limit, opts.offset, ...filterValues];

      const { rows: dataRows } = await client.query(query, args).catch((err: unknown) => {
        throw mapSelectDenied(err, realTable, opts.sort);
      });
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
      await this.readableTableOid(client, realSchema, table);
      const realTable = table;
      const columnNames = await this.allowedColumns(client, realSchema, realTable);
      const realColumn = findExact(columnNames, column);
      if (!realColumn) {
        throw new NotAllowedError(`column "${column}"`, "column");
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

  async referencedBy(schema: string | undefined, table: string, timeoutMs: number): Promise<ReferencedByEntry[]> {
    return this.withTimeout(timeoutMs, async (client) => {
      const realSchema = await this.resolveSchema(client, schema);
      const targetOid = await this.readableTableOid(client, realSchema, table);

      // pg_catalog, not information_schema: the reverse (confrelid) filter
      // over the standard-SQL views runs 20-40x slower on a large catalog
      // (docs/adapter-decisions.md §5.9). has_table_privilege is the
      // per-referrer read gate and works across schemas, so cross-schema
      // referrers are reported and gated without a separate allow-list pass.
      // conparentid = 0 excludes a partitioned referrer's per-partition
      // constraint copies (Postgres clones the parent's FK onto each
      // partition) — without it, one logical FK fans out into one entry per
      // partition plus the parent. relkind = 'r' gates the referrer itself
      // the same way targetOid above gates the target: a partitioned
      // table's own (non-inherited) FK constraint survives conparentid = 0
      // and would otherwise be reported as a referrer name that
      // queryTable/commonValues/referencedBy-as-target then all reject,
      // since none accept relkind = 'p'.
      const { rows } = await client.query<{
        nspname: string;
        relname: string;
        conname: string;
        from_col: string;
        to_col: string;
      }>(
        `select rn.nspname, rc.relname, con.conname, fa.attname as from_col, ta.attname as to_col
         from pg_constraint con
         join pg_class rc on rc.oid = con.conrelid
         join pg_namespace rn on rn.oid = rc.relnamespace
         join lateral unnest(con.conkey, con.confkey) with ordinality
              as k(from_attnum, to_attnum, n) on true
         join pg_attribute fa on fa.attrelid = con.conrelid and fa.attnum = k.from_attnum
         join pg_attribute ta on ta.attrelid = con.confrelid and ta.attnum = k.to_attnum
         where con.contype = 'f'
           and con.conparentid = 0
           and con.confrelid = $1
           and rc.relkind = 'r'
           and has_table_privilege(con.conrelid, 'SELECT')
         order by rn.nspname, rc.relname, con.conname, k.n`,
        [targetOid],
      );

      return groupReferencedBy(
        rows.map((r) => {
          const entry: ReferencedByEntry = {
            table: r.relname,
            constraint: r.conname,
            columns: [{ from: r.from_col, to: r.to_col }],
          };
          if (r.nspname !== realSchema) entry.schema = r.nspname;
          return entry;
        }),
      );
    });
  }

  async structure(schema: string | undefined, table: string, timeoutMs: number): Promise<Structure> {
    return this.withTimeout(timeoutMs, async (client) => {
      const realSchema = await this.resolveSchema(client, schema);
      const oid = await this.readableTableOid(client, realSchema, table);
      const out = emptyStructure();

      // Key columns only (indnkeyatts): trailing indkey entries are INCLUDE
      // columns. An indkey entry of 0 is an expression with no pg_attribute
      // row, so the join is a left join and the entry renders through
      // pg_get_indexdef instead of vanishing.
      const indexRows = await client.query<{
        relname: string;
        amname: string;
        indisunique: boolean;
        predicate: string | null;
        col: string;
      }>(
        `select ic.relname::text, am.amname::text, ix.indisunique,
                pg_get_expr(ix.indpred, ix.indrelid) as predicate,
                coalesce(a.attname::text, pg_get_indexdef(ix.indexrelid, k.n::int, true)) as col
         from pg_index ix
         join pg_class ic on ic.oid = ix.indexrelid
         join pg_am am on am.oid = ic.relam
         join lateral unnest(ix.indkey::int2[]) with ordinality as k(attnum, n) on true
         left join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = k.attnum
         where ix.indrelid = $1 and k.n <= ix.indnkeyatts
         order by ic.relname, k.n`,
        [oid],
      );
      for (const r of indexRows.rows) {
        const last = out.indexes[out.indexes.length - 1];
        if (last && last.name === r.relname) {
          last.columns.push(r.col);
          continue;
        }
        out.indexes.push({
          name: r.relname,
          columns: [r.col],
          unique: r.indisunique,
          method: r.amname,
          ...(r.predicate === null ? {} : { predicate: r.predicate }),
        });
      }

      const keyRows = await client.query<{ contype: string; conname: string; attname: string }>(
        `select con.contype::text, con.conname::text, a.attname::text
         from pg_constraint con
         join lateral unnest(con.conkey) with ordinality as k(attnum, n) on true
         join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
         where con.conrelid = $1 and con.contype in ('p', 'u')
         order by con.contype desc, con.conname, k.n`,
        [oid],
      );
      for (const r of keyRows.rows) {
        if (r.contype === "p") {
          out.constraints.primary_key ??= { name: r.conname, columns: [] };
          out.constraints.primary_key.columns.push(r.attname);
          continue;
        }
        const last = out.constraints.unique[out.constraints.unique.length - 1];
        if (last && last.name === r.conname) last.columns.push(r.attname);
        else out.constraints.unique.push({ name: r.conname, columns: [r.attname] });
      }

      const fkRows = await client.query<{
        conname: string;
        nspname: string;
        relname: string;
        from_col: string;
        to_col: string;
        confdeltype: string;
        confupdtype: string;
      }>(
        `select con.conname::text, rn.nspname::text, rc.relname::text,
                fa.attname::text as from_col, ta.attname::text as to_col,
                con.confdeltype::text, con.confupdtype::text
         from pg_constraint con
         join pg_class rc on rc.oid = con.confrelid
         join pg_namespace rn on rn.oid = rc.relnamespace
         join lateral unnest(con.conkey, con.confkey) with ordinality
              as k(from_attnum, to_attnum, n) on true
         join pg_attribute fa on fa.attrelid = con.conrelid and fa.attnum = k.from_attnum
         join pg_attribute ta on ta.attrelid = con.confrelid and ta.attnum = k.to_attnum
         where con.conrelid = $1 and con.contype = 'f'
          and not exists (select 1 from pg_constraint par where par.oid = con.conparentid and par.conrelid = con.conrelid)
         order by con.conname, k.n`,
        [oid],
      );
      for (const r of fkRows.rows) {
        const last = out.constraints.foreign_keys[out.constraints.foreign_keys.length - 1];
        if (last && last.name === r.conname) {
          last.columns.push({ from: r.from_col, to: r.to_col });
          continue;
        }
        out.constraints.foreign_keys.push({
          name: r.conname,
          table: r.relname,
          ...(r.nspname === realSchema ? {} : { schema: r.nspname }),
          columns: [{ from: r.from_col, to: r.to_col }],
          on_delete: fkAction(r.confdeltype),
          on_update: fkAction(r.confupdtype),
        });
      }

      const checkRows = await client.query<{ conname: string; def: string }>(
        `select con.conname::text, pg_get_expr(con.conbin, con.conrelid) as def
         from pg_constraint con
         where con.conrelid = $1 and con.contype = 'c'
         order by con.conname`,
        [oid],
      );
      out.constraints.check = checkRows.rows.map((r) => ({ name: r.conname, expression: r.def }));
      return out;
    });
  }
}

/** Maps pg_constraint.confdeltype/confupdtype to the fixed vocabulary of `spec/protocol.md` §5.10. */
function fkAction(code: string): string {
  switch (code) {
    case "c":
      return "CASCADE";
    case "r":
      return "RESTRICT";
    case "n":
      return "SET NULL";
    case "d":
      return "SET DEFAULT";
    default:
      return "NO ACTION";
  }
}
