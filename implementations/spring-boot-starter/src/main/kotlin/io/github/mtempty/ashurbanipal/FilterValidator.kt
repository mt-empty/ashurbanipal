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

/**
 * The common form widened to every value its engine stores and renders
 * (`spec/protocol.md` §5.4.2), so a cell's own text always filters back to
 * its row.
 */
enum class ValueForm(val description: String) {
    /** At most 35 integer and 30 fraction digits: the `DECIMAL(65,30)` cast's bound. */
    MYSQL_DECIMAL("a decimal number such as -12 or 0.5"),
    MYSQL_FLOAT("a number such as 0.5 or 1.5e-3"),

    /** Years 0001-9999, or the zero date `0000-00-00`. */
    MYSQL_DATE("a date such as 2016-01-31"),
    MYSQL_DATETIME(TIMESTAMP_DESCRIPTION),

    /** Hours up to ±838. */
    MYSQL_TIME("a time such as 10:30 or -100:00:00"),

    /** Any number of digits, `NaN` or `±Infinity`. */
    PG_NUMERIC("a decimal number such as -12, 0.5 or NaN"),
    PG_FLOAT("a number such as 0.5, 1.5e-3 or Infinity"),

    /** Years from 0001 with an optional ` BC`, above 9999, or `±infinity`. */
    PG_DATE("a date such as 2016-01-31, 0044-03-15 BC or infinity"),
    PG_TIMESTAMP(TIMESTAMP_DESCRIPTION),

    /** May carry a time-zone offset. */
    PG_TIMESTAMP_TZ("$TIMESTAMP_DESCRIPTION and an offset such as +02:00"),

    /** Hours 00-23, or exactly `24:00`. */
    PG_TIME("a time such as 10:30 or 10:30:00.5"),
    PG_TIME_TZ("a time such as 10:30, optionally with an offset such as +02:00"),
    ;

    fun accepts(v: String): Boolean = when (this) {
        MYSQL_DECIMAL -> MYSQL_DECIMAL_RE.matches(v)
        MYSQL_FLOAT -> MYSQL_FLOAT_RE.matches(v)
        MYSQL_DATE -> mysqlDate(v)
        MYSQL_DATETIME -> timestampOf(v, ::mysqlDate) { TIME_RE.matches(it) }
        MYSQL_TIME -> MYSQL_TIME_RE.matchEntire(v)?.let { it.groupValues[1].toInt() <= 838 } ?: false
        PG_NUMERIC -> PG_SPECIAL_NUMBER_RE.matches(v) || PG_NUMERIC_RE.matches(v)
        PG_FLOAT -> PG_SPECIAL_NUMBER_RE.matches(v) || PG_FLOAT_RE.matches(v)
        PG_DATE -> PG_INFINITY_RE.matches(v) || pgDateBc(v) { d, bc -> calendarDate(d, wideYears = true, bc = bc) }
        PG_TIMESTAMP -> pgTimestamp(v, PG_TIME_RE)
        PG_TIMESTAMP_TZ -> pgTimestamp(v, PG_TIME_TZ_RE)
        PG_TIME -> PG_TIME_RE.matches(v)
        PG_TIME_TZ -> PG_TIME_TZ_RE.matches(v)
    }
}

private const val TIMESTAMP_DESCRIPTION = "a date such as 2016-01-31, optionally with a time such as 10:30:00"
private const val CLOCK_TAIL = ":[0-5][0-9](:[0-5][0-9](\\.[0-9]{1,6})?)?"
private const val PG_CLOCK = "(([01][0-9]|2[0-3])$CLOCK_TAIL|24:00(:00(\\.0{1,6})?)?)"
private const val TZ_OFFSET = "(Z|[+-][0-9]{2}([0-9]{2}|:[0-9]{2}(:[0-9]{2})?)?)?"
private val MYSQL_DECIMAL_RE = Regex("[+-]?[0-9]{1,35}(\\.[0-9]{1,30})?")
private val MYSQL_FLOAT_RE = Regex("[+-]?[0-9]{1,35}(\\.[0-9]{1,30})?([eE][+-]?[0-9]{1,3})?")
private val MYSQL_TIME_RE = Regex("-?([0-9]{2,3})$CLOCK_TAIL")
private val PG_NUMERIC_RE = Regex("[+-]?[0-9]+(\\.[0-9]+)?")
private val PG_FLOAT_RE = Regex("[+-]?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]{1,3})?")
private val PG_SPECIAL_NUMBER_RE = Regex("nan|[+-]?infinity", RegexOption.IGNORE_CASE)
private val PG_INFINITY_RE = Regex("-?infinity", RegexOption.IGNORE_CASE)
private val TIME_RE = Regex("([01][0-9]|2[0-3])$CLOCK_TAIL")
private val PG_TIME_RE = Regex(PG_CLOCK)
private val PG_TIME_TZ_RE = Regex(PG_CLOCK + TZ_OFFSET)
private val DATE_RE = Regex("([0-9]{4,7})-([0-9]{2})-([0-9]{2})")

/**
 * A real YYYY-MM-DD date from year 0001; [wideYears] allows up to 7 year
 * digits. A [bc] year counts back from 1 BC, which is a leap year.
 */
private fun calendarDate(s: String, wideYears: Boolean, bc: Boolean): Boolean {
    val m = DATE_RE.matchEntire(s) ?: return false
    val (yText, monthText, dayText) = m.destructured
    if (!wideYears && yText.length != 4) return false
    val y = yText.toInt()
    val month = monthText.toInt()
    val day = dayText.toInt()
    if (y < 1 || month !in 1..12) return false
    val leapYear = if (bc) y - 1 else y
    val leap = leapYear % 4 == 0 && (leapYear % 100 != 0 || leapYear % 400 == 0)
    val days = intArrayOf(31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)[month - 1]
    return day in 1..days
}

private fun mysqlDate(s: String): Boolean = s == "0000-00-00" || calendarDate(s, wideYears = false, bc = false)

/** A date accepted by [dateOk], optionally followed by a space or `T` and a time accepted by [timeOk]. */
private fun timestampOf(v: String, dateOk: (String) -> Boolean, timeOk: (String) -> Boolean): Boolean {
    val i = v.indexOfFirst { it == ' ' || it == 'T' }
    return if (i < 0) dateOk(v) else dateOk(v.substring(0, i)) && timeOk(v.substring(i + 1))
}

/** Calls [f] with [v] minus a trailing ` BC`, and whether it had one. */
private fun pgDateBc(v: String, f: (String, Boolean) -> Boolean): Boolean =
    if (v.endsWith(" BC")) f(v.dropLast(3), true) else f(v, false)

private fun pgTimestamp(v: String, time: Regex): Boolean = PG_INFINITY_RE.matches(v) ||
    pgDateBc(v) { t, bc -> timestampOf(t, { calendarDate(it, wideYears = true, bc = bc) }) { time.matches(it) } }

/** SQLSTATEs that name a bad value, which in a filtered query is the filter's (`spec/protocol.md` §5.4.2). */
internal val BAD_VALUE_SQLSTATES = setOf("22P02", "22003", "22007", "22008", "22021", "22P05")

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
