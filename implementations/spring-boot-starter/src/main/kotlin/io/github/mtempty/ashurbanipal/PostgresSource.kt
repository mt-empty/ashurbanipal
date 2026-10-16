package io.github.mtempty.ashurbanipal

import org.springframework.dao.DataAccessException
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.sql.ResultSet
import java.sql.SQLException
import javax.sql.DataSource

private val JOIN_DIALECT = JoinDialect(
    quote = ::quoteIdent,
    castText = { "$it::text" },
    ilike = "native",
)

/** `spec/protocol.md` §5.11.2; the mapping is in `docs/adapter-decisions.md` §5.11. */
internal fun pgTypeClass(dataType: String, udtSchema: String, udtName: String, isEnum: Boolean): TypeClass? = when (dataType) {
    "smallint", "integer", "bigint", "numeric" -> TypeClass.NUMBER
    "character varying", "character", "text" -> TypeClass.TEXT
    "uuid" -> TypeClass.UUID
    "boolean" -> TypeClass.BOOLEAN
    "bytea" -> TypeClass.BINARY
    "date", "timestamp without time zone", "timestamp with time zone" -> TypeClass.TEMPORAL
    "time without time zone", "time with time zone" -> TypeClass.TIME
    "USER-DEFINED" -> when {
        isEnum -> TypeClass.enum("$udtSchema.$udtName")
        udtName == "citext" -> TypeClass.TEXT
        else -> null
    }
    else -> null
}

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
        return schemas.find { it == resolved } ?: throw NotAllowedException("not allowed: schema $resolved", NotAllowedKind.SCHEMA)
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

    // Resolves table to its OID iff it's a readable base table in schema —
    // the single existence-and-privilege check every table-scoped
    // operation needs before touching request-supplied SQL. Mirrors
    // listTables' own pg_class/relkind = 'r' predicate, not
    // information_schema.tables' broader BASE TABLE (which also matches
    // partitioned tables) — keeps this gate and listTables in lockstep
    // (docs/adapter-decisions.md §5.2/§5.3). One targeted row instead of
    // fetching every table name in the schema to check membership of one.
    private fun readableTableOid(schema: String, table: String): Long {
        // Postgres text can never hold a NUL byte, so no real relname could
        // ever match one; short-circuit before it reaches the driver, which
        // otherwise throws its own encoding error ahead of the query ever
        // getting a chance to just say "no match" (spec/protocol.md §5.2).
        if (table.contains('\u0000')) {
            throw NotAllowedException("not allowed: table $table", NotAllowedKind.TABLE)
        }
        return jdbcTemplate.query(
            "select c.oid from pg_class c " +
                "join pg_namespace n on n.oid = c.relnamespace " +
                "where n.nspname = ? and c.relname = ? and c.relkind = 'r' " +
                "  and has_table_privilege(c.oid, 'SELECT')",
            RowMapper { rs, _ -> rs.getLong("oid") },
            schema,
            table,
        ).firstOrNull() ?: throw NotAllowedException("not allowed: table $table", NotAllowedKind.TABLE)
    }

    private fun allowedColumns(schema: String, table: String): List<String> =
        jdbcTemplate.queryForList(
            "select column_name from information_schema.columns " +
                "where table_schema = ? and table_name = ? " +
                "order by ordinal_position",
            String::class.java,
            schema,
            table,
        ).filterNotNull()

    private fun requireTable(schema: String, table: String): String {
        readableTableOid(schema, table)
        return table
    }

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

    /** Column metadata of a table already cleared by [requireTable]. */
    private fun joinTableMeta(schema: String, table: String): JoinTableMeta {
        data class Col(val name: String, val type: String, val udtSchema: String, val udtName: String, val isEnum: Boolean)
        val columns = jdbcTemplate.query(
            "select c.column_name, c.data_type, c.udt_schema, c.udt_name, " +
                "       exists (select 1 from pg_type t " +
                "               join pg_namespace n on n.oid = t.typnamespace " +
                "               where n.nspname = c.udt_schema and t.typname = c.udt_name " +
                "                 and t.typtype = 'e') " +
                "from information_schema.columns c " +
                "where c.table_schema = ? and c.table_name = ? " +
                "order by c.ordinal_position",
            RowMapper { rs, _ -> Col(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getBoolean(5)) },
            schema,
            table,
        )
        val comments = columnComments(schema, table)
        val (pkColumns, fkColumns) = keyMetadata(schema, table)
        return JoinTableMeta(
            table,
            columns.map { c ->
                JoinColMeta(
                    name = c.name,
                    type = c.type,
                    cls = pgTypeClass(c.type, c.udtSchema, c.udtName, c.isEnum),
                    key = if (pkColumns.contains(c.name)) "pk" else if (fkColumns.containsKey(c.name)) "fk" else null,
                    references = fkColumns[c.name],
                    comment = comments[c.name],
                )
            },
        )
    }

    override fun queryJoin(schema: String?, spec: JoinSpec, opts: JoinOpts): JoinData = inReadOnlyTransaction {
        val realSchema = resolveSchema(schema)
        val names = spec.tableNames()
        val metas = HashMap<String, JoinTableMeta>()
        for (name in names) {
            if (name in metas) continue
            requireTable(realSchema, name)
            metas[name] = joinTableMeta(realSchema, name)
        }
        val plan = planJoin(spec, names.map { metas.getValue(it) }, opts)

        // The statement is built from catalog names and generated aliases
        // only; every value is a bound parameter.
        val (body, values) = buildJoinSelect(plan, JOIN_DIALECT, realSchema)
        val bindArgs: List<Any> = values + (opts.limit + 1) + opts.offset
        val rows = try {
            jdbcTemplate.query(
                "select $body",
                RowMapper { rs, _ -> List(plan.labels.size) { i -> readCell(rs, i + 1) } },
                *bindArgs.toTypedArray(),
            )
        } catch (e: DataAccessException) {
            val sqlState = (e.mostSpecificCause as? SQLException)?.sqlState
            if (sqlState == "42501") {
                throw NotAllowedException("not allowed: table ${spec.table}", NotAllowedKind.NOT_READABLE)
            }
            if (sqlState == "22021" || sqlState == "22P05") {
                throw FilterException("value invalid for this backend: ${e.mostSpecificCause.message}")
            }
            throw e
        }
        plan.joinData(rows, opts.limit)
    }

    /** `pg_attribute` (not `information_schema`) because attnum survives dropped columns; ordinal_position does not. */
    private fun columnComments(schema: String, table: String): Map<String, String> = jdbcTemplate.query(
        "select a.attname::text, col_description(a.attrelid, a.attnum::int) " +
            "from pg_attribute a " +
            "join pg_class c on c.oid = a.attrelid " +
            "join pg_namespace n on n.oid = c.relnamespace " +
            "where n.nspname = ? and c.relname = ? " +
            "  and a.attnum > 0 and not a.attisdropped",
        RowMapper { rs, _ -> rs.getString(1) to rs.getString(2) },
        schema,
        table,
    ).filter { it.second != null }.associate { it.first to it.second!! }

    private fun queryTableInTransaction(schema: String?, table: String, opts: QueryOpts): TableData {
        val realSchema = resolveSchema(schema)
        val realTable = requireTable(realSchema, table)
        val columnNames = allowedColumns(realSchema, realTable)

        val sort = opts.sort?.let { requested ->
            columnNames.find { it == requested } ?: throw NotAllowedException("not allowed: column $requested", NotAllowedKind.COLUMN)
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
        val columnComments = columnComments(realSchema, realTable)

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
            val sqlState = (e.mostSpecificCause as? SQLException)?.sqlState
            if (sqlState == "42501") {
                throw NotAllowedException("not allowed: table $realTable", NotAllowedKind.NOT_READABLE)
            }
            // A filter value Postgres's text encoding rejects (SQLSTATE
            // 22021/22P05) maps to FilterException, also 400, never a raw
            // 500 (docs/adapter-decisions.md §5.4.2 has the cross-backend
            // rationale).
            if (sqlState == "22021" || sqlState == "22P05") {
                throw FilterException("value invalid for this backend: ${e.mostSpecificCause.message}")
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
            map[col.name] = readCell(rs, i + 1)
        }
        return map
    }

    override fun commonValues(schema: String?, table: String, column: String): List<CommonValueEntry> =
        inReadOnlyTransaction { commonValuesInTransaction(schema, table, column) }

    private fun commonValuesInTransaction(schema: String?, table: String, column: String): List<CommonValueEntry> {
        val realSchema = resolveSchema(schema)
        val realTable = requireTable(realSchema, table)
        val realColumn = allowedColumns(realSchema, realTable).find { it == column }
            ?: throw NotAllowedException("not allowed: column $column", NotAllowedKind.COLUMN)

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
        val targetOid = readableTableOid(realSchema, table)

        // pg_catalog, not information_schema: the reverse (confrelid) filter
        // over the standard-SQL views runs 20-40x slower on a large catalog
        // (docs/adapter-decisions.md §5.9). has_table_privilege is the
        // per-referrer read gate and works across schemas, so cross-schema
        // referrers are reported and gated without a separate allow-list pass.
        // conparentid = 0 excludes a partitioned referrer's per-partition
        // constraint copies (Postgres clones the parent's FK onto each
        // partition) — without it, one logical FK fans out into one entry
        // per partition plus the parent. relkind = 'r' gates the referrer
        // itself the same way targetOid above gates the target: a
        // partitioned table's own (non-inherited) FK constraint survives
        // conparentid = 0 and would otherwise be reported as a referrer
        // name that queryTable/commonValues/referencedBy-as-target then all
        // reject, since none accept relkind = 'p'.
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
                "  and rc.relkind = 'r' " +
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

    override fun structure(schema: String?, table: String): Structure =
        inReadOnlyTransaction { structureInTransaction(schema, table) }

    private fun structureInTransaction(schema: String?, table: String): Structure {
        val realSchema = resolveSchema(schema)
        val oid = readableTableOid(realSchema, table)

        // Key columns only (indnkeyatts): trailing indkey entries are INCLUDE
        // columns. An indkey entry of 0 is an expression with no pg_attribute
        // row, so the join is a left join and the entry renders through
        // pg_get_indexdef instead of vanishing.
        val indexRows = jdbcTemplate.query(
            "select ic.relname::text, am.amname::text, ix.indisunique, " +
                "       pg_get_expr(ix.indpred, ix.indrelid), " +
                "       coalesce(a.attname::text, pg_get_indexdef(ix.indexrelid, k.n::int, true)) " +
                "from pg_index ix " +
                "join pg_class ic on ic.oid = ix.indexrelid " +
                "join pg_am am on am.oid = ic.relam " +
                "join lateral unnest(ix.indkey::int2[]) with ordinality as k(attnum, n) on true " +
                "left join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = k.attnum " +
                "where ix.indrelid = ? and k.n <= ix.indnkeyatts " +
                "order by ic.relname, k.n",
            RowMapper { rs, _ ->
                Triple(
                    listOf(rs.getString(1), rs.getString(2), rs.getString(4)),
                    rs.getBoolean(3),
                    rs.getString(5),
                )
            },
            oid,
        )
        val indexes = ArrayList<IndexInfo>()
        for ((head, unique, column) in indexRows) {
            val last = indexes.lastOrNull()
            if (last != null && last.name == head[0]) {
                indexes[indexes.size - 1] = last.copy(columns = last.columns + column)
            } else {
                indexes.add(IndexInfo(name = head[0]!!, columns = listOf(column), unique = unique, method = head[1]!!, predicate = head[2]))
            }
        }

        // PK and UNIQUE need only conkey.
        val keyRows = jdbcTemplate.query(
            "select con.contype::text, con.conname::text, a.attname::text " +
                "from pg_constraint con " +
                "join lateral unnest(con.conkey) with ordinality as k(attnum, n) on true " +
                "join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum " +
                "where con.conrelid = ? and con.contype in ('p', 'u') " +
                "order by con.contype desc, con.conname, k.n",
            RowMapper { rs, _ -> Triple(rs.getString(1), rs.getString(2), rs.getString(3)) },
            oid,
        )
        var primaryKey: ConstraintPk? = null
        val unique = ArrayList<ConstraintUnique>()
        for ((kind, name, column) in keyRows) {
            if (kind == "p") {
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

        // FK pairs conkey with confkey; the referenced table is confrelid.
        val fkRows = jdbcTemplate.query(
            "select con.conname::text, rn.nspname::text, rc.relname::text, " +
                "       fa.attname::text, ta.attname::text, " +
                "       con.confdeltype::text, con.confupdtype::text " +
                "from pg_constraint con " +
                "join pg_class rc on rc.oid = con.confrelid " +
                "join pg_namespace rn on rn.oid = rc.relnamespace " +
                "join lateral unnest(con.conkey, con.confkey) with ordinality " +
                "     as k(from_attnum, to_attnum, n) on true " +
                "join pg_attribute fa on fa.attrelid = con.conrelid and fa.attnum = k.from_attnum " +
                "join pg_attribute ta on ta.attrelid = con.confrelid and ta.attnum = k.to_attnum " +
                "where con.conrelid = ? and con.contype = 'f' " +
                "and not exists (select 1 from pg_constraint par where par.oid = con.conparentid and par.conrelid = con.conrelid) " +
                "order by con.conname, k.n",
            RowMapper { rs, _ -> (1..7).map { rs.getString(it) } },
            oid,
        )
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
                        onDelete = fkAction(r[5]!!),
                        onUpdate = fkAction(r[6]!!),
                    ),
                )
            }
        }

        val check = jdbcTemplate.query(
            "select con.conname::text, pg_get_expr(con.conbin, con.conrelid) " +
                "from pg_constraint con " +
                "where con.conrelid = ? and con.contype = 'c' " +
                "order by con.conname",
            RowMapper { rs, _ -> ConstraintCheck(rs.getString(1), rs.getString(2)) },
            oid,
        )
        return Structure(indexes, Constraints(primaryKey, unique, foreignKeys, check))
    }

    /** Maps pg_constraint.confdeltype/confupdtype to the vocabulary of `spec/protocol.md` §5.10. */
    private fun fkAction(code: String): String = when (code) {
        "c" -> "CASCADE"
        "r" -> "RESTRICT"
        "n" -> "SET NULL"
        "d" -> "SET DEFAULT"
        else -> "NO ACTION"
    }
}
