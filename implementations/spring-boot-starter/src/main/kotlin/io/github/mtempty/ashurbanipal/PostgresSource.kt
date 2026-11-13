package io.github.mtempty.ashurbanipal

import org.springframework.dao.DataAccessException
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.core.RowCallbackHandler
import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.sql.ResultSet
import java.sql.SQLException
import javax.sql.DataSource

internal val PG_DIALECT = JoinDialect(
    quote = ::quoteIdent,
    castText = { "$it::text" },
    castParam = { ph, target -> "$ph::$target" },
    ilike = "native",
)

/**
 * The typed filter comparison for an `information_schema.columns.data_type`
 * (`spec/protocol.md` §5.4.2); the cast target matches the column's own type
 * so `real` compares as `real`.
 */
internal fun pgTypedCompare(dataType: String): TypedCompare? = when (dataType) {
    "smallint", "integer", "bigint" -> TypedCompare(ValueForm.PG_NUMERIC, "numeric", intCast = "int8")
    "numeric" -> TypedCompare(ValueForm.PG_NUMERIC, "numeric")
    "real" -> TypedCompare(ValueForm.PG_FLOAT, "real")
    "double precision" -> TypedCompare(ValueForm.PG_FLOAT, "float8")
    "date" -> TypedCompare(ValueForm.PG_DATE, "date")
    "timestamp without time zone" -> TypedCompare(ValueForm.PG_TIMESTAMP, "timestamp")
    "timestamp with time zone" -> TypedCompare(ValueForm.PG_TIMESTAMP_TZ, "timestamptz")
    "time without time zone" -> TypedCompare(ValueForm.PG_TIME, "time")
    "time with time zone" -> TypedCompare(ValueForm.PG_TIME_TZ, "timetz")
    else -> null
}

/** `spec/protocol.md` §5.11.2; the mapping is in `docs/adapter-decisions.md` §5.11. */
internal fun pgColumnClass(dataType: String, udtSchema: String, udtName: String, isEnum: Boolean): ColumnClass =
    typedClass(pgTypedCompare(dataType)) ?: when (dataType) {
        "character varying", "character", "text" -> ColumnClass.TEXT
        "uuid" -> ColumnClass.UUID
        "boolean" -> ColumnClass.BOOLEAN
        "bytea" -> ColumnClass.BINARY
        "USER-DEFINED" -> when {
            isEnum -> ColumnClass.enum("$udtSchema.$udtName")
            udtName == "citext" -> ColumnClass.TEXT
            else -> ColumnClass.OTHER
        }
        "json", "jsonb" -> ColumnClass.JSON
        "ARRAY" -> ColumnClass.ARRAY
        else -> ColumnClass.OTHER
    }

/** Postgres [DbSource]; queryTimeout bounds catalog and data operations (`spec/protocol.md` §6). */
class PostgresSource(dataSource: DataSource, queryTimeoutSecs: Int) : DbSource {
    override val engine = Engine.POSTGRES

    private val jdbcTemplate = JdbcTemplate(dataSource).apply {
        queryTimeout = queryTimeoutSecs
    }
    private val transactionTemplate = TransactionTemplate(DataSourceTransactionManager(dataSource)).apply {
        isReadOnly = true
    }

    private fun <T> inReadOnlyTransaction(action: () -> T): T =
        transactionTemplate.execute {
            // Typed filters read values in ISO form, and a cell's text must be one.
            jdbcTemplate.execute("set local datestyle = 'ISO'")
            action()
        }
            ?: throw IllegalStateException("read-only transaction did not produce a result")

    override fun listSchemas(): SchemaListing =
        inReadOnlyTransaction { SchemaListing.of(listAllowedSchemas(), defaultSchema()) }

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

    /** Null when no schema on the session's search_path exists. */
    private fun defaultSchema(): String? =
        jdbcTemplate.queryForObject("select current_schema()", String::class.java)

    /** Resolve inside the operation transaction to prevent pool-session drift (`spec/protocol.md` §5). */
    private fun resolveSchema(requested: String?): String = resolveSchemaAmong(listAllowedSchemas(), requested)

    /** [resolveSchema] against a schema list already fetched in this transaction. */
    private fun resolveSchemaAmong(schemas: List<String>, requested: String?): String {
        val resolved = requested
            ?: defaultSchema()
            ?: throw NotAllowedException("no schema requested and this connection has no default schema", NotAllowedKind.SCHEMA)
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

    /**
     * Reads `pg_constraint`, which has no privilege filter, so a role that doesn't own the table still
     * sees its keys. Composite foreign keys, and ones whose target the role can't open, are left out
     * (`spec/protocol.md` §5.4.1).
     */
    private fun keyMetadata(schema: String, oid: Long): Pair<Set<String>, Map<String, ColumnRef>> {
        val pkColumns = mutableSetOf<String>()
        val fkColumns = mutableMapOf<String, ColumnRef>()
        jdbcTemplate.query(
            "select con.contype = 'p' as is_pk, a.attname::text as column_name, " +
                "rn.nspname::text as ref_schema, rc.relname::text as ref_table, ra.attname::text as ref_column " +
                "from pg_constraint con " +
                "cross join lateral unnest(con.conkey) k(attnum) " +
                "join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum " +
                "left join pg_class rc on con.contype = 'f' and rc.oid = con.confrelid " +
                "left join pg_namespace rn on rn.oid = rc.relnamespace " +
                "left join pg_attribute ra on ra.attrelid = rc.oid and ra.attnum = con.confkey[1] " +
                "where con.conrelid = ? " +
                "  and (con.contype = 'p' " +
                "       or (con.contype = 'f' and cardinality(con.conkey) = 1 and rc.relkind = 'r' " +
                "           and has_schema_privilege(rc.relnamespace, 'USAGE') and has_table_privilege(rc.oid, 'SELECT')))",
            RowCallbackHandler { rs ->
                val column = rs.getString("column_name")
                val refSchema = rs.getString("ref_schema")
                val refTable = rs.getString("ref_table")
                val refColumn = rs.getString("ref_column")
                if (rs.getBoolean("is_pk")) {
                    pkColumns.add(column)
                } else if (refSchema != null && refTable != null && refColumn != null) {
                    // Same-schema references omit schema on the wire (spec/protocol.md §5.4.1).
                    fkColumns[column] = ColumnRef(refTable, refColumn, if (refSchema != schema) refSchema else null)
                }
            },
            oid,
        )
        return pkColumns to fkColumns
    }

    override fun queryTable(schema: String?, table: String, opts: QueryOpts): TableData =
        inReadOnlyTransaction { queryTableInTransaction(schema, table, opts) }

    /** Column metadata of a table already cleared by [readableTableOid], which supplies [oid]. */
    private fun tableMeta(schema: String, table: String, oid: Long): TableMeta {
        data class Col(
            val name: String,
            val type: String,
            val udtSchema: String,
            val udtName: String,
            val isEnum: Boolean,
            val fullType: String,
            val comment: String?,
            val collation: String?,
        )
        // information_schema.columns drives the list (column privileges, order);
        // pg_attribute adds the full type spelling, comment and collation, keyed
        // by attnum, which can diverge from ordinal_position after a drop. The
        // default collation (oid 100) is left out: it yields to an explicit one
        // in a comparison, so it never clashes.
        val columns = jdbcTemplate.query(
            "select c.column_name, c.data_type, c.udt_schema, c.udt_name, " +
                "       exists (select 1 from pg_type t " +
                "               join pg_namespace n on n.oid = t.typnamespace " +
                "               where n.nspname = c.udt_schema and t.typname = c.udt_name " +
                "                 and t.typtype = 'e'), " +
                "       format_type(a.atttypid, a.atttypmod), " +
                "       col_description(a.attrelid, a.attnum::int), " +
                "       (select case when n.nspname = 'pg_catalog' then co.collname " +
                "                    else n.nspname || '.' || co.collname end " +
                "          from pg_collation co " +
                "          join pg_namespace n on n.oid = co.collnamespace " +
                "         where co.oid = a.attcollation and a.attcollation not in (0, 100)) " +
                "from information_schema.columns c " +
                "join pg_attribute a on a.attrelid = ? and a.attname = c.column_name " +
                "where c.table_schema = ? and c.table_name = ? " +
                "order by c.ordinal_position",
            RowMapper { rs, _ ->
                Col(
                    rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4),
                    rs.getBoolean(5), rs.getString(6), rs.getString(7), rs.getString(8),
                )
            },
            oid,
            schema,
            table,
        )
        val (pkColumns, fkColumns) = keyMetadata(schema, oid)
        val colMetas = columns.map { c ->
            ColMeta(
                name = c.name,
                type = c.fullType,
                columnClass = pgColumnClass(c.type, c.udtSchema, c.udtName, c.isEnum),
                compare = pgTypedCompare(c.type),
                collation = c.collation,
                key = if (pkColumns.contains(c.name)) "pk" else if (fkColumns.containsKey(c.name)) "fk" else null,
                references = fkColumns[c.name],
                comment = c.comment,
            )
        }
        return TableMeta(schema = schema, name = table, columns = colMetas, orderKeys = tieBreakKeys(colMetas, uniqueKeys(oid)))
    }

    /**
     * The primary key and every unique index that can break ties: plain key
     * columns (INCLUDE columns left out), not partial, all NOT NULL, and each
     * in its column's own collation, so the key is unique under the order by.
     * pg_index has no privilege filter, unlike information_schema, so a role
     * with only SELECT still sees the key.
     */
    private fun uniqueKeys(oid: Long): List<UniqueKey> = groupUniqueKeys(
        jdbcTemplate.query(
            "select c.relname, i.indisprimary, a.attname, a.attnotnull and i.indcollation[k.n::int - 1] = a.attcollation " +
                "from pg_index i " +
                "join pg_class c on c.oid = i.indexrelid " +
                "cross join lateral unnest(i.indkey::int2[]) with ordinality k(attnum, n) " +
                "join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum " +
                "where i.indrelid = ? and i.indisunique and i.indisvalid " +
                "  and i.indpred is null and i.indexprs is null and k.n <= i.indnkeyatts " +
                "order by c.relname, k.n",
            RowMapper { rs, _ -> KeyPart(rs.getString(1), rs.getBoolean(2), rs.getString(3), rs.getBoolean(2) || rs.getBoolean(4)) },
            oid,
        ),
    )

    override fun queryJoin(schema: String?, spec: JoinSpec, opts: JoinOpts): JoinData = inReadOnlyTransaction {
        val listed = listAllowedSchemas()
        val realSchema = resolveSchemaAmong(listed, schema)
        val refs = spec.tableRefs()
        val schemas = tableSchemas(refs, realSchema, listed)
        val metas = HashMap<Pair<String, String>, TableMeta>()
        val tables = refs.mapIndexed { i, ref ->
            metas.getOrPut(schemas[i] to ref.table) {
                joinTable(ref.table) { tableMeta(schemas[i], ref.table, readableTableOid(schemas[i], ref.table)) }
            }
        }
        val plan = planJoin(spec, tables, opts)

        // The statement is built from catalog names and generated aliases
        // only; every value is a bound parameter.
        val (body, values) = buildJoinSelect(plan, PG_DIALECT)
        val bindArgs: List<Any> = values + (opts.limit + 1) + opts.offset
        val rows = try {
            jdbcTemplate.query(
                "select $body",
                RowMapper { rs, _ -> List(plan.labels.size) { i -> readCell(rs, i + 1) } },
                *bindArgs.toTypedArray(),
            )
        } catch (e: DataAccessException) {
            throw mapSelectError(e, spec.table, opts.sort, values.isNotEmpty())
        }
        plan.joinData(rows, opts.limit, realSchema)
    }

    /** The protocol error for a failed data or join SELECT, or [e] itself when none applies. */
    private fun mapSelectError(e: DataAccessException, table: String, sort: String?, filtered: Boolean): Exception {
        val sqlState = (e.mostSpecificCause as? SQLException)?.sqlState
        return when {
            // Residual SELECT-denied errors are NotAllowed (spec/protocol.md §2).
            sqlState == "42501" -> NotAllowedException("not allowed: table $table", NotAllowedKind.NOT_READABLE)
            // A filter value Postgres rejects (a bad-value SQLSTATE: a NUL byte, or a
            // value a typed comparison's cast refuses) is a 400, never a raw 500
            // (docs/adapter-decisions.md §5.4.2).
            sqlState in BAD_VALUE_SQLSTATES && filtered ->
                FilterException("value invalid for this backend: ${e.mostSpecificCause.message}")
            // With a sort, an undefined function is the sort column's type having no
            // ordering operator (json, xml, geometric types).
            sqlState == "42883" && sort != null -> UnsortableException(sort)
            else -> e
        }
    }

    private fun queryTableInTransaction(schema: String?, table: String, opts: QueryOpts): TableData {
        val realSchema = resolveSchema(schema)
        val oid = readableTableOid(realSchema, table)
        val realTable = table
        // The join route's lookup, so both routes report the same columns; its
        // names are the live catalog's, so they also serve as the allow-list.
        val meta = tableMeta(realSchema, realTable, oid)
        val columns = meta.columns.map { it.columnInfo() }
        val columnNames = columns.map { it.name }

        val sort = opts.sort?.let { requested ->
            columnNames.find { it == requested } ?: throw NotAllowedException("not allowed: column $requested", NotAllowedKind.COLUMN)
        }

        val whereClause = opts.filter?.let { tableWhereClause(it, meta, PG_DIALECT) }
            ?: WhereClause("", emptyList())

        val selectList = columns.joinToString(", ") { "${quoteIdent(it.name)}::text" }
        val orderClause = tableOrderClause(meta, sort, opts.descending, ::quoteIdent)
        val sql = "select $selectList from ${quoteIdent(realSchema)}.${quoteIdent(realTable)}" +
            "${whereClause.sql}$orderClause limit ? offset ?"

        val bindArgs = mutableListOf<Any>()
        bindArgs.addAll(whereClause.values)
        bindArgs.add(opts.limit)
        bindArgs.add(opts.offset)

        val rows = try {
            jdbcTemplate.query(sql, RowMapper { rs, _ -> rowToJson(rs, columns) }, *bindArgs.toTypedArray())
        } catch (e: DataAccessException) {
            throw mapSelectError(e, realTable, opts.sort, whereClause.values.isNotEmpty())
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
