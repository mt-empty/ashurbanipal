package io.github.mtempty.ashurbanipal

import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.jdbc.datasource.DataSourceUtils
import org.springframework.transaction.support.TransactionTemplate
import java.sql.PreparedStatement
import java.sql.ResultSet
import java.sql.Types
import java.util.concurrent.atomic.AtomicReference
import javax.sql.DataSource

/**
 * The one MySQL/Connector-J driver speaks the wire protocol both MySQL and
 * MariaDB implement, but the two forks need different SQL for a per-query
 * timeout (see [timedSelect]). Detected once per [MySqlSource] via
 * [MySqlSource.variant] and cached, not re-checked per request — mirrors
 * `implementations/rust/src/db/mysql.rs`'s `Variant`. `internal`, not
 * `private`: [MySqlSourceTest] drives [timedSelect] directly with a
 * deliberately slow query to prove the timeout mechanism actually aborts
 * execution on a real instance.
 */
internal enum class Variant { MYSQL, MARIADB }

/**
 * MySQL's `MAX_EXECUTION_TIME` optimizer hint is spliced right after
 * `select`; MariaDB never implemented that hint (silently ignored, not
 * rejected — reusing it there would fail open), so it instead wraps the
 * whole statement in `SET STATEMENT max_statement_time=N FOR ...` (seconds,
 * not ms). Mirrors `implementations/rust/src/db/mysql.rs::timed_select`.
 * `body` is the SQL text starting right after the `select` keyword this
 * function supplies.
 */
internal fun timedSelect(variant: Variant, timeoutSecs: Int, body: String): String = when (variant) {
    Variant.MYSQL -> "select /*+ MAX_EXECUTION_TIME(${timeoutSecs.toLong() * 1000}) */ $body"
    Variant.MARIADB -> "set statement max_statement_time=$timeoutSecs for select $body"
}

/**
 * MySQL's default identifier quote is the backtick, not `"` — double-quote
 * quoting only works under session-wide `ANSI_QUOTES`, which this starter
 * has no business forcing on a host's connection. Doubling an embedded
 * backtick is MySQL's own documented escape, the same doubling *strategy*
 * the shared [quoteIdent] uses for `"`, just a different character.
 */
private fun quoteIdentMysql(ident: String): String = "`" + ident.replace("`", "``") + "`"

/**
 * MySQL equivalent of [FilterValidator.buildWhereClause]: `?` placeholders,
 * `CAST(col AS CHAR)` instead of `::text` (MySQL has no `::` operator and no
 * `TEXT` cast target), and `ILIKE` mapped to `LOWER(...) LIKE LOWER(?)`
 * rather than a bare keyword swap — MySQL's plain `LIKE` case-sensitivity
 * depends on the column's collation, unlike SQLite's unconditionally
 * case-insensitive `LIKE`. See `docs/adapter-decisions.md` §5.4.2.
 */
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

/**
 * Connector/J's `PreparedStatement.executeQuery()` rejects any SQL that
 * doesn't textually begin with a recognized query keyword — MariaDB's `SET
 * STATEMENT ... FOR SELECT ...` wrapping (see [timedSelect]) trips this
 * client-side check even though the server would return a result set for
 * it (verified empirically: `Statement.executeQuery() cannot issue
 * statements that do not produce result sets"`). `execute()` +
 * `getResultSet()` has no such restriction, so every query in this file
 * goes through this helper rather than `JdbcTemplate`'s `executeQuery`-based
 * convenience methods. See `docs/adapter-decisions.md` §6.
 *
 * Uses [DataSourceUtils] (not a raw `dataSource.connection`) so this
 * participates in the ambient Spring transaction the same way
 * `JdbcTemplate` would — connection pinning across the several catalog
 * queries one operation issues is unaffected by this change.
 */
private fun <T> query(dataSource: DataSource, sql: String, params: List<Any?> = emptyList(), mapper: (ResultSet) -> T): List<T> {
    val conn = DataSourceUtils.getConnection(dataSource)
    try {
        conn.prepareStatement(sql).use { ps ->
            bindParams(ps, params)
            ps.execute()
            ps.resultSet.use { rs ->
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

/**
 * MySQL/MariaDB [DbSource], opt-in via `ashurbanipal.backend=mysql`. Port of
 * `implementations/rust/src/db/mysql.rs`, mechanism-for-mechanism (variant
 * detection, per-statement timeout SQL, backtick identifier quoting). Not
 * run through `conformance/runner` (that suite targets Postgres) — see
 * `docs/adapter-decisions.md` for the per-clause decisions this makes where
 * Postgres-specific catalog/stats mechanisms have no equivalent.
 */
class MySqlSource(private val dataSource: DataSource, private val queryTimeoutSecs: Int) : DbSource {
    private val transactionTemplate = TransactionTemplate(DataSourceTransactionManager(dataSource)).apply {
        isReadOnly = true
    }
    private val variantRef = AtomicReference<Variant?>(null)

    private fun <T> inReadOnlyTransaction(action: () -> T): T =
        transactionTemplate.execute { action() }
            ?: throw IllegalStateException("read-only transaction did not produce a result")

    /**
     * `SELECT VERSION()` returns a string containing `MariaDB` on that fork
     * (e.g. `10.11.6-MariaDB-1:10.11.6+maria~ubu2004`) and just a bare
     * version like `8.0.35` on real MySQL — the standard sniff other
     * drivers use. Cached in an [AtomicReference]; a lost race between
     * concurrent first calls is harmless since both detect the same value.
     */
    internal fun variant(): Variant {
        variantRef.get()?.let { return it }
        val version = query(dataSource, "select version()") { rs -> rs.getString(1) }.first()
        val detected = if (version.lowercase().contains("mariadb")) Variant.MARIADB else Variant.MYSQL
        variantRef.compareAndSet(null, detected)
        return variantRef.get()!!
    }

    /**
     * Excludes MySQL's own internal schemas. There is no single
     * boolean-returning privilege-check function equivalent to Postgres's
     * `has_schema_privilege` — accepted as a documented gap in
     * `docs/adapter-decisions.md` (§5.7's exclusion is a SHOULD, not a MUST).
     */
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

    /** `current_schema()` has no MySQL equivalent; `select database()` is the analogous "connection's own default" read. */
    private fun resolveSchema(variant: Variant, requested: String?): String {
        val schemas = listAllowedSchemas(variant)
        val resolved = requested
            ?: query(dataSource, timedSelect(variant, queryTimeoutSecs, "database()")) { rs -> rs.getString(1) }.first()
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

    /**
     * Composite FKs are dropped, mirroring [PostgresSource]. The join adds
     * `kcu.table_name = tc.table_name` — unlike Postgres's auto-generated,
     * schema-unique constraint names, MySQL's primary-key constraint is
     * *always* literally named `"PRIMARY"` on every table, so joining on
     * `constraint_name` alone would match every other table's primary-key
     * columns in the same schema.
     */
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
        // TABLE_COMMENT sits as a plain column here — no obj_description-style
        // function call needed, unlike Postgres.
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
        // TABLE_ROWS is an InnoDB-statistics estimate (reltuples-equivalent,
        // MAY be stale, refreshed by ANALYZE TABLE) — never COUNT(*). NULL
        // before InnoDB has gathered any statistics for a freshly created
        // table maps to the same -1 "no estimate yet" sentinel Postgres uses
        // before ANALYZE/VACUUM.
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

        // DATA_TYPE and COLUMN_COMMENT both sit as plain columns on
        // information_schema.columns — unlike Postgres, no separate
        // pg_attribute join is needed for comments.
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
                pkColumns.contains(name) -> { key = "pk"; references = null }
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

        val rows = query(dataSource, sql, bindArgs) { rs -> rowToJson(rs, columns) }

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

    /**
     * No `pg_stats` analog exists on MySQL. MySQL 8's
     * `information_schema.column_statistics` histogram needs an explicit
     * `ANALYZE TABLE ... UPDATE HISTOGRAM` to populate, has a structurally
     * different shape (equi-height buckets, not a flat most-common-values
     * array), and doesn't exist at all on MariaDB or MySQL 5.7 — an
     * unconditional empty list is the protocol's own "no statistics
     * available" answer (spec/protocol.md §5.5), not a live scan, mirroring
     * SQLite's identical choice. Table/column are still validated against
     * the live allow-list first.
     */
    override fun commonValues(schema: String?, table: String, column: String): List<CommonValueEntry> = inReadOnlyTransaction {
        val variant = variant()
        val realSchema = resolveSchema(variant, schema)
        val realTable = requireTable(variant, realSchema, table)
        allowedColumns(variant, realSchema, realTable).find { it == column }
            ?: throw NotAllowedException("not allowed: column $column")
        emptyList()
    }
}
