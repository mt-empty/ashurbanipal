package io.github.mtempty.ashurbanipal

import org.springframework.dao.DataAccessException
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.sql.ResultSet
import java.sql.SQLException
import javax.sql.DataSource

/** Postgres [DbSource]; queryTimeout bounds catalog and data operations (`spec/protocol.md` §6). */
class PostgresSource(dataSource: DataSource, queryTimeoutSecs: Int, private val filterValidator: FilterValidator) : DbSource {
    private val jdbcTemplate = JdbcTemplate(dataSource).apply {
        queryTimeout = queryTimeoutSecs
    }
    private val transactionTemplate = TransactionTemplate(DataSourceTransactionManager(dataSource)).apply {
        isReadOnly = true
    }

    private fun <T> inReadOnlyTransaction(action: () -> T): T =
        transactionTemplate.execute { action() }
            ?: throw IllegalStateException("read-only transaction did not produce a result")

    override fun listSchemas(): List<String> = listAllowedSchemas()

    private fun listAllowedSchemas(): List<String> =
        jdbcTemplate.queryForList(
            "select nspname from pg_namespace " +
                "where nspname not in ('pg_catalog', 'information_schema') " +
                "  and nspname not like 'pg_toast%' " +
                "  and nspname not like 'pg_temp\\_%' escape '\\' " +
                "  and has_schema_privilege(nspname, 'USAGE') " +
                "order by nspname",
            String::class.java,
        ).filterNotNull()

    /** Resolve inside the operation transaction to prevent pool-session drift (`spec/protocol.md` §5). */
    private fun resolveSchema(requested: String?): String {
        val schemas = listAllowedSchemas()
        val resolved = requested
            ?: jdbcTemplate.queryForObject("select current_schema()", String::class.java)!!
        return schemas.find { it == resolved } ?: throw NotAllowedException("not allowed: schema $resolved")
    }

    override fun listTables(schema: String?): List<TableInfo> {
        val realSchema = resolveSchema(schema)
        return jdbcTemplate.query(
            "select c.relname::text, obj_description(c.oid, 'pg_class') " +
                "from pg_class c " +
                "join pg_namespace n on n.oid = c.relnamespace " +
                "where n.nspname = ? and c.relkind = 'r' " +
                "  and has_table_privilege(c.oid, 'SELECT') " +
                "order by c.relname",
            RowMapper { rs, _ -> TableInfo(rs.getString(1), rs.getString(2)) },
            realSchema,
        )
    }

    override fun tableCounts(schema: String?): List<CountEntry> {
        val realSchema = resolveSchema(schema)
        return jdbcTemplate.query(
            "select c.relname::text, c.reltuples::bigint " +
                "from pg_class c " +
                "join pg_namespace n on n.oid = c.relnamespace " +
                "where n.nspname = ? and c.relkind = 'r' " +
                "  and has_table_privilege(c.oid, 'SELECT') " +
                "order by c.relname",
            RowMapper { rs, _ -> CountEntry(rs.getString(1), rs.getLong(2)) },
            realSchema,
        )
    }

    // Mirrors listTables' own pg_class/relkind = 'r' predicate, not
    // information_schema.tables' broader BASE TABLE (which also matches
    // partitioned tables) — keeps this allow-list and listTables in
    // lockstep (docs/adapter-decisions.md §5.2/§5.3).
    private fun allowedTables(schema: String): List<String> =
        jdbcTemplate.queryForList(
            "select c.relname from pg_class c " +
                "join pg_namespace n on n.oid = c.relnamespace " +
                "where n.nspname = ? and c.relkind = 'r' " +
                "  and has_table_privilege(c.oid, 'SELECT') " +
                "order by c.relname",
            String::class.java,
            schema,
        ).filterNotNull()

    private fun allowedColumns(schema: String, table: String): List<String> =
        jdbcTemplate.queryForList(
            "select column_name from information_schema.columns " +
                "where table_schema = ? and table_name = ? " +
                "order by ordinal_position",
            String::class.java,
            schema,
            table,
        ).filterNotNull()

    private fun requireTable(schema: String, table: String): String =
        allowedTables(schema).find { it == table } ?: throw NotAllowedException("not allowed: table $table")

    private data class ConstraintRow(
        val constraintName: String,
        val constraintType: String,
        val columnName: String,
        val refSchema: String?,
        val refTable: String?,
        val refColumn: String?,
    )

    private data class FkCandidate(
        val columnName: String,
        val refSchema: String?,
        val refTable: String?,
        val refColumn: String?,
    )

    /** Use constraint_schema for cross-schema FKs; omit composites (`spec/protocol.md` §5.4.1). */
    private fun keyMetadata(schema: String, table: String): Pair<Set<String>, Map<String, ColumnRef>> {
        val rows = jdbcTemplate.query(
            "select tc.constraint_name, tc.constraint_type, kcu.column_name, " +
                "ccu.table_schema as ref_schema, ccu.table_name as ref_table, ccu.column_name as ref_column " +
                "from information_schema.table_constraints tc " +
                "join information_schema.key_column_usage kcu " +
                "  on kcu.constraint_name = tc.constraint_name " +
                " and kcu.table_schema = tc.table_schema " +
                "left join information_schema.constraint_column_usage ccu " +
                "  on ccu.constraint_name = tc.constraint_name " +
                " and ccu.constraint_schema = tc.table_schema " +
                " and tc.constraint_type = 'FOREIGN KEY' " +
                "where tc.table_schema = ? " +
                "  and tc.table_name = ? " +
                "  and tc.constraint_type in ('PRIMARY KEY', 'FOREIGN KEY')",
            RowMapper { rs, _ ->
                ConstraintRow(
                    rs.getString("constraint_name"),
                    rs.getString("constraint_type"),
                    rs.getString("column_name"),
                    rs.getString("ref_schema"),
                    rs.getString("ref_table"),
                    rs.getString("ref_column"),
                )
            },
            schema,
            table,
        )

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
            if (distinctColumns.size != 1) continue // composite FK: omit entirely
            val first = members.first()
            val refSchema = first.refSchema
            val refTable = first.refTable
            val refColumn = first.refColumn
            if (refSchema != null && refTable != null && refColumn != null) {
                // Same-schema references omit schema on the wire (spec/protocol.md §5.4.1).
                val fkSchema = if (refSchema != schema) refSchema else null
                fkColumns[first.columnName] = ColumnRef(refTable, refColumn, fkSchema)
            }
        }
        return pkColumns to fkColumns
    }

    override fun queryTable(schema: String?, table: String, opts: QueryOpts): TableData =
        inReadOnlyTransaction { queryTableInTransaction(schema, table, opts) }

    private fun queryTableInTransaction(schema: String?, table: String, opts: QueryOpts): TableData {
        val realSchema = resolveSchema(schema)
        val realTable = requireTable(realSchema, table)
        val columnNames = allowedColumns(realSchema, realTable)

        val sort = opts.sort?.let { requested ->
            columnNames.find { it == requested } ?: throw NotAllowedException("not allowed: column $requested")
        }

        val whereClause = opts.filter?.let { filterValidator.buildWhereClause(it, columnNames) }
            ?: WhereClause("", emptyList())

        val columnTypes = jdbcTemplate.query(
            "select column_name, data_type from information_schema.columns " +
                "where table_schema = ? and table_name = ? " +
                "order by ordinal_position",
            RowMapper { rs, _ -> rs.getString(1) to rs.getString(2) },
            realSchema,
            realTable,
        )
        // attnum survives dropped columns; ordinal_position does not.
        val columnComments = jdbcTemplate.query(
            "select a.attname::text, col_description(a.attrelid, a.attnum::int) " +
                "from pg_attribute a " +
                "join pg_class c on c.oid = a.attrelid " +
                "join pg_namespace n on n.oid = c.relnamespace " +
                "where n.nspname = ? and c.relname = ? " +
                "  and a.attnum > 0 and not a.attisdropped",
            RowMapper { rs, _ -> rs.getString(1) to rs.getString(2) },
            realSchema,
            realTable,
        ).filter { it.second != null }.associate { it.first to it.second!! }

        val (pkColumns, fkColumns) = keyMetadata(realSchema, realTable)
        val columns = columnTypes.map { (name, typeName) ->
            val key: String?
            val references: ColumnRef?
            when {
                pkColumns.contains(name) -> {
                    key = "pk"
                    references = fkColumns[name]
                }
                fkColumns.containsKey(name) -> {
                    key = "fk"
                    references = fkColumns[name]
                }
                else -> {
                    key = null
                    references = null
                }
            }
            ColumnInfo(name, typeName, key, references, columnComments[name])
        }

        val selectList = columns.joinToString(", ") { "${quoteIdent(it.name)}::text" }
        // Qualify the source column so ORDER BY keeps its native type.
        val orderClause = sort?.let {
            " order by ${quoteIdent(realTable)}.${quoteIdent(it)} ${if (opts.descending) "desc" else "asc"}"
        } ?: ""
        val sql = "select $selectList from ${quoteIdent(realSchema)}.${quoteIdent(realTable)}" +
            "${whereClause.sql}$orderClause limit ? offset ?"

        val bindArgs = mutableListOf<Any>()
        bindArgs.addAll(whereClause.values)
        bindArgs.add(opts.limit)
        bindArgs.add(opts.offset)

        val rows = try {
            jdbcTemplate.query(sql, RowMapper { rs, _ -> rowToJson(rs, columns) }, *bindArgs.toTypedArray())
        } catch (e: DataAccessException) {
            // Map residual SELECT-denied errors to NotAllowed (spec/protocol.md §2).
            if ((e.mostSpecificCause as? SQLException)?.sqlState == "42501") {
                throw NotAllowedException("not allowed: table $realTable")
            }
            throw e
        }

        val totalApprox = jdbcTemplate.queryForObject(
            "select reltuples::bigint from pg_class c " +
                "join pg_namespace n on n.oid = c.relnamespace " +
                "where n.nspname = ? and c.relname = ?",
            Long::class.java,
            realSchema,
            realTable,
        ) ?: -1L

        return TableData(columns, rows, totalApprox)
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

    override fun commonValues(schema: String?, table: String, column: String): List<CommonValueEntry> =
        inReadOnlyTransaction { commonValuesInTransaction(schema, table, column) }

    private fun commonValuesInTransaction(schema: String?, table: String, column: String): List<CommonValueEntry> {
        val realSchema = resolveSchema(schema)
        val realTable = requireTable(realSchema, table)
        val realColumn = allowedColumns(realSchema, realTable).find { it == column }
            ?: throw NotAllowedException("not allowed: column $column")

        // most_common_vals is anyarray; ::text::text[] reads it uniformly.
        // NULL (no ANALYZE stats yet) unnests to zero rows, not an error.
        val rows = jdbcTemplate.query(
            "select t.val, t.freq " +
                "from pg_stats, " +
                "     lateral unnest(most_common_vals::text::text[], most_common_freqs) as t(val, freq) " +
                "where schemaname = ? and tablename = ? and attname = ? " +
                "order by t.freq desc",
            RowMapper { rs, _ -> rs.getString(1) to rs.getFloat(2) },
            realSchema,
            realTable,
            realColumn,
        )

        val dataType = jdbcTemplate.query(
            "select data_type from information_schema.columns " +
                "where table_schema = ? and table_name = ? and column_name = ?",
            RowMapper { rs, _ -> rs.getString(1) },
            realSchema,
            realTable,
            realColumn,
        ).firstOrNull()

        // boolean's array-literal text form is "t"/"f", not "true"/"false" —
        // normalize to match rowToJson's rendering.
        return rows.map { (value, freq) ->
            val normalized = if (dataType == "boolean") {
                when (value) {
                    "t" -> "true"
                    "f" -> "false"
                    else -> value
                }
            } else {
                value
            }
            CommonValueEntry(normalized, freq)
        }
    }

    override fun referencedBy(schema: String?, table: String): List<ReferencedByEntry> =
        inReadOnlyTransaction { referencedByInTransaction(schema, table) }

    private fun referencedByInTransaction(schema: String?, table: String): List<ReferencedByEntry> {
        val realSchema = resolveSchema(schema)

        // Resolved once and bound below (con.confrelid = ?) — the same
        // pg_class/relkind = 'r'/has_table_privilege predicate allowedTables
        // uses, so a partitioned or unknown table rejects here instead of a
        // silent [] from the confrelid join finding zero rows
        // (spec/protocol.md §5.2/§5.9).
        val targetOid = jdbcTemplate.query(
            "select c.oid from pg_class c " +
                "join pg_namespace n on n.oid = c.relnamespace " +
                "where n.nspname = ? and c.relname = ? and c.relkind = 'r' " +
                "  and has_table_privilege(c.oid, 'SELECT')",
            RowMapper { rs, _ -> rs.getLong("oid") },
            realSchema,
            table,
        ).firstOrNull() ?: throw NotAllowedException("not allowed: table $table")

        // pg_catalog, not information_schema: the reverse (confrelid) filter
        // over the standard-SQL views runs 20-40x slower on a large catalog
        // (docs/adapter-decisions.md §5.9). has_table_privilege is the
        // per-referrer read gate and works across schemas, so cross-schema
        // referrers are reported and gated without a separate allow-list pass.
        // conparentid = 0 excludes a partitioned referrer's per-partition
        // constraint copies (Postgres clones the parent's FK onto each
        // partition) — without it, one logical FK fans out into one entry
        // per partition plus the parent.
        val rows = jdbcTemplate.query(
            "select rn.nspname, rc.relname, con.conname, fa.attname as from_col, ta.attname as to_col " +
                "from pg_constraint con " +
                "join pg_class rc on rc.oid = con.conrelid " +
                "join pg_namespace rn on rn.oid = rc.relnamespace " +
                "join lateral unnest(con.conkey, con.confkey) with ordinality " +
                "     as k(from_attnum, to_attnum, n) on true " +
                "join pg_attribute fa on fa.attrelid = con.conrelid and fa.attnum = k.from_attnum " +
                "join pg_attribute ta on ta.attrelid = con.confrelid and ta.attnum = k.to_attnum " +
                "where con.contype = 'f' " +
                "  and con.conparentid = 0 " +
                "  and con.confrelid = ? " +
                "  and has_table_privilege(con.conrelid, 'SELECT') " +
                "order by rn.nspname, rc.relname, con.conname, k.n",
            RowMapper { rs, _ ->
                ReferencedByEntry(
                    table = rs.getString("relname"),
                    schema = rs.getString("nspname").takeIf { it != realSchema },
                    constraint = rs.getString("conname"),
                    columns = listOf(ColumnPair(rs.getString("from_col"), rs.getString("to_col"))),
                )
            },
            targetOid,
        )
        return groupReferencedBy(rows)
    }
}
