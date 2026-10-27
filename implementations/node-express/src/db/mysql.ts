import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { assertSafeTimeoutMs, FilterError, mapSelectDeniedMysql, NotAllowedError } from "../errors.js";
import type { Condition } from "../filter.js";
import {
  BadJoinError,
  buildJoinSelect,
  type JoinColMeta,
  type JoinData,
  type JoinDialect,
  type JoinOpts,
  type JoinSpec,
  type JoinTableMeta,
  joinColumnInfos,
  joinRows,
  joinTableNames,
  planJoin,
  type TypeClass,
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
  opSql,
  opTakesValue,
  type QueryOpts,
  type ReferencedByEntry,
  type SchemaListing,
  type Structure,
  schemaListing,
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
      throw new NotAllowedError(`column "${cond.column}"`, "column");
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

const JOIN_DIALECT: JoinDialect = {
  quote: quoteIdentMysql,
  castText: (expr) => `CAST(${expr} AS CHAR)`,
  numbered: false,
  ilike: "lowered-like",
};

/** `spec/protocol.md` §5.11.2; the mapping is in `docs/adapter-decisions.md` §5.11. */
// Matches the column check MariaDB adds to every JSON column exactly, so a
// user's own json_valid check on another column doesn't count.
const MARIADB_JSON_COLUMNS_SQL =
  "constraint_name as constraint_name from information_schema.check_constraints " +
  "where constraint_schema = ? and table_name = ? and level = 'Column' " +
  "and check_clause = concat('json_valid(`', replace(constraint_name, '`', '``'), '`)')";

export function mysqlTypeClass(dataType: string, columnType: string): TypeClass | undefined {
  switch (dataType.toLowerCase()) {
    case "tinyint":
    case "smallint":
    case "mediumint":
    case "int":
    case "integer":
    case "bigint":
    case "decimal":
    case "numeric":
      return { kind: "number" };
    case "char":
    case "varchar":
    case "tinytext":
    case "text":
    case "mediumtext":
    case "longtext":
      return { kind: "text" };
    case "date":
    case "datetime":
    case "timestamp":
      return { kind: "temporal" };
    case "time":
      return { kind: "time" };
    case "binary":
    case "varbinary":
    case "tinyblob":
    case "blob":
    case "mediumblob":
    case "longblob":
      return { kind: "binary" };
    case "uuid":
      return { kind: "uuid" };
    case "enum":
      return { kind: "enum", id: columnType };
    default:
      return undefined;
  }
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
        "order by cast(schema_name as binary)",
    );
    const rows = await queryRows(conn, sql);
    return rows.map((r) => r.schema_name as string);
  }

  // Null when the connection names no database.
  private async defaultSchemaInTx(conn: PoolConnection, variant: Variant, timeoutMs: number): Promise<string | null> {
    const rows = await queryRows(conn, timedSelect(variant, timeoutMs, "database() as db"));
    return (rows[0]?.db as string | null | undefined) ?? null;
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
      const defaultDatabase = await this.defaultSchemaInTx(conn, variant, timeoutMs);
      if (defaultDatabase === null) {
        throw new NotAllowedError("no schema requested and this connection has no default database", "schema");
      }
      resolved = defaultDatabase;
    }
    const real = findExact(schemas, resolved);
    if (!real) {
      throw new NotAllowedError(`schema "${resolved}"`, "schema");
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
        "where table_schema = ? and table_type = 'BASE TABLE' order by cast(table_name as binary)",
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

  async listSchemas(timeoutMs: number): Promise<SchemaListing> {
    return this.withTx(async (conn, variant) =>
      schemaListing(
        await this.listSchemasInTx(conn, variant, timeoutMs),
        await this.defaultSchemaInTx(conn, variant, timeoutMs),
      ),
    );
  }

  async listTables(schema: string | undefined, timeoutMs: number): Promise<TableInfo[]> {
    return this.withTx(async (conn, variant) => {
      const realSchema = await this.resolveSchemaInTx(conn, variant, schema, timeoutMs);
      // Byte order: MariaDB's catalog collation ignores `_` when sorting.
      const sql = timedSelect(
        variant,
        timeoutMs,
        "table_name as table_name, table_comment as table_comment from information_schema.tables " +
          "where table_schema = ? and table_type = 'BASE TABLE' order by cast(table_name as binary)",
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
          "where table_schema = ? and table_type = 'BASE TABLE' order by cast(table_name as binary)",
      );
      const rows = await queryRows(conn, sql, [realSchema]);
      // NULL means no estimate yet: emit -1 (`spec/protocol.md` §5.3).
      return rows.map((r) => ({
        table: r.table_name as string,
        approx_rows: r.table_rows === null ? -1 : Number(r.table_rows),
      }));
    });
  }

  // MariaDB has no JSON type: a JSON column is longtext guarded by a json_valid column check.
  private async mariadbJsonColumns(
    conn: PoolConnection,
    variant: Variant,
    schema: string,
    table: string,
    timeoutMs: number,
  ): Promise<Set<string>> {
    if (variant !== "mariadb") return new Set();
    const rows = await queryRows(conn, timedSelect(variant, timeoutMs, MARIADB_JSON_COLUMNS_SQL), [schema, table]);
    return new Set(rows.map((r) => r.constraint_name as string));
  }

  private async joinTableMeta(
    conn: PoolConnection,
    variant: Variant,
    schema: string,
    table: string,
    timeoutMs: number,
  ): Promise<JoinTableMeta> {
    const rows = await queryRows(
      conn,
      timedSelect(
        variant,
        timeoutMs,
        "column_name as column_name, data_type as data_type, column_comment as column_comment, " +
          "collation_name as collation_name, column_type as column_type " +
          "from information_schema.columns where table_schema = ? and table_name = ? order by ordinal_position",
      ),
      [schema, table],
    );
    const { pkColumns, fkColumns } = await this.keyMetadataInTx(conn, variant, schema, table, timeoutMs);
    const jsonColumns = await this.mariadbJsonColumns(conn, variant, schema, table, timeoutMs);
    const columns = rows.map((r): JoinColMeta => {
      const name = r.column_name as string;
      const col: JoinColMeta = jsonColumns.has(name)
        ? { name, type: "json", class: undefined }
        : { name, type: r.data_type as string, class: mysqlTypeClass(r.data_type as string, String(r.column_type)) };
      if (r.collation_name) col.collation = r.collation_name as string;
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
    return { name: table, columns };
  }

  async queryJoin(schema: string | undefined, spec: JoinSpec, opts: JoinOpts, timeoutMs: number): Promise<JoinData> {
    return this.withTx(async (conn, variant) => {
      const realSchema = await this.resolveSchemaInTx(conn, variant, schema, timeoutMs);
      const allowed = await this.allowedTablesInTx(conn, variant, realSchema, timeoutMs);
      const names = joinTableNames(spec);
      const metas = new Map<string, JoinTableMeta>();
      for (const name of names) {
        if (metas.has(name)) continue;
        if (!findExact(allowed, name)) throw new BadJoinError(`unknown table "${name}"`);
        metas.set(name, await this.joinTableMeta(conn, variant, realSchema, name, timeoutMs));
      }
      const plan = planJoin(
        spec,
        names.map((n) => metas.get(n) as JoinTableMeta),
        opts,
      );

      // The statement is built from catalog names and generated aliases
      // only; every value is a bound ? parameter.
      const { body, values } = buildJoinSelect(plan, JOIN_DIALECT, realSchema);
      const rows = await queryRows(conn, timedSelect(variant, timeoutMs, body), [
        ...values,
        opts.limit + 1,
        opts.offset,
      ]).catch((err: unknown) => {
        throw mapSelectDeniedMysql(err, spec.table);
      });
      const out = joinRows(plan, rows, opts.limit, cellToJson);
      return { columns: joinColumnInfos(plan), rows: out.rows, has_more: out.hasMore };
    });
  }

  async queryTable(schema: string | undefined, table: string, opts: QueryOpts, timeoutMs: number): Promise<TableData> {
    return this.withTx(async (conn, variant) => {
      const realSchema = await this.resolveSchemaInTx(conn, variant, schema, timeoutMs);
      const tables = await this.allowedTablesInTx(conn, variant, realSchema, timeoutMs);
      const realTable = findExact(tables, table);
      if (!realTable) {
        throw new NotAllowedError(`table "${table}"`, "table");
      }

      const columnNames = await this.allowedColumnsInTx(conn, variant, realSchema, realTable, timeoutMs);
      let sort: string | undefined;
      if (opts.sort !== undefined) {
        sort = findExact(columnNames, opts.sort);
        if (!sort) {
          throw new NotAllowedError(`column "${opts.sort}"`, "column");
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
        throw new NotAllowedError(`table "${table}"`, "table");
      }
      const columnNames = await this.allowedColumnsInTx(conn, variant, realSchema, realTable, timeoutMs);
      if (!findExact(columnNames, column)) {
        throw new NotAllowedError(`column "${column}"`, "column");
      }
      // MySQL has no portable common-value statistics (`spec/protocol.md` §5.5).
      return [];
    });
  }

  async referencedBy(schema: string | undefined, table: string, timeoutMs: number): Promise<ReferencedByEntry[]> {
    return this.withTx(async (conn, variant) => {
      const realSchema = await this.resolveSchemaInTx(conn, variant, schema, timeoutMs);
      // One allow-list read, shared by the target-table check and the
      // referrer post-filter — MySQL/MariaDB have no cross-schema
      // has_table_privilege gate (docs/adapter-decisions.md §5.9).
      const allowed = new Set(await this.allowedTablesInTx(conn, variant, realSchema, timeoutMs));
      if (!allowed.has(table)) {
        throw new NotAllowedError(`table "${table}"`, "table");
      }

      // Read key_column_usage, not referential_constraints, whose
      // referenced-name column MariaDB nulls for a role lacking privilege
      // on the referenced table. table_schema = ? keeps referrers to the
      // resolved database.
      const rows = await queryRows(
        conn,
        timedSelect(
          variant,
          timeoutMs,
          "kcu.table_name as table_name, kcu.constraint_name as constraint_name, " +
            "kcu.column_name as column_name, kcu.referenced_column_name as referenced_column_name " +
            "from information_schema.key_column_usage kcu " +
            "where kcu.referenced_table_schema = ? and kcu.referenced_table_name = ? " +
            "  and kcu.table_schema = ? " +
            "order by kcu.table_name, kcu.constraint_name, kcu.ordinal_position",
        ),
        [realSchema, table, realSchema],
      );

      // Keep the referrer set inside the same allow-list every other route
      // on this backend serves from.
      return groupReferencedBy(
        rows
          .filter((r) => allowed.has(r.table_name as string))
          .map((r) => ({
            table: r.table_name as string,
            constraint: r.constraint_name as string,
            columns: [{ from: r.column_name as string, to: r.referenced_column_name as string }],
          })),
      );
    });
  }

  async structure(schema: string | undefined, table: string, timeoutMs: number): Promise<Structure> {
    return this.withTx(async (conn, variant) => {
      const realSchema = await this.resolveSchemaInTx(conn, variant, schema, timeoutMs);
      const allowed = await this.allowedTablesInTx(conn, variant, realSchema, timeoutMs);
      if (!allowed.includes(table)) {
        throw new NotAllowedError(`table "${table}"`, "table");
      }
      const out = emptyStructure();

      // MariaDB's statistics view has no expression column; MySQL 8.0.13+
      // reports a functional key part there with a NULL column_name.
      const keyPart = variant === "mariadb" ? "s.column_name" : "coalesce(s.column_name, s.expression)";
      const indexRows = await queryRows(
        conn,
        timedSelect(
          variant,
          timeoutMs,
          "s.index_name as index_name, cast(s.non_unique as signed) as non_unique, " +
            `s.index_type as index_type, ${keyPart} as key_part ` +
            "from information_schema.statistics s " +
            "where s.table_schema = ? and s.table_name = ? " +
            "order by s.index_name, s.seq_in_index",
        ),
        [realSchema, table],
      );
      for (const r of indexRows) {
        const name = r.index_name as string;
        const last = out.indexes[out.indexes.length - 1];
        if (last && last.name === name) {
          last.columns.push((r.key_part as string | null) ?? "");
          continue;
        }
        out.indexes.push({
          name,
          columns: [(r.key_part as string | null) ?? ""],
          unique: Number(r.non_unique) === 0,
          method: (r.index_type as string).toLowerCase(),
        });
      }

      const keyRows = await queryRows(
        conn,
        timedSelect(
          variant,
          timeoutMs,
          "tc.constraint_type as constraint_type, tc.constraint_name as constraint_name, " +
            "kcu.column_name as column_name " +
            "from information_schema.table_constraints tc " +
            "join information_schema.key_column_usage kcu " +
            "  on kcu.constraint_schema = tc.constraint_schema " +
            " and kcu.constraint_name = tc.constraint_name " +
            " and kcu.table_schema = tc.table_schema " +
            " and kcu.table_name = tc.table_name " +
            "where tc.table_schema = ? and tc.table_name = ? " +
            "  and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE') " +
            "order by tc.constraint_type desc, tc.constraint_name, kcu.ordinal_position",
        ),
        [realSchema, table],
      );
      for (const r of keyRows) {
        const name = r.constraint_name as string;
        const column = r.column_name as string;
        if (r.constraint_type === "PRIMARY KEY") {
          out.constraints.primary_key ??= { name, columns: [] };
          out.constraints.primary_key.columns.push(column);
          continue;
        }
        const last = out.constraints.unique[out.constraints.unique.length - 1];
        if (last && last.name === name) last.columns.push(column);
        else out.constraints.unique.push({ name, columns: [column] });
      }

      // Read key_column_usage for the referenced table, not
      // referential_constraints, which MariaDB nulls for a role lacking
      // privilege on it (same reason as referencedBy).
      const fkRows = await queryRows(
        conn,
        timedSelect(
          variant,
          timeoutMs,
          "kcu.constraint_name as constraint_name, kcu.referenced_table_schema as ref_schema, " +
            "kcu.referenced_table_name as ref_table, kcu.column_name as column_name, " +
            "kcu.referenced_column_name as ref_column, rc.delete_rule as delete_rule, " +
            "rc.update_rule as update_rule " +
            "from information_schema.key_column_usage kcu " +
            "join information_schema.referential_constraints rc " +
            "  on rc.constraint_schema = kcu.constraint_schema " +
            " and rc.constraint_name = kcu.constraint_name " +
            " and rc.table_name = kcu.table_name " +
            "where kcu.table_schema = ? and kcu.table_name = ? " +
            "  and kcu.referenced_table_name is not null " +
            "order by kcu.constraint_name, kcu.ordinal_position",
        ),
        [realSchema, table],
      );
      for (const r of fkRows) {
        const name = r.constraint_name as string;
        const pair = { from: r.column_name as string, to: r.ref_column as string };
        const last = out.constraints.foreign_keys[out.constraints.foreign_keys.length - 1];
        if (last && last.name === name) {
          last.columns.push(pair);
          continue;
        }
        out.constraints.foreign_keys.push({
          name,
          table: r.ref_table as string,
          ...(r.ref_schema === realSchema ? {} : { schema: r.ref_schema as string }),
          columns: [pair],
          on_delete: (r.delete_rule as string).toUpperCase(),
          on_update: (r.update_rule as string).toUpperCase(),
        });
      }

      // MySQL before 8.0.16 has no check_constraints view: report [].
      const hasChecks = await queryRows(
        conn,
        timedSelect(
          variant,
          timeoutMs,
          "count(*) as n from information_schema.tables " +
            "where table_schema = 'information_schema' and table_name = 'CHECK_CONSTRAINTS'",
        ),
        [],
      );
      if (Number(hasChecks[0]?.n) > 0) {
        // MariaDB names unnamed table-level checks per table, so its view
        // carries table_name for the join; MySQL's has none.
        const ccTable = variant === "mariadb" ? "and cc.table_name = tc.table_name " : "";
        const checkRows = await queryRows(
          conn,
          timedSelect(
            variant,
            timeoutMs,
            "tc.constraint_name as constraint_name, cc.check_clause as check_clause " +
              "from information_schema.table_constraints tc " +
              "join information_schema.check_constraints cc " +
              "  on cc.constraint_schema = tc.constraint_schema " +
              ` and cc.constraint_name = tc.constraint_name ${ccTable}` +
              "where tc.table_schema = ? and tc.table_name = ? " +
              "  and tc.constraint_type = 'CHECK' " +
              "order by tc.constraint_name",
          ),
          [realSchema, table],
        );
        out.constraints.check = checkRows.map((r) => ({
          name: r.constraint_name as string,
          ...(r.check_clause == null ? {} : { expression: r.check_clause as string }),
        }));
      }
      return out;
    });
  }
}
