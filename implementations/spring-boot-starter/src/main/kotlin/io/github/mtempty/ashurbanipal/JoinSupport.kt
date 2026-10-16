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

/** A well-formed join request the catalog or the §5.11 rules reject; the controller maps it to 400 `invalid_parameter`. */
class BadJoinException(message: String) : RuntimeException("invalid join: $message")

data class ColumnPos(val join: Int, val column: String)
data class OnPair(val left: ColumnPos, val right: String)

/** [left] false is an inner join. */
data class JoinEntry(val left: Boolean, val table: String, val on: List<OnPair>)

/** Positions: 0 is [table], 1.. the entries of [joins] in order. */
data class JoinSpec(val table: String, val joins: List<JoinEntry>, val columns: List<ColumnPos>? = null) {
    fun tableNames(): List<String> = listOf(table) + joins.map { it.table }
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
    @JsonInclude(JsonInclude.Include.NON_NULL) val key: String? = null,
    @JsonInclude(JsonInclude.Include.NON_NULL) val references: ColumnRef? = null,
    @JsonInclude(JsonInclude.Include.NON_NULL) val comment: String? = null,
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
    checkKeys(root, setOf("table", "joins", "columns"), "join")
    val table = root.get("table")
    if (table == null || !table.isString) throw BadJoinException("join needs a string table")
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
        checkKeys(entry, setOf("type", "table", "on"), "join $position")
        val type = entry.get("type")?.takeIf { it.isString }?.stringValue()
        if (type != "inner" && type != "left") throw BadJoinException("join $position: type must be \"inner\" or \"left\"")
        val entryTable = entry.get("table")
        if (entryTable == null || !entryTable.isString) throw BadJoinException("join $position: table must be a string")
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
        JoinEntry(type == "left", entryTable.stringValue(), pairs)
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
    return JoinSpec(table.stringValue(), joins, columns)
}

/**
 * Comparison class of a column type (`spec/protocol.md` §5.11.2). [id] carries
 * an enumerated type's identity; `untyped` is a SQLite column with no declared
 * type and pairs only with itself.
 */
data class TypeClass(val kind: String, val id: String = "") {
    companion object {
        val NUMBER = TypeClass("number")
        val TEXT = TypeClass("text")
        val UUID = TypeClass("uuid")
        val BOOLEAN = TypeClass("boolean")
        val TEMPORAL = TypeClass("temporal")
        val TIME = TypeClass("time")
        val BINARY = TypeClass("binary")
        val UNTYPED = TypeClass("untyped")
        fun enum(identity: String) = TypeClass("enum", identity)
    }
}

/** One column as the live catalog reports it. [collation] is set where two text collations can clash (MySQL). */
data class JoinColMeta(
    val name: String,
    val type: String,
    val cls: TypeClass?,
    val collation: String? = null,
    val key: String? = null,
    val references: ColumnRef? = null,
    val comment: String? = null,
)

data class JoinTableMeta(val name: String, val columns: List<JoinColMeta>) {
    fun index(column: String): Int {
        val i = columns.indexOfFirst { it.name == column }
        if (i < 0) throw NotAllowedException("not allowed: column $column", NotAllowedKind.COLUMN)
        return i
    }
}

internal data class ResolvedCondition(val cond: Condition, val pos: Int, val col: Int)

/** A request resolved against the catalog; every name in SQL text comes from [tables], never the request. */
class JoinPlan internal constructor(
    val tables: List<JoinTableMeta>,
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
    fun columnInfos(): List<JoinColumnInfo> = selection.mapIndexed { i, (pos, col) ->
        val t = tables[pos]
        val c = t.columns[col]
        JoinColumnInfo(labels[i], c.type, pos, t.name, c.name, c.key, c.references, c.comment)
    }

    /** Keys positional result rows by label and trims the extra row asked for `has_more`. */
    fun joinData(rows: List<List<String?>>, limit: Long): JoinData {
        val hasMore = rows.size > limit
        val out = rows.take(limit.toInt()).map { row ->
            LinkedHashMap<String, String?>(labels.size).also { map -> labels.forEachIndexed { i, label -> map[label] = row[i] } }
        }
        return JoinData(columnInfos(), out, hasMore)
    }
}

private fun describe(t: JoinTableMeta, c: JoinColMeta) = "${t.name}.${c.name} (${c.type})"

private val FLOAT_TYPE = Regex("real|float|double", RegexOption.IGNORE_CASE)

private fun unjoinable(position: Int, t: JoinTableMeta, c: JoinColMeta): BadJoinException {
    val why = if (FLOAT_TYPE.containsMatchIn(c.type)) ": floating-point values are not compared exactly" else ""
    return BadJoinException("join $position on: ${describe(t, c)} cannot be used in a join$why")
}

private fun checkPair(position: Int, lt: JoinTableMeta, lc: JoinColMeta, rt: JoinTableMeta, rc: JoinColMeta) {
    val lcls = lc.cls ?: throw unjoinable(position, lt, lc)
    val rcls = rc.cls ?: throw unjoinable(position, rt, rc)
    if (lcls != rcls) {
        throw BadJoinException("join $position on: ${describe(lt, lc)} cannot be joined to ${describe(rt, rc)}")
    }
    if (lcls == TypeClass.TEXT && lc.collation != null && rc.collation != null && lc.collation != rc.collation) {
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
fun planJoin(spec: JoinSpec, tables: List<JoinTableMeta>, opts: JoinOpts): JoinPlan {
    val ons = spec.joins.mapIndexed { i, entry ->
        val position = i + 1
        entry.on.map { pair ->
            val lt = tables[pair.left.join]
            val lc = lt.index(pair.left.column)
            val rc = tables[position].index(pair.right)
            checkPair(position, lt, lt.columns[lc], tables[position], tables[position].columns[rc])
            Triple(pair.left.join, lc, rc)
        }
    }

    val selection: List<Pair<Int, Int>> = spec.columns?.map { c ->
        if (c.join >= tables.size) throw BadJoinException("columns: position ${c.join} is not in the join")
        c.join to tables[c.join].index(c.column)
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

    if (opts.sort == null && opts.sortJoin != null) throw BadJoinException("sort_join needs sort")
    val sort = opts.sort?.let { column ->
        val pos = opts.sortJoin ?: 0
        if (pos < 0 || pos >= tables.size) throw BadJoinException("sort_join: position $pos is not in the join")
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
 * Renders `<select list> from … limit ? offset ?` (no leading `select`, so
 * MySQL can wrap it in its timeout hint) and the filter values in
 * placeholder order. Bind the values first, then limit, then offset.
 */
internal fun buildJoinSelect(plan: JoinPlan, d: JoinDialect, schema: String?): Pair<String, List<String>> {
    fun alias(pos: Int, col: Int) = "t$pos.${d.quote(plan.tables[pos].columns[col].name)}"
    fun fromItem(pos: Int): String {
        val name = d.quote(plan.tables[pos].name)
        return if (schema != null) "${d.quote(schema)}.$name t$pos" else "$name t$pos"
    }

    val selectList = plan.selection.mapIndexed { i, (p, c) -> "${d.castText(alias(p, c))} as c$i" }.joinToString(", ")
    val sql = StringBuilder("$selectList from ${fromItem(0)}")
    plan.left.forEachIndexed { i, isLeft ->
        val position = i + 1
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
    plan.sort?.let { (p, c) -> sql.append(" order by ${alias(p, c)} ${if (plan.descending) "desc" else "asc"}") }
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
