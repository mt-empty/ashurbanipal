package io.github.mtempty.ashurbanipal

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.annotation.JsonProperty
import org.springframework.dao.QueryTimeoutException
import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import tools.jackson.module.kotlin.jacksonMapperBuilder
import java.sql.SQLException
import java.sql.SQLTimeoutException

/** Bounds for `GET /api/tables/join` (`spec/protocol.md` §5.11.1). */
const val MAX_JOIN_BYTES = 8192
const val MAX_JOIN_TABLES = 4
const val MAX_JOIN_PAIRS = 3

/**
 * Anything wrong with a join value (`spec/protocol.md` §5.11.1): its shape, an unknown table or column, an
 * incompatible pair. The controller maps it to 400 `invalid_join`.
 */
class BadJoinException(message: String) : RuntimeException("invalid join: $message")

/** A sort on a column whose type has no ordering (`spec/protocol.md` §5.4); 400 `unsortable_column`. */
class UnsortableException(column: String) : RuntimeException("cannot sort by $column: its type has no ordering")

/** A table named in the join value is part of the join, so a miss is a bad join; `not_readable` stays as it is. */
internal inline fun <T> joinTable(name: String, block: () -> T): T =
    try {
        block()
    } catch (e: NotAllowedException) {
        if (e.kind == NotAllowedKind.TABLE) throw BadJoinException("unknown table \"$name\"") else throw e
    }

data class ColumnPos(val join: Int, val column: String)
data class OnPair(val left: ColumnPos, val right: String)

/** [left] false is an inner join; a null [schema] means the request's resolved schema. */
data class JoinEntry(val left: Boolean, val table: String, val on: List<OnPair>, val schema: String? = null)

/** One position's own schema (null: the request's) and table. */
data class TableRef(val schema: String?, val table: String)

/** Positions: 0 is [table], 1.. the entries of [joins] in order; a null [schema] means the request's. */
data class JoinSpec(
    val table: String,
    val joins: List<JoinEntry>,
    val columns: List<ColumnPos>? = null,
    val schema: String? = null,
) {
    fun tableRefs(): List<TableRef> = listOf(TableRef(schema, table)) + joins.map { TableRef(it.schema, it.table) }
}

/**
 * Each position's schema: its own, which must be in [listed] (§5.7), or else [request]. An unlisted one is
 * `invalid_join`, never `unknown_schema`, which belongs to the schema parameter.
 */
internal fun tableSchemas(refs: List<TableRef>, request: String, listed: List<String>): List<String> =
    refs.map { r ->
        when {
            r.schema == null -> request
            r.schema in listed -> r.schema
            else -> throw BadJoinException("unknown schema \"${r.schema}\"")
        }
    }

/** Request options other than the `join` object itself. */
data class JoinOpts(
    val limit: Long,
    val offset: Long,
    val sort: String?,
    val sortJoin: Int?,
    val descending: Boolean,
    val filter: List<Condition>?,
)

data class JoinColumnInfo(
    val name: String,
    val type: String,
    val join: Int,
    val table: String,
    val column: String,
    @JsonProperty("class") val columnClass: String,
    @JsonInclude(JsonInclude.Include.NON_NULL) val schema: String? = null,
    @JsonInclude(JsonInclude.Include.NON_NULL) val key: String? = null,
    @JsonInclude(JsonInclude.Include.NON_NULL) val references: ColumnRef? = null,
    @JsonInclude(JsonInclude.Include.NON_NULL) val comment: String? = null,
    @JsonInclude(JsonInclude.Include.NON_NULL) @JsonProperty("enum_type") val enumType: String? = null,
    @JsonInclude(JsonInclude.Include.NON_NULL) val collation: String? = null,
)

data class JoinData(
    val columns: List<JoinColumnInfo>,
    val rows: List<LinkedHashMap<String, String?>>,
    @JsonProperty("has_more") val hasMore: Boolean,
)

private val joinMapper: ObjectMapper = jacksonMapperBuilder().build()

private fun JsonNode.isInt(): Boolean = isIntegralNumber && canConvertToInt()

private fun checkKeys(node: JsonNode, allowed: Set<String>, what: String) {
    for (name in node.propertyNames()) {
        if (name !in allowed) throw BadJoinException("$what has unknown field \"$name\"")
    }
}

private fun optionalSchema(node: JsonNode, what: String): String? {
    val schema = node.get("schema") ?: return null
    if (!schema.isString) throw BadJoinException("$what: schema must be a string")
    return schema.stringValue()
}

private fun toPos(node: JsonNode?, what: String): ColumnPos {
    if (node == null || !node.isObject) throw BadJoinException("$what must be an object with join and column")
    checkKeys(node, setOf("join", "column"), what)
    val join = node.get("join")
    if (join == null || !join.isInt() || join.intValue() < 0) {
        throw BadJoinException("$what: join must be a non-negative integer position")
    }
    val column = node.get("column")
    if (column == null || !column.isString) throw BadJoinException("$what: column must be a string")
    return ColumnPos(join.intValue(), column.stringValue())
}

/** Validates the join object's structure only; names and types are checked by [planJoin]. */
fun parseJoin(raw: String): JoinSpec {
    val bytes = raw.toByteArray(Charsets.UTF_8).size
    if (bytes > MAX_JOIN_BYTES) throw BadJoinException("join too long: $bytes bytes (max $MAX_JOIN_BYTES)")
    val root = try {
        joinMapper.readTree(raw)
    } catch (e: Exception) {
        throw BadJoinException("join must be a JSON object of the documented shape: ${e.message}")
    }
    if (root == null || !root.isObject) throw BadJoinException("join must be a JSON object")
    checkKeys(root, setOf("table", "schema", "joins", "columns"), "join")
    val table = root.get("table")
    if (table == null || !table.isString) throw BadJoinException("join needs a string table")
    val schema = optionalSchema(root, "join")
    val rawJoins = root.get("joins")
    if (rawJoins == null || !rawJoins.isArray || rawJoins.size() == 0) {
        throw BadJoinException("join needs at least one entry in joins")
    }
    if (rawJoins.size() + 1 > MAX_JOIN_TABLES) {
        throw BadJoinException("too many tables: ${rawJoins.size() + 1} (max $MAX_JOIN_TABLES)")
    }

    val joins = rawJoins.mapIndexed { i, entry ->
        val position = i + 1
        if (!entry.isObject) throw BadJoinException("join $position must be an object")
        checkKeys(entry, setOf("type", "table", "schema", "on"), "join $position")
        val type = entry.get("type")?.takeIf { it.isString }?.stringValue()
        if (type != "inner" && type != "left") throw BadJoinException("join $position: type must be \"inner\" or \"left\"")
        val entryTable = entry.get("table")
        if (entryTable == null || !entryTable.isString) throw BadJoinException("join $position: table must be a string")
        val entrySchema = optionalSchema(entry, "join $position")
        val on = entry.get("on")
        if (on == null || !on.isArray || on.size() == 0 || on.size() > MAX_JOIN_PAIRS) {
            throw BadJoinException("join $position: on needs 1 to $MAX_JOIN_PAIRS pairs")
        }
        val pairs = on.toList().map { pair ->
            if (!pair.isObject) throw BadJoinException("join $position: an on pair must be an object")
            checkKeys(pair, setOf("left", "right"), "join $position: on pair")
            val left = toPos(pair.get("left"), "join $position: on.left")
            val right = pair.get("right")
            if (right == null || !right.isString) throw BadJoinException("join $position: on.right must be a string")
            if (left.join >= position) {
                throw BadJoinException("join $position: on.left refers to position ${left.join}, which is not an earlier table")
            }
            OnPair(left, right.stringValue())
        }
        JoinEntry(type == "left", entryTable.stringValue(), pairs, entrySchema)
    }

    var columns: List<ColumnPos>? = null
    val rawColumns = root.get("columns")
    if (rawColumns != null) {
        if (!rawColumns.isArray || rawColumns.size() == 0) throw BadJoinException("columns must be a non-empty array when present")
        val seen = HashSet<ColumnPos>()
        columns = rawColumns.toList().map { c ->
            val pos = toPos(c, "columns")
            if (!seen.add(pos)) throw BadJoinException("columns lists (${pos.join}, \"${pos.column}\") twice")
            pos
        }
    }
    return JoinSpec(table.stringValue(), joins, columns, schema)
}

/**
 * Class of a column type (`spec/protocol.md` §5.4.1, §5.11.2). [enumType] carries
 * an enumerated type's identity; `untyped` is a SQLite column with no declared
 * type and pairs only with itself.
 */
data class ColumnClass(val kind: String, val enumType: String = "") {
    companion object {
        val NUMBER = ColumnClass("number")
        val TEXT = ColumnClass("text")
        val UUID = ColumnClass("uuid")
        val BOOLEAN = ColumnClass("boolean")
        val TEMPORAL = ColumnClass("temporal")
        val TIME = ColumnClass("time")
        val BINARY = ColumnClass("binary")
        val UNTYPED = ColumnClass("untyped")
        val FLOAT = ColumnClass("float")
        val JSON = ColumnClass("json")
        val ARRAY = ColumnClass("array")
        val OTHER = ColumnClass("other")
        fun enum(identity: String) = ColumnClass("enum", identity)
    }
}

/** Classes whose columns cannot be joined (§5.11.2). */
private val NOT_JOINABLE = setOf(ColumnClass.FLOAT, ColumnClass.JSON, ColumnClass.ARRAY, ColumnClass.OTHER)

/** One column as the live catalog reports it. [collation] is set where two text collations can clash (§5.4.1). */
data class ColMeta(
    val name: String,
    val type: String,
    val columnClass: ColumnClass,
    val collation: String? = null,
    val key: String? = null,
    val references: ColumnRef? = null,
    val comment: String? = null,
) {
    /** The §5.4.1 shape of this column. */
    fun columnInfo() = ColumnInfo(
        name, type, columnClass.kind, key, references, comment,
        columnClass.enumType.takeIf { it.isNotEmpty() }, collation.takeIf { columnClass == ColumnClass.TEXT },
    )
}

/**
 * A unique key a backend's catalog reports for one table. Backends pass a unique
 * index only when its key columns are plain (no expression), it is not partial,
 * and every key column is NOT NULL.
 */
data class UniqueKey(val name: String, val primary: Boolean, val columns: List<String>)

/**
 * The primary key's column indexes in key order, else those of the unique key
 * with the fewest columns (then the lowest name). A key with a column the role
 * cannot see is skipped; none left means no tie-break.
 */
fun tieBreakKeys(columns: List<ColMeta>, keys: List<UniqueKey>): List<Int> =
    keys
        .map { k -> k to k.columns.map { name -> columns.indexOfFirst { it.name == name } } }
        .filter { (_, idx) -> idx.isNotEmpty() && idx.all { it >= 0 } }
        .minWithOrNull(compareBy({ !it.first.primary }, { it.second.size }, { it.first.name }))
        ?.second
        ?: emptyList()

/** One key column of a candidate unique key; [usable] is false when it rules the key out. */
data class KeyPart(val index: String, val primary: Boolean, val column: String?, val usable: Boolean)

/** Folds [parts], ordered by index and then key position, into keys, dropping a key with an unusable part. */
fun groupUniqueKeys(parts: List<KeyPart>): List<UniqueKey> =
    parts
        .fold(mutableListOf<MutableList<KeyPart>>()) { groups, p ->
            if (groups.lastOrNull()?.first()?.index == p.index) groups.last().add(p) else groups.add(mutableListOf(p))
            groups
        }.filter { g -> g.all { it.usable } }
        .map { g -> UniqueKey(g.first().index, g.first().primary, g.map { it.column ?: "" }) }

/**
 * A single-table query's order by, every column qualified by the table name so
 * it never resolves to a text-cast output column.
 */
fun tableOrderClause(meta: TableMeta, sort: String?, descending: Boolean, quote: (String) -> String): String {
    return orderByClause(sort?.let(meta::index), meta.orderKeys, descending) { "${quote(meta.name)}.${quote(meta.columns[it].name)}" }
}

/**
 * ` order by <sort>, <keys…>` with a key equal to [sort] left out, every term in
 * one direction (asc when there is no sort); "" when there is nothing to order by.
 */
fun <T> orderByClause(sort: T?, keys: List<T>, descending: Boolean, render: (T) -> String): String {
    val dir = if (descending && sort != null) "desc" else "asc"
    val terms = listOfNotNull(sort) + keys.filter { it != sort }
    return if (terms.isEmpty()) "" else terms.joinToString(", ", prefix = " order by ") { "${render(it)} $dir" }
}

/**
 * [schema] is the catalog-checked schema the table is spliced under; null on SQLite.
 * [orderKeys] index [columns] that break ties after `sort` (`spec/protocol.md` §5.4).
 */
data class TableMeta(
    val name: String,
    val columns: List<ColMeta>,
    val schema: String? = null,
    val orderKeys: List<Int> = emptyList(),
) {
    fun index(column: String): Int {
        val i = columns.indexOfFirst { it.name == column }
        if (i < 0) throw NotAllowedException("not allowed: column $column", NotAllowedKind.COLUMN)
        return i
    }

    /** [index] for a name inside the join value, where a miss is a bad join. */
    fun joinIndex(column: String): Int {
        val i = columns.indexOfFirst { it.name == column }
        if (i < 0) throw BadJoinException("$name has no column \"$column\"")
        return i
    }
}

internal data class ResolvedCondition(val cond: Condition, val pos: Int, val col: Int)

/** A request resolved against the catalog; every name in SQL text comes from [tables], never the request. */
class JoinPlan internal constructor(
    val tables: List<TableMeta>,
    internal val left: List<Boolean>,
    /** Per join entry: (left position, left column, right column). */
    internal val ons: List<List<Triple<Int, Int, Int>>>,
    /** (position, column index) per returned column. */
    internal val selection: List<Pair<Int, Int>>,
    val labels: List<String>,
    internal val filter: List<ResolvedCondition>,
    internal val sort: Pair<Int, Int>?,
    internal val descending: Boolean,
) {
    /** A column's `schema` is reported only when its table is outside [requestSchema]. */
    fun columnInfos(requestSchema: String): List<JoinColumnInfo> = selection.mapIndexed { i, (pos, col) ->
        val t = tables[pos]
        val c = t.columns[col].columnInfo()
        JoinColumnInfo(
            labels[i], c.type, pos, t.name, c.name, c.columnClass, t.schema?.takeIf { it != requestSchema },
            c.key, c.references, c.comment, c.enumType, c.collation,
        )
    }

    /** Keys positional result rows by label and trims the extra row asked for `has_more`. */
    fun joinData(rows: List<List<String?>>, limit: Long, requestSchema: String): JoinData {
        val hasMore = rows.size > limit
        val out = rows.take(limit.toInt()).map { row ->
            LinkedHashMap<String, String?>(labels.size).also { map -> labels.forEachIndexed { i, label -> map[label] = row[i] } }
        }
        return JoinData(columnInfos(requestSchema), out, hasMore)
    }
}

private fun describe(t: TableMeta, c: ColMeta) = "${t.name}.${c.name} (${c.type})"

private fun unjoinable(position: Int, t: TableMeta, c: ColMeta): BadJoinException {
    val why = if (c.columnClass == ColumnClass.FLOAT) ": floating-point values are not compared exactly" else ""
    return BadJoinException("join $position on: ${describe(t, c)} cannot be used in a join$why")
}

private fun checkPair(position: Int, lt: TableMeta, lc: ColMeta, rt: TableMeta, rc: ColMeta) {
    val leftColumnClass = lc.columnClass
    val rightColumnClass = rc.columnClass
    if (leftColumnClass in NOT_JOINABLE) throw unjoinable(position, lt, lc)
    if (rightColumnClass in NOT_JOINABLE) throw unjoinable(position, rt, rc)
    if (leftColumnClass != rightColumnClass) {
        throw BadJoinException("join $position on: ${describe(lt, lc)} cannot be joined to ${describe(rt, rc)}")
    }
    if (leftColumnClass == ColumnClass.TEXT && lc.collation != null && rc.collation != null && lc.collation != rc.collation) {
        throw BadJoinException(
            "join $position on: ${describe(lt, lc)} and ${describe(rt, rc)} use different text collations (${lc.collation} and ${rc.collation})",
        )
    }
}

/** A column keeps its own name when that is unique among the returned columns, otherwise it becomes `name_join`; a numeric suffix breaks any remaining tie. */
internal fun assignJoinLabels(names: List<String>, joins: List<Int>): List<String> {
    val counts = names.groupingBy { it }.eachCount()
    val used = names.filter { counts[it] == 1 }.toHashSet()
    return names.mapIndexed { i, n ->
        if (counts[n] == 1) return@mapIndexed n
        val base = "${n}_${joins[i]}"
        var label = base
        var k = 2
        while (label in used) label = "${base}_${k++}"
        used.add(label)
        label
    }
}

/** Resolves a request against the catalog; `tables[i]` is the metadata of position i. */
fun planJoin(spec: JoinSpec, tables: List<TableMeta>, opts: JoinOpts): JoinPlan {
    val ons = spec.joins.mapIndexed { i, entry ->
        val position = i + 1
        entry.on.map { pair ->
            val lt = tables[pair.left.join]
            val lc = lt.joinIndex(pair.left.column)
            val rc = tables[position].joinIndex(pair.right)
            checkPair(position, lt, lt.columns[lc], tables[position], tables[position].columns[rc])
            Triple(pair.left.join, lc, rc)
        }
    }

    val selection: List<Pair<Int, Int>> = spec.columns?.map { c ->
        if (c.join >= tables.size) throw BadJoinException("columns: position ${c.join} is not in the join")
        c.join to tables[c.join].joinIndex(c.column)
    } ?: tables.flatMapIndexed { pos, t -> t.columns.indices.map { pos to it } }
    val labels = assignJoinLabels(
        selection.map { (p, c) -> tables[p].columns[c].name },
        selection.map { it.first },
    )

    val filter = (opts.filter ?: emptyList()).mapIndexed { i, cond ->
        val pos = cond.join ?: 0
        if (pos < 0 || pos >= tables.size) throw FilterException("condition $i: join position $pos is not in the join")
        if ((cond.op !in OPS_WITHOUT_VALUE) != (cond.value != null)) {
            throw FilterException("condition $i: op ${cond.op} has the wrong value arity")
        }
        ResolvedCondition(cond, pos, tables[pos].index(cond.column))
    }

    if (opts.sort == null && opts.sortJoin != null) throw BadParameterException("sort_join needs sort")
    val sort = opts.sort?.let { column ->
        val pos = opts.sortJoin ?: 0
        if (pos < 0 || pos >= tables.size) throw BadParameterException("sort_join: position $pos is not in the join")
        pos to tables[pos].index(column)
    }
    return JoinPlan(tables, spec.joins.map { it.left }, ons, selection, labels, filter, sort, opts.descending)
}

/** How a source spells the pieces that differ between engines. */
internal class JoinDialect(
    val quote: (String) -> String,
    val castText: (String) -> String,
    /** `native`, `like` or `lowered-like`. */
    val ilike: String,
)

/**
 * Each table's tie-break key as `position to column`, in position order. A key
 * whose every column an `on` pair binds, at the same type and collation, to a
 * table already fixed by earlier keys is left out: it cannot change the order
 * (`spec/protocol.md` §5.11.3).
 */
internal fun joinOrderKeys(tables: List<TableMeta>, ons: List<List<Triple<Int, Int, Int>>>): List<Pair<Int, Int>> {
    val fixed = mutableListOf<Boolean>()
    val keys = mutableListOf<Pair<Int, Int>>()
    tables.forEachIndexed { p, t ->
        val bound = p > 0 && t.orderKeys.isNotEmpty() && t.orderKeys.all { k ->
            ons[p - 1].any { (lp, lc, rc) ->
                val l = tables[lp].columns[lc]
                val r = t.columns[rc]
                rc == k && fixed[lp] && l.type == r.type && l.collation == r.collation
            }
        }
        if (!bound) t.orderKeys.mapTo(keys) { p to it }
        fixed += t.orderKeys.isNotEmpty()
    }
    return keys
}

/**
 * Renders `<select list> from … limit ? offset ?` (no leading `select`, so
 * MySQL can wrap it in its timeout hint) and the filter values in
 * placeholder order. Bind the values first, then limit, then offset.
 */
internal fun buildJoinSelect(plan: JoinPlan, d: JoinDialect): Pair<String, List<String>> {
    fun alias(pos: Int, col: Int) = "t$pos.${d.quote(plan.tables[pos].columns[col].name)}"
    fun fromItem(pos: Int): String {
        val t = plan.tables[pos]
        val name = d.quote(t.name)
        return if (t.schema != null) "${d.quote(t.schema)}.$name t$pos" else "$name t$pos"
    }

    val selectList = plan.selection.mapIndexed { i, (p, c) -> "${d.castText(alias(p, c))} as c$i" }.joinToString(", ")
    val sql = StringBuilder("$selectList from ${fromItem(0)}")
    plan.left.forEachIndexed { i, isLeft ->
        val position = i + 1
        // Right column first: SQLite compares with the left operand's collation, which key pruning (joinOrderKeys) relies on.
        val on = plan.ons[i].joinToString(" and ") { (lp, lc, rc) -> "${alias(position, rc)} = ${alias(lp, lc)}" }
        sql.append(" ${if (isLeft) "left join" else "inner join"} ${fromItem(position)} on $on")
    }

    val values = mutableListOf<String>()
    val clause = StringBuilder()
    plan.filter.forEachIndexed { i, rc ->
        val cond = rc.cond
        val cast = d.castText(alias(rc.pos, rc.col))
        val inner = when {
            cond.op in OPS_WITHOUT_VALUE -> "$cast ${opSqlKeyword(cond.op)}"
            cond.op == "ILIKE" -> {
                values.add(cond.value!!)
                when (d.ilike) {
                    "native" -> "$cast ILIKE ?"
                    "like" -> "$cast LIKE ?"
                    else -> "LOWER($cast) LIKE LOWER(?)"
                }
            }
            else -> {
                values.add(cond.value!!)
                "$cast ${opSqlKeyword(cond.op)} ?"
            }
        }
        if (i > 0) clause.append(if (cond.logic == "OR") " OR " else " AND ")
        clause.append(if (cond.not) "(NOT ($inner))" else "($inner)")
    }
    if (clause.isNotEmpty()) sql.append(" where $clause")
    sql.append(orderByClause(plan.sort, joinOrderKeys(plan.tables, plan.ons), plan.descending) { (p, c) -> alias(p, c) })
    sql.append(" limit ? offset ?")
    return sql.toString() to values
}

/**
 * Whether [e] is the engine stopping a slow statement (`spec/protocol.md` §6):
 * a JDBC timeout, Postgres SQLSTATE 57014, MySQL 3024, MariaDB 1969, or the
 * SQLite interrupt. Answered as 500 `query_timeout`.
 */
internal fun isQueryTimeout(e: Throwable): Boolean {
    var t: Throwable? = e
    var depth = 0
    while (t != null && depth++ < 10) {
        if (t is QueryTimeoutException || t is SQLTimeoutException) return true
        if (t is SQLException) {
            if (t.sqlState == "57014" || t.errorCode == 3024 || t.errorCode == 1969) return true
            if (t.message?.contains("SQLITE_INTERRUPT") == true) return true
        }
        t = t.cause
    }
    return false
}

internal fun readCell(rs: java.sql.ResultSet, index: Int): String? = try {
    rs.getString(index)
} catch (e: Exception) {
    "<undecodable>"
}
