package io.github.mtempty.ashurbanipal

import org.sqlite.ProgressHandler
import java.sql.Connection
import java.sql.ResultSet
import java.time.Instant
import javax.sql.DataSource

/** SQLite has no schema namespace above a single database file — this is the only name [SqliteSource.listSchemas] ever returns. */
private const val ONLY_SCHEMA = "main"

private fun checkSchema(schema: String?) {
    if (schema != null && schema != ONLY_SCHEMA) {
        throw NotAllowedException("not allowed: schema $schema")
    }
}

/** SQLite filters use `CAST(... AS TEXT)` and `LIKE` for `ILIKE`. */
private fun buildWhereClauseSqlite(conditions: List<Condition>, columnNames: List<String>): WhereClause {
    if (conditions.isEmpty()) {
        return WhereClause("", emptyList())
    }
    val values = mutableListOf<String>()
    val clause = StringBuilder()
    conditions.forEachIndexed { i, condition ->
        val column = columnNames.find { it == condition.column }
            ?: throw NotAllowedException("not allowed: column ${condition.column}")
        val keyword = if (condition.op == "ILIKE") "LIKE" else opSqlKeyword(condition.op)
        val cast = "CAST(${quoteIdent(column)} AS TEXT)"

        val inner = if (condition.op !in OPS_WITHOUT_VALUE) {
            val value = condition.value ?: throw FilterException("op ${condition.op} requires a value")
            values.add(value)
            "$cast $keyword ?"
        } else {
            "$cast $keyword"
        }
        val wrapped = if (condition.not) "(NOT ($inner))" else "($inner)"

        if (i > 0) {
            clause.append(if (condition.logic == "OR") " OR " else " AND ")
        }
        clause.append(wrapped)
    }
    return WhereClause(" where $clause", values)
}

private fun bindParams(ps: java.sql.PreparedStatement, params: List<Any?>) {
    params.forEachIndexed { i, param ->
        when (param) {
            is Long -> ps.setLong(i + 1, param)
            is Int -> ps.setInt(i + 1, param)
            is String -> ps.setString(i + 1, param)
            null -> ps.setNull(i + 1, java.sql.Types.NULL)
            else -> ps.setObject(i + 1, param)
        }
    }
}

private fun <T> query(conn: Connection, sql: String, params: List<Any?> = emptyList(), mapper: (ResultSet) -> T): List<T> {
    conn.prepareStatement(sql).use { ps ->
        bindParams(ps, params)
        ps.executeQuery().use { rs ->
            val results = mutableListOf<T>()
            while (rs.next()) {
                results.add(mapper(rs))
            }
            return results
        }
    }
}

/** SQLite source uses a progress handler, not `Statement.setQueryTimeout`, to interrupt running queries. */
class SqliteSource(private val dataSource: DataSource, private val queryTimeoutSecs: Int) : DbSource {

    /** Clears the progress handler before pool reuse so it cannot abort the next query. */
    internal fun <T> bounded(timeoutSecs: Int, block: (Connection) -> T): T {
        dataSource.connection.use { conn ->
            // A pooled connection (e.g. HikariCP) hands back a proxy that
            // fails ProgressHandler's own `instanceof SQLiteConnection`
            // check — unwrap to the raw driver connection just for
            // registering/clearing the handler; regular statements still go
            // through the (possibly proxied) `conn`.
            val sqliteConn = conn.unwrap(org.sqlite.SQLiteConnection::class.java)
            val deadline = Instant.now().plusSeconds(timeoutSecs.toLong())
            ProgressHandler.setHandler(
                sqliteConn,
                1000,
                object : ProgressHandler() {
                    override fun progress(): Int = if (Instant.now().isBefore(deadline)) 0 else 1
                },
            )
            try {
                return block(conn)
            } finally {
                ProgressHandler.clearHandler(sqliteConn)
            }
        }
    }

    private fun allowedTables(): List<String> = bounded(queryTimeoutSecs) { conn ->
        query(
            conn,
            "select name from sqlite_master where type = 'table' and name not like 'sqlite\\_%' escape '\\' order by name",
        ) { rs -> rs.getString(1) }
    }

    /** `table` is validated against [allowedTables] by every caller before reaching here — PRAGMA doesn't accept bound parameters for the table name, so this is the one identifier spliced into a PRAGMA string rather than bound. */
    private fun allowedColumns(table: String): List<String> = bounded(queryTimeoutSecs) { conn ->
        val quoted = quoteIdent(table)
        query(conn, "select cid, name from pragma_table_info($quoted) order by cid") { rs -> rs.getString(2) }
    }

    private fun requireTable(table: String): String =
        allowedTables().find { it == table } ?: throw NotAllowedException("not allowed: table $table")

    /** Composite FKs are dropped, mirroring [PostgresSource]/[MySqlSource]. */
    private fun keyMetadata(table: String): Pair<List<String>, Map<String, ColumnRef>> = bounded(queryTimeoutSecs) { conn ->
        val quoted = quoteIdent(table)
        val cols = query(conn, "select cid, name, pk from pragma_table_info($quoted) order by cid") { rs ->
            Triple(rs.getLong(1), rs.getString(2), rs.getLong(3))
        }
        val pkColumns = cols.filter { it.third > 0 }.map { it.second }

        // (id, seq, table, from, to) — `id` groups columns belonging to the
        // same constraint (composite FKs share an id). The quoted
        // "table"/"from"/"to" are pragma_foreign_key_list's own fixed output
        // column names (SQL keywords needing escape), not the caller-supplied
        // table.
        data class FkRow(val id: Long, val refTable: String, val from: String, val to: String)
        val fks = query(conn, "select id, seq, \"table\", \"from\", \"to\" from pragma_foreign_key_list($quoted)") { rs ->
            FkRow(rs.getLong(1), rs.getString(3), rs.getString(4), rs.getString(5))
        }
        val fkColumns = mutableMapOf<String, ColumnRef>()
        for (members in fks.groupBy { it.id }.values) {
            if (members.size != 1) continue
            val m = members.first()
            // SQLite has no schema namespace (see ONLY_SCHEMA).
            fkColumns[m.from] = ColumnRef(m.refTable, m.to, null)
        }
        pkColumns to fkColumns
    }

    override fun listSchemas(): List<String> = listOf(ONLY_SCHEMA)

    override fun listTables(schema: String?): List<TableInfo> {
        checkSchema(schema)
        // No obj_description equivalent in SQLite — comments unsupported.
        return allowedTables().map { TableInfo(it, null) }
    }

    override fun tableCounts(schema: String?): List<CountEntry> {
        checkSchema(schema)
        // SQLite has no reltuples-equivalent catalog estimate; -1 is the
        // documented "no estimate" sentinel (spec/protocol.md §5.3) rather
        // than a per-table COUNT(*) scan. See docs/adapter-decisions.md.
        return allowedTables().map { CountEntry(it, -1L) }
    }

    override fun queryTable(schema: String?, table: String, opts: QueryOpts): TableData {
        checkSchema(schema)
        val realTable = requireTable(table)
        val columnNames = allowedColumns(realTable)

        val sort = opts.sort?.let { requested ->
            columnNames.find { it == requested } ?: throw NotAllowedException("not allowed: column $requested")
        }

        val whereClause = opts.filter?.let { buildWhereClauseSqlite(it, columnNames) } ?: WhereClause("", emptyList())
        val (pkColumns, fkColumns) = keyMetadata(realTable)

        val quotedTable = quoteIdent(realTable)
        val columnTypes = bounded(queryTimeoutSecs) { conn ->
            query(conn, "select cid, name, type from pragma_table_info($quotedTable) order by cid") { rs ->
                rs.getString(2) to rs.getString(3)
            }
        }

        val columns = columnTypes.map { (name, typeName) ->
            val key: String?
            val references: ColumnRef?
            when {
                pkColumns.contains(name) -> { key = "pk"; references = fkColumns[name] }
                fkColumns.containsKey(name) -> { key = "fk"; references = fkColumns[name] }
                else -> { key = null; references = null }
            }
            // SQLite's declared column types can be empty (dynamic typing);
            // fall back to a stable label rather than emitting "".
            ColumnInfo(name, typeName?.takeIf { it.isNotEmpty() } ?: "unknown", key, references, null)
        }

        val selectList = columns.joinToString(", ") { "CAST(${quoteIdent(it.name)} AS TEXT)" }
        val orderClause = sort?.let {
            " order by ${quoteIdent(realTable)}.${quoteIdent(it)} ${if (opts.descending) "desc" else "asc"}"
        } ?: ""
        val sql = "select $selectList from $quotedTable${whereClause.sql}$orderClause limit ? offset ?"

        val bindArgs = mutableListOf<Any?>()
        bindArgs.addAll(whereClause.values)
        bindArgs.add(opts.limit)
        bindArgs.add(opts.offset)

        val rows = bounded(queryTimeoutSecs) { conn ->
            query(conn, sql, bindArgs) { rs -> rowToJson(rs, columns) }
        }

        // No reltuples-equivalent estimate to read; -1 is the documented
        // "no estimate" sentinel (spec/protocol.md §5.4.4), not a second
        // COUNT(*) scan on every page load.
        return TableData(columns, rows, -1L)
    }

    private fun rowToJson(rs: ResultSet, columns: List<ColumnInfo>): LinkedHashMap<String, String?> {
        val map = LinkedHashMap<String, String?>(columns.size)
        for ((i, col) in columns.withIndex()) {
            val value = try {
                rs.getString(i + 1)
            } catch (e: Exception) {
                "<undecodable>"
            }
            map[col.name] = value
        }
        return map
    }

    /**
     * No `pg_stats` analog exists on SQLite. An unconditional empty list is
     * the protocol's own "no statistics available" answer
     * (spec/protocol.md §5.5), not a live `GROUP BY` scan. Table/column are
     * still validated against the live allow-list first.
     */
    override fun commonValues(schema: String?, table: String, column: String): List<CommonValueEntry> {
        checkSchema(schema)
        val realTable = requireTable(table)
        allowedColumns(realTable).find { it == column } ?: throw NotAllowedException("not allowed: column $column")
        return emptyList()
    }
}
