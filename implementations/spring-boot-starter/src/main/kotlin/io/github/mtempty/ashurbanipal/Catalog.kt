package io.github.mtempty.ashurbanipal

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.annotation.JsonProperty
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.core.RowMapper
import java.sql.ResultSet
import javax.sql.DataSource

/** Table/column not in the live schema allow-list; the controller maps this to 400 (`spec/protocol.md` §6 — no unvalidated identifier ever reaches SQL text). */
class NotAllowedException(message: String) : RuntimeException(message)

// `@JsonInclude(NON_NULL)` per optional field, not mapper-wide: a mapper-wide
// NON_NULL setting would also strip null *row cell* values (Map<String,
// String?> entries) elsewhere, which spec/protocol.md §5.4.3 requires to stay
// present as JSON null — optional metadata fields and row nulls need opposite
// treatment, so the mapper's default (include nulls) stays the baseline.
data class TableInfo(val name: String, @JsonInclude(JsonInclude.Include.NON_NULL) val comment: String? = null)
data class CountEntry(val table: String, @JsonProperty("approx_rows") val approxRows: Long)
data class ColumnRef(val table: String, val column: String)
data class ColumnInfo(
    val name: String,
    val type: String,
    @JsonInclude(JsonInclude.Include.NON_NULL) val key: String? = null,
    @JsonInclude(JsonInclude.Include.NON_NULL) val references: ColumnRef? = null,
    @JsonInclude(JsonInclude.Include.NON_NULL) val comment: String? = null,
)
data class TableData(val columns: List<ColumnInfo>, val rows: List<LinkedHashMap<String, String?>>, val totalApprox: Long)
data class CommonValueEntry(val value: String, val freq: Float)

data class QueryOpts(
    val limit: Long,
    val offset: Long,
    val sort: String?,
    val descending: Boolean,
    val filter: List<Condition>?,
)

/**
 * Port of `implementations/rust/src/db.rs`'s SQL, byte-for-byte where
 * possible (implementation.md §5.2). Every query goes through the one
 * [jdbcTemplate], whose `queryTimeout` is set once from
 * `limits.queryTimeoutSecs` at construction — catalog queries included, not
 * just row fetches (implementation.md §5.5 item 1's sibling requirement:
 * every query bounded, no exceptions).
 */
class Catalog(dataSource: DataSource, queryTimeoutSecs: Int, private val filterValidator: FilterValidator) {
    private val jdbcTemplate = JdbcTemplate(dataSource).apply {
        queryTimeout = queryTimeoutSecs
    }

    fun listTables(): List<TableInfo> {
        return jdbcTemplate.query(
            "select c.relname::text, obj_description(c.oid, 'pg_class') " +
                "from pg_class c " +
                "join pg_namespace n on n.oid = c.relnamespace " +
                "where n.nspname = current_schema() and c.relkind = 'r' " +
                "order by c.relname",
            RowMapper { rs, _ -> TableInfo(rs.getString(1), rs.getString(2)) },
        )
    }

    fun tableCounts(): List<CountEntry> {
        return jdbcTemplate.query(
            "select c.relname::text, c.reltuples::bigint " +
                "from pg_class c " +
                "join pg_namespace n on n.oid = c.relnamespace " +
                "where n.nspname = current_schema() and c.relkind = 'r' " +
                "order by c.relname",
            RowMapper { rs, _ -> CountEntry(rs.getString(1), rs.getLong(2)) },
        )
    }

    private fun allowedTables(): List<String> =
        jdbcTemplate.queryForList(
            "select table_name from information_schema.tables " +
                "where table_schema = current_schema() and table_type = 'BASE TABLE' " +
                "order by table_name",
            String::class.java,
        )

    private fun allowedColumns(table: String): List<String> =
        jdbcTemplate.queryForList(
            "select column_name from information_schema.columns " +
                "where table_schema = current_schema() and table_name = ? " +
                "order by ordinal_position",
            String::class.java,
            table,
        )

    private fun requireTable(table: String): String =
        allowedTables().find { it == table } ?: throw NotAllowedException("not allowed: table $table")

    private data class ConstraintRow(
        val constraintName: String,
        val constraintType: String,
        val columnName: String,
        val refTable: String?,
        val refColumn: String?,
    )

    private data class FkCandidate(val columnName: String, val refTable: String?, val refColumn: String?)

    /** Composite FKs are dropped rather than risk mislabeling which referencing column pairs with which referenced column (`spec/protocol.md` §5.4.1). Composite *primary* keys are NOT dropped this way — every PK column still gets `key: "pk"` regardless of how many columns are in the PK. */
    private fun keyMetadata(table: String): Pair<Set<String>, Map<String, ColumnRef>> {
        val rows = jdbcTemplate.query(
            "select tc.constraint_name, tc.constraint_type, kcu.column_name, " +
                "ccu.table_name as ref_table, ccu.column_name as ref_column " +
                "from information_schema.table_constraints tc " +
                "join information_schema.key_column_usage kcu " +
                "  on kcu.constraint_name = tc.constraint_name " +
                " and kcu.table_schema = tc.table_schema " +
                "left join information_schema.constraint_column_usage ccu " +
                "  on ccu.constraint_name = tc.constraint_name " +
                " and ccu.table_schema = tc.table_schema " +
                " and tc.constraint_type = 'FOREIGN KEY' " +
                "where tc.table_schema = current_schema() " +
                "  and tc.table_name = ? " +
                "  and tc.constraint_type in ('PRIMARY KEY', 'FOREIGN KEY')",
            RowMapper { rs, _ ->
                ConstraintRow(
                    rs.getString("constraint_name"),
                    rs.getString("constraint_type"),
                    rs.getString("column_name"),
                    rs.getString("ref_table"),
                    rs.getString("ref_column"),
                )
            },
            table,
        )

        val pkColumns = mutableSetOf<String>()
        val fkCandidates = mutableMapOf<String, MutableList<FkCandidate>>()
        for (row in rows) {
            when (row.constraintType) {
                "PRIMARY KEY" -> pkColumns.add(row.columnName)
                "FOREIGN KEY" -> fkCandidates.getOrPut(row.constraintName) { mutableListOf() }
                    .add(FkCandidate(row.columnName, row.refTable, row.refColumn))
            }
        }
        val fkColumns = mutableMapOf<String, ColumnRef>()
        for (members in fkCandidates.values) {
            val distinctColumns = members.map { it.columnName }.toSet()
            if (distinctColumns.size != 1) continue // composite FK: omit entirely
            val first = members.first()
            val refTable = first.refTable
            val refColumn = first.refColumn
            if (refTable != null && refColumn != null) {
                fkColumns[first.columnName] = ColumnRef(refTable, refColumn)
            }
        }
        return pkColumns to fkColumns
    }

    fun queryTable(table: String, opts: QueryOpts): TableData {
        val realTable = requireTable(table)
        val columnNames = allowedColumns(realTable)

        val sort = opts.sort?.let { requested ->
            columnNames.find { it == requested } ?: throw NotAllowedException("not allowed: column $requested")
        }

        val whereClause = opts.filter?.let { filterValidator.buildWhereClause(it, columnNames) }
            ?: WhereClause("", emptyList())

        val columnTypes = jdbcTemplate.query(
            "select column_name, data_type from information_schema.columns " +
                "where table_schema = current_schema() and table_name = ? " +
                "order by ordinal_position",
            RowMapper { rs, _ -> rs.getString(1) to rs.getString(2) },
            realTable,
        )
        // Joins through pg_attribute/pg_class directly: col_description is keyed
        // by attnum, which can diverge from ordinal_position once a column has
        // been dropped.
        val columnComments = jdbcTemplate.query(
            "select a.attname::text, col_description(a.attrelid, a.attnum::int) " +
                "from pg_attribute a " +
                "join pg_class c on c.oid = a.attrelid " +
                "join pg_namespace n on n.oid = c.relnamespace " +
                "where n.nspname = current_schema() and c.relname = ? " +
                "  and a.attnum > 0 and not a.attisdropped",
            RowMapper { rs, _ -> rs.getString(1) to rs.getString(2) },
            realTable,
        ).filter { it.second != null }.associate { it.first to it.second!! }

        val (pkColumns, fkColumns) = keyMetadata(realTable)
        val columns = columnTypes.map { (name, typeName) ->
            val key: String?
            val references: ColumnRef?
            when {
                pkColumns.contains(name) -> {
                    key = "pk"
                    references = null
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

        val selectList = columns.joinToString(", ") { "\"${it.name}\"::text" }
        // Table-qualified: an unqualified `order by "col"` would resolve to the
        // ::text-cast output column instead of the source column, sorting
        // lexicographically instead of by the real typed value.
        val orderClause = sort?.let {
            " order by \"$realTable\".\"$it\" ${if (opts.descending) "desc" else "asc"}"
        } ?: ""
        val sql = "select $selectList from \"$realTable\"${whereClause.sql}$orderClause limit ? offset ?"

        val bindArgs = mutableListOf<Any>()
        bindArgs.addAll(whereClause.values)
        bindArgs.add(opts.limit)
        bindArgs.add(opts.offset)

        val rows = jdbcTemplate.query(sql, RowMapper { rs, _ -> rowToJson(rs, columns) }, *bindArgs.toTypedArray())

        val totalApprox = jdbcTemplate.queryForObject(
            "select reltuples::bigint from pg_class c " +
                "join pg_namespace n on n.oid = c.relnamespace " +
                "where n.nspname = current_schema() and c.relname = ?",
            Long::class.java,
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

    fun commonValues(table: String, column: String): List<CommonValueEntry> {
        val realTable = requireTable(table)
        val realColumn = allowedColumns(realTable).find { it == column }
            ?: throw NotAllowedException("not allowed: column $column")

        // most_common_vals is anyarray; ::text::text[] reads it uniformly.
        // NULL (no ANALYZE stats yet) unnests to zero rows, not an error.
        val rows = jdbcTemplate.query(
            "select t.val, t.freq " +
                "from pg_stats, " +
                "     lateral unnest(most_common_vals::text::text[], most_common_freqs) as t(val, freq) " +
                "where schemaname = current_schema() and tablename = ? and attname = ? " +
                "order by t.freq desc",
            RowMapper { rs, _ -> rs.getString(1) to rs.getFloat(2) },
            realTable,
            realColumn,
        )

        val dataType = jdbcTemplate.query(
            "select data_type from information_schema.columns " +
                "where table_schema = current_schema() and table_name = ? and column_name = ?",
            RowMapper { rs, _ -> rs.getString(1) },
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
}
