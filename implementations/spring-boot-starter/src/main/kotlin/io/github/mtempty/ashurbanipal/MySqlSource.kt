package io.github.mtempty.ashurbanipal

import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.jdbc.datasource.DataSourceUtils
import org.springframework.transaction.support.TransactionTemplate
import java.sql.PreparedStatement
import java.sql.ResultSet
import java.sql.SQLException
import java.sql.Types
import java.util.concurrent.atomic.AtomicReference
import javax.sql.DataSource

/** Selects fork-specific query timeout syntax (`spec/protocol.md` §6). */
internal enum class Variant { MYSQL, MARIADB }

/** MariaDB ignores MySQL timeout hints, so it needs a statement wrapper (`spec/protocol.md` §6). */
internal fun timedSelect(variant: Variant, timeoutSecs: Int, body: String): String = when (variant) {
    Variant.MYSQL -> "select /*+ MAX_EXECUTION_TIME(${timeoutSecs.toLong() * 1000}) */ $body"
    Variant.MARIADB -> "set statement max_statement_time=$timeoutSecs for select $body"
}

/** Backtick-escape live-catalog identifiers for MySQL (`spec/protocol.md` §5). */
private fun quoteIdentMysql(ident: String): String = "`" + ident.replace("`", "``") + "`"

/** Maps ILIKE through LOWER for collation independence (`spec/protocol.md` §5.4.2). */
private fun buildWhereClauseMysql(conditions: List<Condition>, columnNames: List<String>): WhereClause {
    if (conditions.isEmpty()) {
        return WhereClause("", emptyList())
    }
    val values = mutableListOf<String>()
    val clause = StringBuilder()
    conditions.forEachIndexed { i, condition ->
        val column = columnNames.find { it == condition.column }
            ?: throw NotAllowedException("not allowed: column ${condition.column}")
        val cast = "CAST(${quoteIdentMysql(column)} AS CHAR)"

        val inner = if (condition.op == "ILIKE") {
            val value = condition.value ?: throw FilterException("op ${condition.op} requires a value")
            values.add(value)
            "LOWER($cast) LIKE LOWER(?)"
        } else if (condition.op !in OPS_WITHOUT_VALUE) {
            val value = condition.value ?: throw FilterException("op ${condition.op} requires a value")
            values.add(value)
            "$cast ${opSqlKeyword(condition.op)} ?"
        } else {
            "$cast ${opSqlKeyword(condition.op)}"
        }
        val wrapped = if (condition.not) "(NOT ($inner))" else "($inner)"

        if (i > 0) {
            clause.append(if (condition.logic == "OR") " OR " else " AND ")
        }
        clause.append(wrapped)
    }
    return WhereClause(" where $clause", values)
}

private fun bindParams(ps: PreparedStatement, params: List<Any?>) {
    params.forEachIndexed { i, param ->
        when (param) {
            is Long -> ps.setLong(i + 1, param)
            is Int -> ps.setInt(i + 1, param)
            is String -> ps.setString(i + 1, param)
            null -> ps.setNull(i + 1, Types.NULL)
            else -> ps.setObject(i + 1, param)
        }
    }
}

/** Connector/J rejects MariaDB's wrapper in executeQuery; use execute instead (`spec/protocol.md` §6). */
private fun <T> query(dataSource: DataSource, sql: String, params: List<Any?> = emptyList(), mapper: (ResultSet) -> T): List<T> {
    val conn = DataSourceUtils.getConnection(dataSource)
    try {
        conn.prepareStatement(sql).use { ps ->
            bindParams(ps, params)
            ps.execute()
            // getResultSet is nullable after non-SELECT statements.
            val rs: ResultSet? = ps.resultSet
            checkNotNull(rs) { "query produced no result set: $sql" }
            rs.use {
                val results = mutableListOf<T>()
                while (rs.next()) {
                    results.add(mapper(rs))
                }
                return results
            }
        }
    } finally {
        DataSourceUtils.releaseConnection(conn, dataSource)
    }
}

private data class ConstraintRow(
    val constraintName: String,
    val constraintType: String,
    val columnName: String,
    val refSchema: String?,
    val refTable: String?,
    val refColumn: String?,
)

private data class FkCandidate(val columnName: String, val refSchema: String?, val refTable: String?, val refColumn: String?)

/** MySQL/MariaDB [DbSource] (`spec/protocol.md` §5). */
class MySqlSource(private val dataSource: DataSource, private val queryTimeoutSecs: Int) : DbSource {
    private val transactionTemplate = TransactionTemplate(DataSourceTransactionManager(dataSource)).apply {
        isReadOnly = true
    }
    private val variantRef = AtomicReference<Variant?>(null)

    private fun <T> inReadOnlyTransaction(action: () -> T): T =
        transactionTemplate.execute { action() }
            ?: throw IllegalStateException("read-only transaction did not produce a result")

    /** Cache whether SELECT VERSION() contains MariaDB (`spec/protocol.md` §6). */
    internal fun variant(): Variant {
        variantRef.get()?.let { return it }
        val version = query(dataSource, "select version()") { rs -> rs.getString(1) }.first()
        val detected = if (version.lowercase().contains("mariadb")) Variant.MARIADB else Variant.MYSQL
        variantRef.compareAndSet(null, detected)
        return variantRef.get()!!
    }

    private fun listAllowedSchemas(variant: Variant): List<String> =
        query(
            dataSource,
            timedSelect(
                variant,
                queryTimeoutSecs,
                "schema_name from information_schema.schemata " +
                    "where schema_name not in ('mysql', 'information_schema', 'performance_schema', 'sys') " +
                    "order by schema_name",
            ),
        ) { rs -> rs.getString(1) }

    /** Reads MySQL's default database (`spec/protocol.md` §5). */
    private fun resolveSchema(variant: Variant, requested: String?): String {
        val schemas = listAllowedSchemas(variant)
        // Preserve null from database() for a clear rejection.
        val resolved = requested ?: query<String?>(
            dataSource,
            timedSelect(variant, queryTimeoutSecs, "database()"),
        ) { rs -> rs.getString(1) }.first()
            ?: throw NotAllowedException("no schema requested and this connection has no default database")
        return schemas.find { it == resolved } ?: throw NotAllowedException("not allowed: schema $resolved")
    }

    private fun allowedTables(variant: Variant, schema: String): List<String> =
        query(
            dataSource,
            timedSelect(
                variant,
                queryTimeoutSecs,
                "table_name from information_schema.tables " +
                    "where table_schema = ? and table_type = 'BASE TABLE' " +
                    "order by table_name",
            ),
            listOf(schema),
        ) { rs -> rs.getString(1) }

    private fun allowedColumns(variant: Variant, schema: String, table: String): List<String> =
        query(
            dataSource,
            timedSelect(
                variant,
                queryTimeoutSecs,
                "column_name from information_schema.columns " +
                    "where table_schema = ? and table_name = ? " +
                    "order by ordinal_position",
            ),
            listOf(schema, table),
        ) { rs -> rs.getString(1) }

    private fun requireTable(variant: Variant, schema: String, table: String): String =
        allowedTables(variant, schema).find { it == table } ?: throw NotAllowedException("not allowed: table $table")

    /** Join MySQL's repeating PRIMARY name on table name; omit composite FKs (`spec/protocol.md` §5.4.1). */
    private fun keyMetadata(variant: Variant, schema: String, table: String): Pair<Set<String>, Map<String, ColumnRef>> {
        val rows = query(
            dataSource,
            timedSelect(
                variant,
                queryTimeoutSecs,
                "tc.constraint_name, tc.constraint_type, kcu.column_name, " +
                    "kcu.referenced_table_schema, kcu.referenced_table_name, kcu.referenced_column_name " +
                    "from information_schema.table_constraints tc " +
                    "join information_schema.key_column_usage kcu " +
                    "  on kcu.constraint_name = tc.constraint_name " +
                    " and kcu.table_schema = tc.table_schema " +
                    " and kcu.table_name = tc.table_name " +
                    "where tc.table_schema = ? and tc.table_name = ? " +
                    "  and tc.constraint_type in ('PRIMARY KEY', 'FOREIGN KEY')",
            ),
            listOf(schema, table),
        ) { rs ->
            ConstraintRow(
                rs.getString(1), rs.getString(2), rs.getString(3),
                rs.getString(4), rs.getString(5), rs.getString(6),
            )
        }

        val pkColumns = mutableSetOf<String>()
        val fkCandidates = mutableMapOf<String, MutableList<FkCandidate>>()
        for (row in rows) {
            when (row.constraintType) {
                "PRIMARY KEY" -> pkColumns.add(row.columnName)
                "FOREIGN KEY" -> fkCandidates.getOrPut(row.constraintName) { mutableListOf() }
                    .add(FkCandidate(row.columnName, row.refSchema, row.refTable, row.refColumn))
            }
        }
        val fkColumns = mutableMapOf<String, ColumnRef>()
        for (members in fkCandidates.values) {
            val distinctColumns = members.map { it.columnName }.toSet()
            if (distinctColumns.size != 1) continue
            val first = members.first()
            val refSchema = first.refSchema
            val refTable = first.refTable
            val refColumn = first.refColumn
            if (refSchema != null && refTable != null && refColumn != null) {
                val fkSchema = if (refSchema != schema) refSchema else null
                fkColumns[first.columnName] = ColumnRef(refTable, refColumn, fkSchema)
            }
        }
        return pkColumns to fkColumns
    }

    override fun listSchemas(): List<String> = inReadOnlyTransaction { listAllowedSchemas(variant()) }

    override fun listTables(schema: String?): List<TableInfo> = inReadOnlyTransaction {
        val variant = variant()
        val realSchema = resolveSchema(variant, schema)
        query(
            dataSource,
            timedSelect(
                variant,
                queryTimeoutSecs,
                "table_name, table_comment from information_schema.tables " +
                    "where table_schema = ? and table_type = 'BASE TABLE' " +
                    "order by table_name",
            ),
            listOf(realSchema),
        ) { rs -> TableInfo(rs.getString(1), rs.getString(2)?.takeIf { it.isNotEmpty() }) }
    }

    override fun tableCounts(schema: String?): List<CountEntry> = inReadOnlyTransaction {
        val variant = variant()
        val realSchema = resolveSchema(variant, schema)
        // TABLE_ROWS may be stale; NULL means no estimate yet (-1) (`spec/protocol.md` §5.3).
        query(
            dataSource,
            timedSelect(
                variant,
                queryTimeoutSecs,
                "table_name, cast(table_rows as signed) from information_schema.tables " +
                    "where table_schema = ? and table_type = 'BASE TABLE' " +
                    "order by table_name",
            ),
            listOf(realSchema),
        ) { rs ->
            val name = rs.getString(1)
            val count = rs.getLong(2)
            // wasNull() reflects the most recent getXXX call — must be
            // checked right after getLong(2), before any other getter.
            CountEntry(name, if (rs.wasNull()) -1L else count)
        }
    }

    override fun queryTable(schema: String?, table: String, opts: QueryOpts): TableData = inReadOnlyTransaction {
        val variant = variant()
        val realSchema = resolveSchema(variant, schema)
        val realTable = requireTable(variant, realSchema, table)
        val columnNames = allowedColumns(variant, realSchema, realTable)

        val sort = opts.sort?.let { requested ->
            columnNames.find { it == requested } ?: throw NotAllowedException("not allowed: column $requested")
        }

        val whereClause = opts.filter?.let { buildWhereClauseMysql(it, columnNames) } ?: WhereClause("", emptyList())

        val columnMeta = query(
            dataSource,
            timedSelect(
                variant,
                queryTimeoutSecs,
                "column_name, data_type, column_comment from information_schema.columns " +
                    "where table_schema = ? and table_name = ? order by ordinal_position",
            ),
            listOf(realSchema, realTable),
        ) { rs -> Triple(rs.getString(1), rs.getString(2), rs.getString(3)) }

        val (pkColumns, fkColumns) = keyMetadata(variant, realSchema, realTable)
        val columns = columnMeta.map { (name, typeName, comment) ->
            val key: String?
            val references: ColumnRef?
            when {
                pkColumns.contains(name) -> { key = "pk"; references = fkColumns[name] }
                fkColumns.containsKey(name) -> { key = "fk"; references = fkColumns[name] }
                else -> { key = null; references = null }
            }
            ColumnInfo(name, typeName, key, references, comment?.takeIf { it.isNotEmpty() })
        }

        val selectList = columns.joinToString(", ") { "CAST(${quoteIdentMysql(it.name)} AS CHAR)" }
        val orderClause = sort?.let {
            " order by ${quoteIdentMysql(realTable)}.${quoteIdentMysql(it)} ${if (opts.descending) "desc" else "asc"}"
        } ?: ""
        val sql = timedSelect(
            variant,
            queryTimeoutSecs,
            "$selectList from ${quoteIdentMysql(realSchema)}.${quoteIdentMysql(realTable)}" +
                "${whereClause.sql}$orderClause limit ? offset ?",
        )

        val bindArgs = mutableListOf<Any?>()
        bindArgs.addAll(whereClause.values)
        bindArgs.add(opts.limit)
        bindArgs.add(opts.offset)

        val rows = try {
            query(dataSource, sql, bindArgs) { rs -> rowToJson(rs, columns) }
        } catch (e: SQLException) {
            // MySQL has no SELECT privilege gate; map residual 1142 to NotAllowed.
            if (e.errorCode == 1142) {
                throw NotAllowedException("not allowed: table $realTable")
            }
            throw e
        }

        val totalApprox = query(
            dataSource,
            timedSelect(
                variant,
                queryTimeoutSecs,
                "cast(table_rows as signed) from information_schema.tables where table_schema = ? and table_name = ?",
            ),
            listOf(realSchema, realTable),
        ) { rs ->
            val count = rs.getLong(1)
            if (rs.wasNull()) -1L else count
        }.firstOrNull() ?: -1L

        TableData(columns, rows, totalApprox)
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

    /** MySQL has no portable common-value statistics (`spec/protocol.md` §5.5). */
    override fun commonValues(schema: String?, table: String, column: String): List<CommonValueEntry> = inReadOnlyTransaction {
        val variant = variant()
        val realSchema = resolveSchema(variant, schema)
        val realTable = requireTable(variant, realSchema, table)
        allowedColumns(variant, realSchema, realTable).find { it == column }
            ?: throw NotAllowedException("not allowed: column $column")
        emptyList()
    }
}
