package io.github.mtempty.ashurbanipal

import tools.jackson.databind.DeserializationFeature
import tools.jackson.databind.ObjectMapper
import tools.jackson.module.kotlin.jacksonMapperBuilder
import tools.jackson.module.kotlin.readValue

/** URL-decoded filter JSON bound (`spec/protocol.md` §5.4.2). */
const val MAX_FILTER_BYTES = 8192
const val MAX_CONDITIONS = 10

private val VALID_OPS = setOf("=", "!=", ">", "<", ">=", "<=", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL")

/** Operators that do not take a value (`spec/protocol.md` §5.4.2). */
internal val OPS_WITHOUT_VALUE = setOf("IS NULL", "IS NOT NULL")

/** Invalid filter input (`spec/protocol.md` §2). */
class FilterException(message: String) : RuntimeException(message)

/** Untrusted filter input; [DbSource] validates columns before SQL (`spec/protocol.md` §5.4.2). */
data class Condition(
    val logic: String? = null,
    val not: Boolean = false,
    val column: String,
    val op: String,
    val value: String? = null,
)

data class WhereClause(val sql: String, val values: List<String>)

/** Validates filter JSON ASTs (`spec/protocol.md` §5.4.2); the frontend parses DSL text (`spec/filter-dsl.md`). */
class FilterValidator {
    private val mapper: ObjectMapper = jacksonMapperBuilder()
        .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
        .build()

    fun parse(raw: String): List<Condition> {
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
            val takesValue = condition.op !in OPS_WITHOUT_VALUE
            if (takesValue && condition.value == null) {
                throw FilterException("op ${condition.op} requires a value")
            }
            if (!takesValue && condition.value != null) {
                throw FilterException("op ${condition.op} takes no value")
            }
            condition
        }
    }

    /** Validates live-schema columns before SQL interpolation (`spec/protocol.md` §5.4.2). */
    fun buildWhereClause(conditions: List<Condition>, columnNames: List<String>): WhereClause {
        if (conditions.isEmpty()) {
            return WhereClause("", emptyList())
        }
        val values = mutableListOf<String>()
        val clause = StringBuilder()
        conditions.forEachIndexed { i, condition ->
            val column = columnNames.find { it == condition.column }
                ?: throw FilterException("not allowed: column ${condition.column}")

            val inner = if (condition.op !in OPS_WITHOUT_VALUE) {
                val value = condition.value
                    ?: throw FilterException("op ${condition.op} requires a value")
                values.add(value)
                "${quoteIdent(column)}::text ${opSql(condition.op)} ?"
            } else {
                "${quoteIdent(column)}::text ${opSql(condition.op)}"
            }
            val wrapped = if (condition.not) "(NOT ($inner))" else "($inner)"

            if (i > 0) {
                clause.append(if (condition.logic == "OR") " OR " else " AND ")
            }
            clause.append(wrapped)
        }
        return WhereClause(" where $clause", values)
    }

    private fun opSql(op: String): String = opSqlKeyword(op)
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
    "IS NULL" -> "IS NULL"
    "IS NOT NULL" -> "IS NOT NULL"
    else -> throw FilterException("invalid op $op")
}
