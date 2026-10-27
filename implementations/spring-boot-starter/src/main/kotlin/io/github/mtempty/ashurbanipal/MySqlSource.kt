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
            ?: throw NotAllowedException("not allowed: column ${condition.column}", NotAllowedKind.COLUMN)
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

private val JOIN_DIALECT = JoinDialect(
    quote = ::quoteIdentMysql,
    castText = { "CAST($it AS CHAR)" },
    ilike = "lowered-like",
)

/** `spec/protocol.md` §5.11.2; the mapping is in `docs/adapter-decisions.md` §5.11. */
internal fun mysqlTypeClass(dataType: String, columnType: String): TypeClass? = when (dataType.lowercase()) {
    "tinyint", "smallint", "mediumint", "int", "integer", "bigint", "decimal", "numeric" -> TypeClass.NUMBER
    "char", "varchar", "tinytext", "text", "mediumtext", "longtext" -> TypeClass.TEXT
    "date", "datetime", "timestamp" -> TypeClass.TEMPORAL
    "time" -> TypeClass.TIME
    "binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob" -> TypeClass.BINARY
    "uuid" -> TypeClass.UUID
    "enum" -> TypeClass.enum(columnType)
    else -> null
}

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

    /** Null when the connection names no database. */
    private fun defaultSchema(variant: Variant): String? =
        query<String?>(
            dataSource,
            timedSelect(variant, queryTimeoutSecs, "database()"),
        ) { rs -> rs.getString(1) }.first()

    /** Reads MySQL's default database (`spec/protocol.md` §5). */
    private fun resolveSchema(variant: Variant, requested: String?): String {
        val schemas = listAllowedSchemas(variant)
        val resolved = requested
            ?: defaultSchema(variant)
            ?: throw NotAllowedException("no schema requested and this connection has no default database", NotAllowedKind.SCHEMA)
        return schemas.find { it == resolved } ?: throw NotAllowedException("not allowed: schema $resolved", NotAllowedKind.SCHEMA)
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
        allowedTables(variant, schema).find { it == table } ?: throw NotAllowedException("not allowed: table $table", NotAllowedKind.TABLE)

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

    override fun listSchemas(): SchemaListing = inReadOnlyTransaction {
        val variant = variant()
        SchemaListing.of(listAllowedSchemas(variant), defaultSchema(variant))
    }

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

    private fun joinTableMeta(variant: Variant, schema: String, table: String): JoinTableMeta {
        data class Col(val name: String, val type: String, val comment: String?, val collation: String?, val columnType: String)
        val columns = query(
            dataSource,
            timedSelect(
                variant,
                queryTimeoutSecs,
                "column_name, data_type, column_comment, collation_name, column_type from information_schema.columns " +
                    "where table_schema = ? and table_name = ? order by ordinal_position",
            ),
            listOf(schema, table),
        ) { rs -> Col(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5)) }
        val (pkColumns, fkColumns) = keyMetadata(variant, schema, table)
        return JoinTableMeta(
            table,
            columns.map { c ->
                JoinColMeta(
                    name = c.name,
                    type = c.type,
                    cls = mysqlTypeClass(c.type, c.columnType),
                    collation = c.collation?.takeIf { it.isNotEmpty() },
                    key = if (pkColumns.contains(c.name)) "pk" else if (fkColumns.containsKey(c.name)) "fk" else null,
                    references = fkColumns[c.name],
                    comment = c.comment?.takeIf { it.isNotEmpty() },
                )
            },
        )
    }

    override fun queryJoin(schema: String?, spec: JoinSpec, opts: JoinOpts): JoinData = inReadOnlyTransaction {
        val variant = variant()
        val realSchema = resolveSchema(variant, schema)
        val allowed = allowedTables(variant, realSchema)
        val names = spec.tableNames()
        val metas = HashMap<String, JoinTableMeta>()
        for (name in names) {
            if (name in metas) continue
            if (name !in allowed) throw BadJoinException("unknown table \"$name\"")
            metas[name] = joinTableMeta(variant, realSchema, name)
        }
        val plan = planJoin(spec, names.map { metas.getValue(it) }, opts)

        // The statement is built from catalog names and generated aliases
        // only; every value is a bound parameter.
        val (body, values) = buildJoinSelect(plan, JOIN_DIALECT, realSchema)
        val bindArgs: List<Any?> = values + (opts.limit + 1) + opts.offset
        val rows = try {
            query(dataSource, timedSelect(variant, queryTimeoutSecs, body), bindArgs) { rs ->
                List(plan.labels.size) { i -> readCell(rs, i + 1) }
            }
        } catch (e: SQLException) {
            // MySQL has no SELECT privilege gate; map residual 1142 to NotAllowed.
            if (e.errorCode == 1142) {
                throw NotAllowedException("not allowed: table ${spec.table}", NotAllowedKind.NOT_READABLE)
            }
            throw e
        }
        plan.joinData(rows, opts.limit)
    }

    override fun queryTable(schema: String?, table: String, opts: QueryOpts): TableData = inReadOnlyTransaction {
        val variant = variant()
        val realSchema = resolveSchema(variant, schema)
        val realTable = requireTable(variant, realSchema, table)
        val columnNames = allowedColumns(variant, realSchema, realTable)

        val sort = opts.sort?.let { requested ->
            columnNames.find { it == requested } ?: throw NotAllowedException("not allowed: column $requested", NotAllowedKind.COLUMN)
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
                throw NotAllowedException("not allowed: table $realTable", NotAllowedKind.NOT_READABLE)
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
            map[col.name] = readCell(rs, i + 1)
        }
        return map
    }

    /** MySQL has no portable common-value statistics (`spec/protocol.md` §5.5). */
    override fun commonValues(schema: String?, table: String, column: String): List<CommonValueEntry> = inReadOnlyTransaction {
        val variant = variant()
        val realSchema = resolveSchema(variant, schema)
        val realTable = requireTable(variant, realSchema, table)
        allowedColumns(variant, realSchema, realTable).find { it == column }
            ?: throw NotAllowedException("not allowed: column $column", NotAllowedKind.COLUMN)
        emptyList()
    }

    override fun referencedBy(schema: String?, table: String): List<ReferencedByEntry> = inReadOnlyTransaction {
        val variant = variant()
        val realSchema = resolveSchema(variant, schema)
        // One allow-list read, shared by the target-table check and the
        // referrer post-filter below — MySQL/MariaDB have no cross-schema
        // has_table_privilege gate (docs/adapter-decisions.md §5.9).
        val allowed = allowedTables(variant, realSchema).toSet()
        if (table !in allowed) throw NotAllowedException("not allowed: table $table", NotAllowedKind.TABLE)

        // Read key_column_usage, not referential_constraints, whose
        // referenced-name column MariaDB nulls for a role lacking privilege on
        // the referenced table. table_schema = ? keeps referrers to the
        // resolved database.
        val rows = query(
            dataSource,
            timedSelect(
                variant,
                queryTimeoutSecs,
                "kcu.table_name, kcu.constraint_name, kcu.column_name, kcu.referenced_column_name " +
                    "from information_schema.key_column_usage kcu " +
                    "where kcu.referenced_table_schema = ? and kcu.referenced_table_name = ? " +
                    "  and kcu.table_schema = ? " +
                    "order by kcu.table_name, kcu.constraint_name, kcu.ordinal_position",
            ),
            listOf(realSchema, table, realSchema),
        ) { rs ->
            ReferencedByEntry(
                table = rs.getString(1),
                schema = null,
                constraint = rs.getString(2),
                columns = listOf(ColumnPair(rs.getString(3), rs.getString(4))),
            )
        }

        // Keep the referrer set inside the same allow-list every other route
        // on this backend serves from.
        groupReferencedBy(rows.filter { it.table in allowed })
    }

    override fun structure(schema: String?, table: String): Structure = inReadOnlyTransaction {
        val variant = variant()
        val realSchema = resolveSchema(variant, schema)
        val allowed = allowedTables(variant, realSchema).toSet()
        if (table !in allowed) throw NotAllowedException("not allowed: table $table", NotAllowedKind.TABLE)

        // MariaDB's statistics view has no expression column; MySQL 8.0.13+
        // reports a functional key part there with a NULL column_name.
        val keyPart = if (variant == Variant.MARIADB) "s.column_name" else "coalesce(s.column_name, s.expression)"
        val indexRows = query(
            dataSource,
            timedSelect(
                variant,
                queryTimeoutSecs,
                "s.index_name, cast(s.non_unique as signed), s.index_type, $keyPart " +
                    "from information_schema.statistics s " +
                    "where s.table_schema = ? and s.table_name = ? " +
                    "order by s.index_name, s.seq_in_index",
            ),
            listOf(realSchema, table),
        ) { rs -> listOf(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4)) }
        val indexes = ArrayList<IndexInfo>()
        for (r in indexRows) {
            val column = r[3] ?: ""
            val last = indexes.lastOrNull()
            if (last != null && last.name == r[0]) {
                indexes[indexes.size - 1] = last.copy(columns = last.columns + column)
            } else {
                indexes.add(IndexInfo(r[0]!!, listOf(column), unique = r[1] == "0", method = r[2]!!.lowercase()))
            }
        }

        val keyRows = query(
            dataSource,
            timedSelect(
                variant,
                queryTimeoutSecs,
                "tc.constraint_type, tc.constraint_name, kcu.column_name " +
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
            listOf(realSchema, table),
        ) { rs -> Triple(rs.getString(1), rs.getString(2), rs.getString(3)) }
        var primaryKey: ConstraintPk? = null
        val unique = ArrayList<ConstraintUnique>()
        for ((kind, name, column) in keyRows) {
            if (kind == "PRIMARY KEY") {
                primaryKey = ConstraintPk(name = name, columns = (primaryKey?.columns ?: emptyList()) + column)
            } else {
                val last = unique.lastOrNull()
                if (last != null && last.name == name) {
                    unique[unique.size - 1] = last.copy(columns = last.columns + column)
                } else {
                    unique.add(ConstraintUnique(name, listOf(column)))
                }
            }
        }

        // Read key_column_usage for the referenced table, not
        // referential_constraints, which MariaDB nulls for a role lacking
        // privilege on it (same reason as referencedBy).
        val fkRows = query(
            dataSource,
            timedSelect(
                variant,
                queryTimeoutSecs,
                "kcu.constraint_name, kcu.referenced_table_schema, kcu.referenced_table_name, " +
                    "       kcu.column_name, kcu.referenced_column_name, rc.delete_rule, rc.update_rule " +
                    "from information_schema.key_column_usage kcu " +
                    "join information_schema.referential_constraints rc " +
                    "  on rc.constraint_schema = kcu.constraint_schema " +
                    " and rc.constraint_name = kcu.constraint_name " +
                    " and rc.table_name = kcu.table_name " +
                    "where kcu.table_schema = ? and kcu.table_name = ? " +
                    "  and kcu.referenced_table_name is not null " +
                    "order by kcu.constraint_name, kcu.ordinal_position",
            ),
            listOf(realSchema, table),
        ) { rs -> (1..7).map { rs.getString(it) } }
        val foreignKeys = ArrayList<ConstraintFk>()
        for (r in fkRows) {
            val pair = ColumnPair(r[3]!!, r[4]!!)
            val last = foreignKeys.lastOrNull()
            if (last != null && last.name == r[0]) {
                foreignKeys[foreignKeys.size - 1] = last.copy(columns = last.columns + pair)
            } else {
                foreignKeys.add(
                    ConstraintFk(
                        name = r[0]!!,
                        table = r[2]!!,
                        schema = r[1]!!.takeIf { it != realSchema },
                        columns = listOf(pair),
                        onDelete = r[5]!!.uppercase(),
                        onUpdate = r[6]!!.uppercase(),
                    ),
                )
            }
        }

        // MySQL before 8.0.16 has no check_constraints view: report [].
        val hasChecks = query(
            dataSource,
            timedSelect(
                variant,
                queryTimeoutSecs,
                "count(*) from information_schema.tables " +
                    "where table_schema = 'information_schema' and table_name = 'CHECK_CONSTRAINTS'",
            ),
            emptyList(),
        ) { rs -> rs.getLong(1) }.first() > 0
        val check = if (hasChecks) {
            // MariaDB names unnamed table-level checks per table, so its view
            // carries table_name for the join; MySQL's has none.
            val ccTable = if (variant == Variant.MARIADB) "and cc.table_name = tc.table_name " else ""
            query(
                dataSource,
                timedSelect(
                    variant,
                    queryTimeoutSecs,
                    "tc.constraint_name, cc.check_clause " +
                        "from information_schema.table_constraints tc " +
                        "join information_schema.check_constraints cc " +
                        "  on cc.constraint_schema = tc.constraint_schema " +
                        " and cc.constraint_name = tc.constraint_name " + ccTable +
                        "where tc.table_schema = ? and tc.table_name = ? " +
                        "  and tc.constraint_type = 'CHECK' " +
                        "order by tc.constraint_name",
                ),
                listOf(realSchema, table),
            ) { rs -> ConstraintCheck(rs.getString(1), rs.getString(2)) }
        } else {
            emptyList()
        }
        Structure(indexes, Constraints(primaryKey, unique, foreignKeys, check))
    }
}
