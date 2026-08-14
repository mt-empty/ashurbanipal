import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { FilterError, NotAllowedError } from "../errors.js";
import type { Condition } from "../filter.js";
import {
  type ColumnInfo,
  type ColumnRef,
  type CommonValueEntry,
  type CountEntry,
  cellToJson,
  type DbSource,
  findExact,
  opSql,
  opTakesValue,
  type QueryOpts,
  type TableData,
  type TableInfo,
} from "./types.js";

/**
 * `mysql2` speaks the wire protocol both MySQL and MariaDB implement, but
 * the two forks need different SQL for the one thing this port relies on:
 * a per-query timeout (see timedSelect). Detected once per MySqlSource via
 * variant() and cached, not re-checked per request — mirrors
 * implementations/rust/core/src/db/mysql.rs's `Variant`.
 */
export type Variant = "mysql" | "mariadb";

/**
 * MySQL's `MAX_EXECUTION_TIME` hint must sit inline right after `select`.
 * MariaDB never implemented it and silently ignores unrecognized
 * `/*+ ... *\/` hints rather than rejecting them — reusing MySQL's hint
 * there would fail open, silently not enforcing the timeout at all — so
 * MariaDB instead gets `SET STATEMENT max_statement_time=N FOR ...`
 * (whole-statement wrap, plain seconds). `body` is the SQL text starting
 * right after the `select` keyword this function supplies.
 */
export function timedSelect(variant: Variant, timeoutMs: number, body: string): string {
  if (variant === "mysql") {
    return `select /*+ MAX_EXECUTION_TIME(${timeoutMs}) */ ${body}`;
  }
  return `set statement max_statement_time=${timeoutMs / 1000} for select ${body}`;
}

/**
 * MySQL's default identifier quote is the backtick, not `"` — double-quote
 * identifier quoting only works under session-wide `ANSI_QUOTES`, which
 * this crate has no business forcing on a host's connection. Doubling an
 * embedded backtick is MySQL's own documented escape.
 */
export function quoteIdentMysql(ident: string): string {
  return `\`${ident.replace(/`/g, "``")}\``;
}

/**
 * MySQL equivalent of the Postgres/SQLite buildWhereClause: `?`
 * placeholders (positional), `CAST(col AS CHAR)` instead of `::text`
 * (MySQL has no `::` operator and no `TEXT` cast target), and `ILIKE`
 * mapped to `LOWER(...) LIKE LOWER(?)` rather than a bare keyword swap —
 * unlike SQLite, whose plain `LIKE` is unconditionally ASCII
 * case-insensitive, MySQL's `LIKE` case-sensitivity depends on the
 * column's collation, which this crate has no control over. See
 * docs/adapter-decisions.md §5.4.2.
 */
export function buildWhereClauseMysql(
  conditions: Condition[],
  columnNames: string[],
): { where: string; values: string[] } {
  if (conditions.length === 0) {
    return { where: "", values: [] };
  }

  const allowed = new Set(columnNames);
  const values: string[] = [];
  let clause = "";

  conditions.forEach((cond, i) => {
    if (!allowed.has(cond.column)) {
      throw new NotAllowedError(`column "${cond.column}"`);
    }
    const cast = `CAST(${quoteIdentMysql(cond.column)} AS CHAR)`;

    let inner: string;
    if (cond.op === "ILIKE") {
      if (cond.value === undefined) {
        throw new FilterError(`op "${cond.op}" requires a value`);
      }
      values.push(cond.value);
      inner = `LOWER(${cast}) LIKE LOWER(?)`;
    } else if (opTakesValue(cond.op)) {
      if (cond.value === undefined) {
        throw new FilterError(`op "${cond.op}" requires a value`);
      }
      values.push(cond.value);
      inner = `${cast} ${opSql(cond.op)} ?`;
    } else {
      inner = `${cast} ${opSql(cond.op)}`;
    }

    const wrapped = cond.not ? `(NOT (${inner}))` : `(${inner})`;
    if (i > 0) {
      if (cond.logic === undefined) {
        throw new FilterError(`condition ${i} is missing logic`);
      }
      clause += cond.logic === "OR" ? " OR " : " AND ";
    }
    clause += wrapped;
  });

  return { where: ` where ${clause}`, values };
}

async function queryRows(
  conn: PoolConnection,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const [rows] = await conn.query<RowDataPacket[]>(sql, params);
  return rows;
}

// MySQL 8 echoes back an un-aliased information_schema column using its
// catalog-defined case (e.g. `SCHEMA_NAME`, not the lowercase `schema_name`
// written in the query text) — MariaDB doesn't, which is exactly the kind
// of silent cross-fork divergence this port must not assume symmetry on
// (confirmed empirically against both live services). Every raw
// information_schema/CAST column reference below carries an explicit
// lowercase alias so the row-object key this port reads by name is
// deterministic on both forks.

/**
 * The MySQL/MariaDB `DbSource`, ported against
 * implementations/rust/core/src/db/mysql.rs. Not run through
 * conformance/runner (that suite targets Postgres) — see
 * docs/adapter-decisions.md for the per-clause decisions this makes where
 * Postgres-specific catalog/stats mechanisms have no equivalent.
 */
export class MySqlSource implements DbSource {
  private variantPromise: Promise<Variant> | undefined;

  constructor(private readonly pool: Pool) {}

  // `SELECT VERSION()` returns a string containing `MariaDB` on that fork
  // (e.g. `10.11.6-MariaDB-1:10.11.6+maria~ubu2004`) and just a bare
  // version like `8.0.35` on real MySQL — the standard sniff other
  // drivers use, since there's no dedicated boolean-returning function
  // for it. Cached in a memoized promise so concurrent first calls share
  // one detection; a lost race between concurrent callers is harmless
  // since both would detect the same value. On failure the cached promise
  // is cleared so the next call retries, instead of pinning every future
  // request to one transient blip forever (mirrors mysql.rs's OnceLock,
  // which is only .set() after a successful query).
  private async variant(): Promise<Variant> {
    if (this.variantPromise === undefined) {
      const detect = (async (): Promise<Variant> => {
        const [rows] = await this.pool.query<RowDataPacket[]>("select version() as v");
        const version = String(rows[0]?.v ?? "");
        return version.toLowerCase().includes("mariadb") ? "mariadb" : "mysql";
      })();
      detect.catch(() => {
        if (this.variantPromise === detect) {
          this.variantPromise = undefined;
        }
      });
      this.variantPromise = detect;
    }
    return this.variantPromise;
  }

  // Runs `fn` inside a transaction pinned to one physical connection for
  // the whole operation — immune to pool sessions with divergent default
  // database, mirroring postgres.ts's withTimeout / mysql.rs's
  // pinned_tx. Unlike Postgres, no session/transaction-scoped timeout is
  // set here; the timeout mechanism (timedSelect) is applied per-query.
  private async withTx<T>(fn: (conn: PoolConnection, variant: Variant) => Promise<T>): Promise<T> {
    const variant = await this.variant();
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn, variant);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  // Excludes MySQL's own internal schemas. There is no single
  // boolean-returning privilege-check function equivalent to Postgres's
  // has_schema_privilege — accepted as a documented gap in
  // docs/adapter-decisions.md (§5.7's exclusion is a SHOULD, not a MUST).
  private async listSchemasInTx(conn: PoolConnection, variant: Variant, timeoutMs: number): Promise<string[]> {
    const sql = timedSelect(
      variant,
      timeoutMs,
      "schema_name as schema_name from information_schema.schemata " +
        "where schema_name not in ('mysql', 'information_schema', 'performance_schema', 'sys') " +
        "order by schema_name",
    );
    const rows = await queryRows(conn, sql);
    return rows.map((r) => r.schema_name as string);
  }

  // Resolves the schema for this operation exactly once, as the first
  // statement in the transaction. current_schema() has no MySQL
  // equivalent; `select database()` is the analogous "connection's own
  // default" read.
  private async resolveSchemaInTx(
    conn: PoolConnection,
    variant: Variant,
    requested: string | undefined,
    timeoutMs: number,
  ): Promise<string> {
    const schemas = await this.listSchemasInTx(conn, variant, timeoutMs);
    let resolved: string;
    if (requested !== undefined) {
      resolved = requested;
    } else {
      const rows = await queryRows(conn, timedSelect(variant, timeoutMs, "database() as db"));
      // database() returns SQL NULL for a connection with no default
      // database — surface a clear error rather than letting the `as
      // string` cast paper over it and produce a confusing
      // `not allowed: schema "null"` message below.
      const defaultDatabase = rows[0]?.db as string | null | undefined;
      if (defaultDatabase === null || defaultDatabase === undefined) {
        throw new NotAllowedError("no schema requested and this connection has no default database");
      }
      resolved = defaultDatabase;
    }
    const real = findExact(schemas, resolved);
    if (!real) {
      throw new NotAllowedError(`schema "${resolved}"`);
    }
    return real;
  }

  private async allowedTablesInTx(
    conn: PoolConnection,
    variant: Variant,
    schema: string,
    timeoutMs: number,
  ): Promise<string[]> {
    const sql = timedSelect(
      variant,
      timeoutMs,
      "table_name as table_name from information_schema.tables " +
        "where table_schema = ? and table_type = 'BASE TABLE' order by table_name",
    );
    const rows = await queryRows(conn, sql, [schema]);
    return rows.map((r) => r.table_name as string);
  }

  private async allowedColumnsInTx(
    conn: PoolConnection,
    variant: Variant,
    schema: string,
    table: string,
    timeoutMs: number,
  ): Promise<string[]> {
    const sql = timedSelect(
      variant,
      timeoutMs,
      "column_name as column_name from information_schema.columns " +
        "where table_schema = ? and table_name = ? order by ordinal_position",
    );
    const rows = await queryRows(conn, sql, [schema, table]);
    return rows.map((r) => r.column_name as string);
  }

  // Composite FKs are dropped rather than risk mislabeling which
  // referencing column pairs with which referenced column, mirroring
  // postgres.ts's keyMetadata / mysql.rs's key_metadata_in_tx.
  //
  // The join includes `kcu.table_name = tc.table_name`, not just
  // `constraint_name` — unlike Postgres's auto-generated, schema-unique
  // constraint names, MySQL's primary-key constraint is always literally
  // named "PRIMARY" on every table, so joining on constraint_name alone
  // would match every other table's primary-key columns in the same
  // schema.
  private async keyMetadataInTx(
    conn: PoolConnection,
    variant: Variant,
    schema: string,
    table: string,
    timeoutMs: number,
  ): Promise<{ pkColumns: Set<string>; fkColumns: Map<string, ColumnRef> }> {
    const sql = timedSelect(
      variant,
      timeoutMs,
      "tc.constraint_name as constraint_name, tc.constraint_type as constraint_type, " +
        "kcu.column_name as column_name, " +
        "kcu.referenced_table_schema as referenced_table_schema, " +
        "kcu.referenced_table_name as referenced_table_name, " +
        "kcu.referenced_column_name as referenced_column_name " +
        "from information_schema.table_constraints tc " +
        "join information_schema.key_column_usage kcu " +
        "on kcu.constraint_name = tc.constraint_name " +
        "and kcu.table_schema = tc.table_schema " +
        "and kcu.table_name = tc.table_name " +
        "where tc.table_schema = ? and tc.table_name = ? " +
        "and tc.constraint_type in ('PRIMARY KEY', 'FOREIGN KEY')",
    );
    const rows = await queryRows(conn, sql, [schema, table]);

    const pkColumns = new Set<string>();
    const fkCandidates = new Map<
      string,
      { column: string; refSchema: string | null; refTable: string | null; refColumn: string | null }[]
    >();
    for (const row of rows) {
      const constraintType = row.constraint_type as string;
      const columnName = row.column_name as string;
      if (constraintType === "PRIMARY KEY") {
        pkColumns.add(columnName);
      } else if (constraintType === "FOREIGN KEY") {
        const constraintName = row.constraint_name as string;
        const list = fkCandidates.get(constraintName) ?? [];
        list.push({
          column: columnName,
          refSchema: row.referenced_table_schema as string | null,
          refTable: row.referenced_table_name as string | null,
          refColumn: row.referenced_column_name as string | null,
        });
        fkCandidates.set(constraintName, list);
      }
    }

    const fkColumns = new Map<string, ColumnRef>();
    for (const members of fkCandidates.values()) {
      const distinctColumns = new Set(members.map((m) => m.column));
      if (distinctColumns.size !== 1) continue; // composite FK: omit entirely
      const first = members[0];
      if (first.refSchema && first.refTable && first.refColumn) {
        const ref: ColumnRef = { table: first.refTable, column: first.refColumn };
        if (first.refSchema !== schema) ref.schema = first.refSchema;
        fkColumns.set(first.column, ref);
      }
    }
    return { pkColumns, fkColumns };
  }

  async listSchemas(timeoutMs: number): Promise<string[]> {
    return this.withTx((conn, variant) => this.listSchemasInTx(conn, variant, timeoutMs));
  }

  async listTables(schema: string | undefined, timeoutMs: number): Promise<TableInfo[]> {
    return this.withTx(async (conn, variant) => {
      const realSchema = await this.resolveSchemaInTx(conn, variant, schema, timeoutMs);
      // TABLE_COMMENT sits as a plain column here — no obj_description-
      // style function call needed, unlike Postgres.
      const sql = timedSelect(
        variant,
        timeoutMs,
        "table_name as table_name, table_comment as table_comment from information_schema.tables " +
          "where table_schema = ? and table_type = 'BASE TABLE' order by table_name",
      );
      const rows = await queryRows(conn, sql, [realSchema]);
      return rows.map((r) => {
        const t: TableInfo = { name: r.table_name as string };
        const comment = r.table_comment as string;
        // Empty string means "no comment"; MUST be omitted, not emitted
        // as "" (spec/protocol.md §5.2).
        if (comment.length > 0) t.comment = comment;
        return t;
      });
    });
  }

  async tableCounts(schema: string | undefined, timeoutMs: number): Promise<CountEntry[]> {
    return this.withTx(async (conn, variant) => {
      const realSchema = await this.resolveSchemaInTx(conn, variant, schema, timeoutMs);
      // TABLE_ROWS is an InnoDB-statistics estimate (reltuples-
      // equivalent, may be stale, refreshed by ANALYZE TABLE) — never
      // COUNT(*).
      const sql = timedSelect(
        variant,
        timeoutMs,
        "table_name as table_name, cast(table_rows as signed) as table_rows from information_schema.tables " +
          "where table_schema = ? and table_type = 'BASE TABLE' order by table_name",
      );
      const rows = await queryRows(conn, sql, [realSchema]);
      // TABLE_ROWS is NULL before InnoDB has gathered any statistics for
      // a freshly created table — -1 is the same "no estimate yet"
      // sentinel Postgres uses before a table's first ANALYZE/VACUUM
      // (spec/protocol.md §5.3), not SQLite's "no mechanism at all" case.
      return rows.map((r) => ({
        table: r.table_name as string,
        approx_rows: r.table_rows === null ? -1 : Number(r.table_rows),
      }));
    });
  }

  async queryTable(schema: string | undefined, table: string, opts: QueryOpts, timeoutMs: number): Promise<TableData> {
    return this.withTx(async (conn, variant) => {
      const realSchema = await this.resolveSchemaInTx(conn, variant, schema, timeoutMs);
      const tables = await this.allowedTablesInTx(conn, variant, realSchema, timeoutMs);
      const realTable = findExact(tables, table);
      if (!realTable) {
        throw new NotAllowedError(`table "${table}"`);
      }

      const columnNames = await this.allowedColumnsInTx(conn, variant, realSchema, realTable, timeoutMs);
      let sort: string | undefined;
      if (opts.sort !== undefined) {
        sort = findExact(columnNames, opts.sort);
        if (!sort) {
          throw new NotAllowedError(`column "${opts.sort}"`);
        }
      }

      const { where: whereClause, values: filterValues } = buildWhereClauseMysql(opts.filter, columnNames);

      // DATA_TYPE and COLUMN_COMMENT both sit as plain columns on
      // information_schema.columns — unlike Postgres, no separate
      // pg_attribute join is needed, and no ordinal-position-vs-attnum
      // drift is possible.
      const metaSql = timedSelect(
        variant,
        timeoutMs,
        "column_name as column_name, data_type as data_type, column_comment as column_comment " +
          "from information_schema.columns where table_schema = ? and table_name = ? order by ordinal_position",
      );
      const columnMetaRows = await queryRows(conn, metaSql, [realSchema, realTable]);

      const { pkColumns, fkColumns } = await this.keyMetadataInTx(conn, variant, realSchema, realTable, timeoutMs);

      const columns: ColumnInfo[] = columnMetaRows.map((r) => {
        const name = r.column_name as string;
        const col: ColumnInfo = { name, type: r.data_type as string };
        if (pkColumns.has(name)) {
          col.key = "pk";
          if (fkColumns.has(name)) col.references = fkColumns.get(name);
        } else if (fkColumns.has(name)) {
          col.key = "fk";
          col.references = fkColumns.get(name);
        }
        const comment = r.column_comment as string;
        if (comment.length > 0) col.comment = comment;
        return col;
      });

      // Aliased back to the real column name: an un-aliased CAST(...)
      // expression's result-set label is the literal expression text, not
      // the source column name, on both MySQL and MariaDB — row access by
      // name below (cellToJson via col.name) would otherwise silently
      // read undefined for every cell.
      const selectList = columns
        .map((c) => `CAST(${quoteIdentMysql(c.name)} AS CHAR) AS ${quoteIdentMysql(c.name)}`)
        .join(", ");
      // Table-qualified, same reason as postgres.ts/sqlite.ts: an
      // unqualified `order by` would resolve to the CAST-output column in
      // selectList, sorting lexicographically instead of by the real
      // typed value.
      const orderClause =
        sort !== undefined
          ? ` order by ${quoteIdentMysql(realTable)}.${quoteIdentMysql(sort)} ${opts.descending ? "desc" : "asc"}`
          : "";
      const dataSql = timedSelect(
        variant,
        timeoutMs,
        `${selectList} from ${quoteIdentMysql(realSchema)}.${quoteIdentMysql(realTable)}${whereClause}${orderClause} limit ? offset ?`,
      );
      const dataRows = await queryRows(conn, dataSql, [...filterValues, opts.limit, opts.offset]);
      const outRows: Record<string, string | null>[] = dataRows.map((row) => {
        const out: Record<string, string | null> = {};
        for (const col of columns) {
          out[col.name] = cellToJson(row[col.name]);
        }
        return out;
      });

      const totalSql = timedSelect(
        variant,
        timeoutMs,
        "cast(table_rows as signed) as table_rows from information_schema.tables " +
          "where table_schema = ? and table_name = ?",
      );
      const totalRows = await queryRows(conn, totalSql, [realSchema, realTable]);
      const totalApprox =
        totalRows.length > 0 && totalRows[0].table_rows !== null ? Number(totalRows[0].table_rows) : -1;

      return { columns, rows: outRows, total_approx: totalApprox };
    });
  }

  async commonValues(
    schema: string | undefined,
    table: string,
    column: string,
    timeoutMs: number,
  ): Promise<CommonValueEntry[]> {
    return this.withTx(async (conn, variant) => {
      const realSchema = await this.resolveSchemaInTx(conn, variant, schema, timeoutMs);
      const tables = await this.allowedTablesInTx(conn, variant, realSchema, timeoutMs);
      const realTable = findExact(tables, table);
      if (!realTable) {
        throw new NotAllowedError(`table "${table}"`);
      }
      const columnNames = await this.allowedColumnsInTx(conn, variant, realSchema, realTable, timeoutMs);
      if (!findExact(columnNames, column)) {
        throw new NotAllowedError(`column "${column}"`);
      }
      // No pg_stats equivalent. MySQL 8's information_schema.
      // COLUMN_STATISTICS histogram needs an explicit `ANALYZE TABLE ...
      // UPDATE HISTOGRAM` to populate and doesn't exist at all on
      // MariaDB/MySQL 5.7 — an empty list is the documented "no
      // statistics available" answer (spec/protocol.md §5.5), mirroring
      // SQLite's same deliberate choice, not a live scan.
      return [];
    });
  }
}
