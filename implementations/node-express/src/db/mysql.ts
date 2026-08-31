import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { assertSafeTimeoutMs, FilterError, mapSelectDeniedMysql, NotAllowedError } from "../errors.js";
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

/** Selects fork-specific query timeout syntax (`spec/protocol.md` §6). */
export type Variant = "mysql" | "mariadb";

/** MariaDB ignores MySQL timeout hints, so it needs a statement wrapper (`spec/protocol.md` §6). */
export function timedSelect(variant: Variant, timeoutMs: number, body: string): string {
  assertSafeTimeoutMs(timeoutMs);
  if (variant === "mysql") {
    return `select /*+ MAX_EXECUTION_TIME(${timeoutMs}) */ ${body}`;
  }
  return `set statement max_statement_time=${timeoutMs / 1000} for select ${body}`;
}

/** Backtick-escape live-catalog identifiers for MySQL (`spec/protocol.md` §5). */
export function quoteIdentMysql(ident: string): string {
  return `\`${ident.replace(/`/g, "``")}\``;
}

/** Builds MySQL filter SQL; map ILIKE through LOWER for collation independence (`spec/protocol.md` §5.4.2). */
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

// Explicit aliases keep row keys stable across MySQL and MariaDB.

/** MySQL/MariaDB `DbSource` (`spec/protocol.md` §5). */
export class MySqlSource implements DbSource {
  private variantPromise: Promise<Variant> | undefined;

  constructor(private readonly pool: Pool) {}

  // Cache whether SELECT VERSION() contains MariaDB (`spec/protocol.md` §6).
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

  // Keep schema resolution on one connection (`spec/protocol.md` §5).
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

  // Read MySQL's default database in the operation transaction (`spec/protocol.md` §5).
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
      // Reject a missing default database instead of casting it to "null".
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

  // MySQL's PRIMARY name repeats, so join on table name; omit composite FKs
  // (`spec/protocol.md` §5.4.1).
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
        // Empty comments are omitted (`spec/protocol.md` §5.2).
        if (comment.length > 0) t.comment = comment;
        return t;
      });
    });
  }

  async tableCounts(schema: string | undefined, timeoutMs: number): Promise<CountEntry[]> {
    return this.withTx(async (conn, variant) => {
      const realSchema = await this.resolveSchemaInTx(conn, variant, schema, timeoutMs);
      // TABLE_ROWS is a potentially stale InnoDB estimate (`spec/protocol.md` §5.3).
      const sql = timedSelect(
        variant,
        timeoutMs,
        "table_name as table_name, cast(table_rows as signed) as table_rows from information_schema.tables " +
          "where table_schema = ? and table_type = 'BASE TABLE' order by table_name",
      );
      const rows = await queryRows(conn, sql, [realSchema]);
      // NULL means no estimate yet: emit -1 (`spec/protocol.md` §5.3).
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

      // Alias CAST results to the column names expected by cellToJson.
      const selectList = columns
        .map((c) => `CAST(${quoteIdentMysql(c.name)} AS CHAR) AS ${quoteIdentMysql(c.name)}`)
        .join(", ");
      // Qualify the source column so ORDER BY keeps its native type.
      const orderClause =
        sort !== undefined
          ? ` order by ${quoteIdentMysql(realTable)}.${quoteIdentMysql(sort)} ${opts.descending ? "desc" : "asc"}`
          : "";
      const dataSql = timedSelect(
        variant,
        timeoutMs,
        `${selectList} from ${quoteIdentMysql(realSchema)}.${quoteIdentMysql(realTable)}${whereClause}${orderClause} limit ? offset ?`,
      );
      const dataRows = await queryRows(conn, dataSql, [...filterValues, opts.limit, opts.offset]).catch(
        (err: unknown) => {
          throw mapSelectDeniedMysql(err, realTable);
        },
      );
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
      // MySQL has no portable common-value statistics (`spec/protocol.md` §5.5).
      return [];
    });
  }
}
