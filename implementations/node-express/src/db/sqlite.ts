import type { Database } from "sqlite3";
import { FilterError, NotAllowedError, quoteIdent } from "../errors.js";
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

/** SQLite's only schema for a single database file. */
const ONLY_SCHEMA = "main";

function checkSchema(schema: string | undefined): void {
  if (schema !== undefined && schema !== ONLY_SCHEMA) {
    throw new NotAllowedError(`schema "${schema}"`);
  }
}

function dbAll<T extends Record<string, unknown>>(db: Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all<T>(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

/** sqlite3 interrupt runs from another event-loop turn; `settled` avoids interrupting the next query. */
function bounded<T>(db: Database, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) db.interrupt();
    }, timeoutMs);
    fn().then(
      (value) => {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

async function allowedTables(db: Database, timeoutMs: number): Promise<string[]> {
  const rows = await bounded(db, timeoutMs, () =>
    dbAll<{ name: string }>(
      db,
      "select name from sqlite_master where type = 'table' and name not like 'sqlite\\_%' escape '\\' order by name",
    ),
  );
  return rows.map((r) => r.name);
}

// PRAGMA cannot bind table names; callers supply an allow-listed table
// (spec/protocol.md §6).
async function allowedColumns(db: Database, table: string, timeoutMs: number): Promise<string[]> {
  const quoted = quoteIdent(table);
  const rows = await bounded(db, timeoutMs, () =>
    dbAll<{ cid: number; name: string }>(db, `select cid, name from pragma_table_info(${quoted}) order by cid`),
  );
  return rows.map((r) => r.name);
}

// Composite FKs are omitted rather than risk mislabeling columns (spec/protocol.md §5.4.1).
async function keyMetadata(
  db: Database,
  table: string,
  timeoutMs: number,
): Promise<{ pkColumns: Set<string>; fkColumns: Map<string, ColumnRef> }> {
  const quoted = quoteIdent(table);
  const { cols, fks } = await bounded(db, timeoutMs, async () => {
    const cols = await dbAll<{ cid: number; name: string; pk: number }>(
      db,
      `select cid, name, pk from pragma_table_info(${quoted}) order by cid`,
    );
    // (id, seq, table, from, to) — `id` groups columns belonging to the
    // same constraint (composite FKs share an id). The quoted
    // "table"/"from"/"to" are pragma_foreign_key_list's own fixed output
    // column names (SQL keywords needing escape), not the caller-supplied
    // table.
    const fks = await dbAll<{ id: number; seq: number; table: string; from: string; to: string }>(
      db,
      `select id, seq, "table", "from", "to" from pragma_foreign_key_list(${quoted})`,
    );
    return { cols, fks };
  });

  const pkColumns = new Set(cols.filter((c) => c.pk > 0).map((c) => c.name));

  const byConstraint = new Map<number, { from: string; refTable: string; to: string }[]>();
  for (const fk of fks) {
    const list = byConstraint.get(fk.id) ?? [];
    list.push({ from: fk.from, refTable: fk.table, to: fk.to });
    byConstraint.set(fk.id, list);
  }
  const fkColumns = new Map<string, ColumnRef>();
  for (const members of byConstraint.values()) {
    if (members.length !== 1) continue; // composite FK: omit entirely
    const { from, refTable, to } = members[0];
    // SQLite has no schema namespace (see ONLY_SCHEMA), so `schema` is
    // never set here.
    fkColumns.set(from, { table: refTable, column: to });
  }
  return { pkColumns, fkColumns };
}

/** SQLite filter SQL uses `?`, `CAST(... AS TEXT)`, and `LIKE` for `ILIKE`. */
function buildWhereClauseSqlite(conditions: Condition[], columnNames: string[]): { where: string; values: string[] } {
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
    const keyword = cond.op === "ILIKE" ? "LIKE" : opSql(cond.op);
    const cast = `CAST(${quoteIdent(cond.column)} AS TEXT)`;

    let inner: string;
    if (opTakesValue(cond.op)) {
      if (cond.value === undefined) {
        throw new FilterError(`op "${cond.op}" requires a value`);
      }
      values.push(cond.value);
      inner = `${cast} ${keyword} ?`;
    } else {
      inner = `${cast} ${keyword}`;
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

/** SQLite implementation; see docs/adapter-decisions.md for protocol differences. */
export class SqliteSource implements DbSource {
  constructor(private readonly db: Database) {}

  // timeoutMs is part of DbSource's signature but unused here — no
  // catalog to query, SQLite always has exactly one schema.
  async listSchemas(): Promise<string[]> {
    return [ONLY_SCHEMA];
  }

  async listTables(schema: string | undefined, timeoutMs: number): Promise<TableInfo[]> {
    checkSchema(schema);
    const names = await allowedTables(this.db, timeoutMs);
    // No obj_description equivalent in SQLite — comments unsupported.
    return names.map((name) => ({ name }));
  }

  async tableCounts(schema: string | undefined, timeoutMs: number): Promise<CountEntry[]> {
    checkSchema(schema);
    const tables = await allowedTables(this.db, timeoutMs);
    // SQLite has no reltuples-equivalent catalog estimate; -1 is the
    // documented "no estimate" sentinel (spec/protocol.md §5.3) rather
    // than a per-table COUNT(*) scan.
    return tables.map((table) => ({ table, approx_rows: -1 }));
  }

  async queryTable(schema: string | undefined, table: string, opts: QueryOpts, timeoutMs: number): Promise<TableData> {
    checkSchema(schema);
    const tables = await allowedTables(this.db, timeoutMs);
    const realTable = findExact(tables, table);
    if (!realTable) {
      throw new NotAllowedError(`table "${table}"`);
    }

    const columnNames = await allowedColumns(this.db, realTable, timeoutMs);
    let sort: string | undefined;
    if (opts.sort !== undefined) {
      sort = findExact(columnNames, opts.sort);
      if (!sort) {
        throw new NotAllowedError(`column "${opts.sort}"`);
      }
    }

    const { where: whereClause, values: filterValues } = buildWhereClauseSqlite(opts.filter, columnNames);
    const { pkColumns, fkColumns } = await keyMetadata(this.db, realTable, timeoutMs);

    const quotedTable = quoteIdent(realTable);
    const columnTypes = await bounded(this.db, timeoutMs, () =>
      dbAll<{ cid: number; name: string; type: string }>(
        this.db,
        `select cid, name, type from pragma_table_info(${quotedTable}) order by cid`,
      ),
    );

    const columns: ColumnInfo[] = columnTypes.map((ct) => {
      const col: ColumnInfo = {
        name: ct.name,
        // SQLite's declared column types can be empty (""); fall back to
        // a stable label rather than emitting "".
        type: ct.type && ct.type.length > 0 ? ct.type : "unknown",
      };
      if (pkColumns.has(ct.name)) {
        col.key = "pk";
        if (fkColumns.has(ct.name)) col.references = fkColumns.get(ct.name);
      } else if (fkColumns.has(ct.name)) {
        col.key = "fk";
        col.references = fkColumns.get(ct.name);
      }
      return col;
    });

    // Aliased back to the real column name: an un-aliased CAST(...)
    // expression's result-set label is the literal expression text on
    // SQLite (confirmed empirically), not the source column name — row
    // access by name below (cellToJson via col.name) would otherwise
    // silently read undefined for every cell.
    const selectList = columns.map((c) => `CAST(${quoteIdent(c.name)} AS TEXT) AS ${quoteIdent(c.name)}`).join(", ");
    const orderClause =
      sort !== undefined ? ` order by ${quotedTable}.${quoteIdent(sort)} ${opts.descending ? "desc" : "asc"}` : "";
    const sql = `select ${selectList} from ${quotedTable}${whereClause}${orderClause} limit ? offset ?`;
    const params = [...filterValues, opts.limit, opts.offset];

    const rows = await bounded(this.db, timeoutMs, () => dbAll<Record<string, unknown>>(this.db, sql, params));
    const outRows: Record<string, string | null>[] = rows.map((row) => {
      const out: Record<string, string | null> = {};
      for (const col of columns) {
        out[col.name] = cellToJson(row[col.name]);
      }
      return out;
    });

    return {
      columns,
      rows: outRows,
      // No reltuples-equivalent estimate to read; -1 is the documented
      // "no estimate" sentinel (spec/protocol.md §5.4.4), not a second
      // COUNT(*) scan on every page load.
      total_approx: -1,
    };
  }

  async commonValues(
    schema: string | undefined,
    table: string,
    column: string,
    timeoutMs: number,
  ): Promise<CommonValueEntry[]> {
    checkSchema(schema);
    const tables = await allowedTables(this.db, timeoutMs);
    const realTable = findExact(tables, table);
    if (!realTable) {
      throw new NotAllowedError(`table "${table}"`);
    }
    const columnNames = await allowedColumns(this.db, realTable, timeoutMs);
    if (!findExact(columnNames, column)) {
      throw new NotAllowedError(`column "${column}"`);
    }
    // No pg_stats equivalent to read; an empty list is the documented "no
    // statistics available" answer (spec/protocol.md §5.5), not a live
    // GROUP BY scan.
    return [];
  }
}
