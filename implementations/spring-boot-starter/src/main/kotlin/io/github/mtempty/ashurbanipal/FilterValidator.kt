package io.github.mtempty.ashurbanipal

import tools.jackson.databind.DeserializationFeature
import tools.jackson.databind.ObjectMapper
import tools.jackson.module.kotlin.jacksonMapperBuilder
import tools.jackson.module.kotlin.readValue

/** URL-decoded filter JSON bound (`spec/protocol.md` §5.4.2). */
const val MAX_FILTER_BYTES = 8192
const val MAX_CONDITIONS = 10
const val MAX_IN_ITEMS = 1000

internal val VALID_OPS =
    setOf("=", "!=", ">", "<", ">=", "<=", "LIKE", "ILIKE", "IN", "BETWEEN", "IS NULL", "IS NOT NULL")

/** Operators that do not take a value (`spec/protocol.md` §5.4.2). */
internal val OPS_WITHOUT_VALUE = setOf("IS NULL", "IS NOT NULL")

/** LIKE/ILIKE always compare the text cast, whatever the column's class. */
internal val PATTERN_OPS = setOf("LIKE", "ILIKE")

/** A structural, parse or oversize problem with the filter AST → 400 `invalid_filter` (`spec/protocol.md` §2). */
class FilterException(message: String) : RuntimeException(message)

/** A bad request parameter outside the filter (`order`, `limit`/`offset`, `sort_join`) → 400 `invalid_parameter`. */
class BadParameterException(message: String) : RuntimeException(message)

/** Untrusted filter input; [DbSource] validates columns before SQL (`spec/protocol.md` §5.4.2). */
data class Condition(
    val logic: String? = null,
    val not: Boolean = false,
    val column: String,
    val op: String,
    /** A JSON string for most ops; an array of strings for IN and BETWEEN. */
    val value: Any? = null,
    /** Table position, accepted only by `parse(raw, allowJoin = true)` (`spec/protocol.md` §5.11.3). */
    val join: Int? = null,
) {
    /** The values the condition binds, in order; call after [checkValueShape]. */
    fun items(): List<String> = when (value) {
        null -> emptyList()
        is String -> listOf(value)
        is List<*> -> value.map { it as String }
        else -> throw FilterException("value must be a string or an array of strings")
    }
}

/** Checks a condition's value against its op (`spec/protocol.md` §5.4.2). */
internal fun checkValueShape(condition: Condition, i: Int) {
    val op = condition.op
    val value = condition.value
    fun fail(why: String): Nothing = throw FilterException("condition $i: $why")
    when {
        op in OPS_WITHOUT_VALUE -> if (value != null) fail("op $op takes no value")
        value == null -> fail("op $op requires a value")
        op == "IN" || op == "BETWEEN" -> {
            if (value !is List<*> || value.any { it !is String }) fail("op $op needs an array of strings")
            if (op == "IN" && value.size !in 1..MAX_IN_ITEMS) fail("op IN needs an array of 1 to $MAX_IN_ITEMS strings")
            if (op == "BETWEEN" && value.size != 2) fail("op BETWEEN needs an array of two strings, [low, high]")
        }
        value !is String -> fail("op $op needs a string value")
    }
}

/** The form a value compared in its column's own type must have (`spec/protocol.md` §5.4.2). */
enum class ValueForm(val description: String) {
    NUMBER("a decimal number such as -12 or 0.5"),
    FLOAT("a number such as 0.5 or 1.5e-3"),
    DATE("a date such as 2016-01-31"),
    TIMESTAMP("a date such as 2016-01-31, optionally with a time such as 10:30:00"),

    /** May end in a time-zone offset (Postgres `timestamptz`). */
    TIMESTAMP_TZ("a date such as 2016-01-31, optionally with a time such as 10:30:00 and an offset such as +02:00"),
    TIME("a time such as 10:30 or 10:30:00.5"),

    /** May end in a time-zone offset (Postgres `timetz`). */
    TIME_TZ("a time such as 10:30, optionally with an offset such as +02:00"),
    ;

    fun accepts(v: String): Boolean = when (this) {
        NUMBER -> NUMBER_RE.matches(v)
        FLOAT -> FLOAT_RE.matches(v)
        DATE -> realDate(v)
        TIMESTAMP, TIMESTAMP_TZ -> TIMESTAMP_RE.matchEntire(v)?.let { m ->
            val time = if (this == TIMESTAMP_TZ) TIME_TZ_RE else TIME_RE
            realDate(m.groupValues[1]) && (m.groups[2] == null || time.matches(m.groupValues[2]))
        } ?: false
        TIME -> TIME_RE.matches(v)
        TIME_TZ -> TIME_TZ_RE.matches(v)
    }
}

private val NUMBER_RE = Regex("[+-]?[0-9]{1,35}(\\.[0-9]{1,30})?")
private val FLOAT_RE = Regex("[+-]?[0-9]{1,35}(\\.[0-9]{1,30})?([eE][+-]?[0-9]{1,3})?")
private val TIME_RE = Regex("([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]{1,6})?)?")
private val TIME_TZ_RE = Regex("([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}([0-9]{2}|:[0-9]{2}(:[0-9]{2})?)?)?")
private val DATE_RE = Regex("([0-9]{4})-([0-9]{2})-([0-9]{2})")
private val TIMESTAMP_RE = Regex("([0-9]{4}-[0-9]{2}-[0-9]{2})(?:[ T](.*))?", RegexOption.DOT_MATCHES_ALL)

/** A YYYY-MM-DD string naming a real day in years 0001-9999. */
private fun realDate(s: String): Boolean {
    val m = DATE_RE.matchEntire(s) ?: return false
    val (y, mo, d) = m.destructured
    if (y.toInt() < 1) return false
    return try {
        java.time.LocalDate.of(y.toInt(), mo.toInt(), d.toInt())
        true
    } catch (_: java.time.DateTimeException) {
        false
    }
}

data class WhereClause(val sql: String, val values: List<String>)

/** Validates filter JSON ASTs (`spec/protocol.md` §5.4.2); the frontend parses DSL text (`spec/filter-dsl.md`). */
class FilterValidator {
    private val mapper: ObjectMapper = jacksonMapperBuilder()
        .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
        .build()

    fun parse(raw: String, allowJoin: Boolean = false): List<Condition> {
        val byteLength = raw.toByteArray(Charsets.UTF_8).size
        if (byteLength > MAX_FILTER_BYTES) {
            throw FilterException("filter too long: $byteLength bytes (max $MAX_FILTER_BYTES)")
        }
        // Jackson can deserialize null collection elements despite the Kotlin type.
        val conditions: List<Condition?> = try {
            mapper.readValue(raw)
        } catch (e: Exception) {
            throw FilterException("filter must be a JSON array of conditions: ${e.message}")
        }
        if (conditions.size > MAX_CONDITIONS) {
            throw FilterException("too many conditions: ${conditions.size} (max $MAX_CONDITIONS)")
        }
        return conditions.mapIndexed { i, maybeCondition ->
            val condition = maybeCondition ?: throw FilterException("condition $i must not be null")
            if (condition.join != null && !allowJoin) {
                throw FilterException("join is only valid on the join route")
            }
            if (condition.join != null && condition.join < 0) {
                throw FilterException("condition $i has an invalid join position")
            }
            if (i == 0 && condition.logic != null) {
                throw FilterException("logic must be absent on the first condition")
            }
            if (i > 0 && condition.logic == null) {
                throw FilterException("condition $i is missing logic (\"AND\" or \"OR\")")
            }
            if (condition.logic != null && condition.logic != "AND" && condition.logic != "OR") {
                throw FilterException("condition $i has invalid logic ${condition.logic}")
            }
            if (condition.op !in VALID_OPS) {
                throw FilterException("condition $i has invalid op ${condition.op}")
            }
            checkValueShape(condition, i)
            condition
        }
    }
}

/** Maps allow-listed operators to SQL keywords, never passing through wire text (`spec/protocol.md` §5.4.2). */
internal fun opSqlKeyword(op: String): String = when (op) {
    "=" -> "="
    "!=" -> "!="
    ">" -> ">"
    "<" -> "<"
    ">=" -> ">="
    "<=" -> "<="
    "LIKE" -> "LIKE"
    "ILIKE" -> "ILIKE"
    "IN" -> "IN"
    "BETWEEN" -> "BETWEEN"
    "IS NULL" -> "IS NULL"
    "IS NOT NULL" -> "IS NOT NULL"
    else -> throw FilterException("invalid op $op")
}
