package io.github.mtempty.ashurbanipal

import tools.jackson.databind.DeserializationFeature
import tools.jackson.databind.ObjectMapper
import tools.jackson.module.kotlin.jacksonMapperBuilder
import tools.jackson.module.kotlin.readValue

/**
 * `spec/protocol.md` §5.4.2's byte bound on the URL-decoded `filter` JSON
 * text. Not the DSL-era 1024: measured JSON-over-DSL inflation (worst case
 * 5.67x, per `implementations/rust/src/filter.rs`), 8192 is the nearest
 * clean power of two with margin.
 */
const val MAX_FILTER_BYTES = 8192
const val MAX_CONDITIONS = 10

private val VALID_OPS = setOf("=", "!=", ">", "<", ">=", "<=", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL")
private val OPS_WITHOUT_VALUE = setOf("IS NULL", "IS NOT NULL")

/** Thrown for any structural/allow-list violation; the controller maps every instance to 400 plain text (`spec/protocol.md` §2 — wording is implementation-defined). */
class FilterException(message: String) : RuntimeException(message)

/** `column` is exactly as received on the wire; only [Catalog] checks it against the live schema before it reaches SQL. */
data class Condition(
    val logic: String? = null,
    val not: Boolean = false,
    val column: String,
    val op: String,
    val value: String? = null,
)

data class WhereClause(val sql: String, val values: List<String>)

/**
 * Deserializes and structurally validates the `filter` query param
 * (`spec/protocol.md` §5.4.2), then renders a WHERE fragment with `?`
 * placeholders. No DSL text is ever understood here — grammar parsing
 * (DSL text -> AST) is frontend-only (`spec/filter-dsl.md`); this class
 * only ever sees the JSON AST.
 */
class FilterValidator {
    private val mapper: ObjectMapper = jacksonMapperBuilder()
        .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
        .build()

    /** An empty array is legal and means "no filter" (§5.4.2) — callers get back an empty list. */
    fun parse(raw: String): List<Condition> {
        val byteLength = raw.toByteArray(Charsets.UTF_8).size
        if (byteLength > MAX_FILTER_BYTES) {
            throw FilterException("filter too long: $byteLength bytes (max $MAX_FILTER_BYTES)")
        }
        val conditions: List<Condition> = try {
            mapper.readValue(raw)
        } catch (e: Exception) {
            throw FilterException("filter must be a JSON array of conditions: ${e.message}")
        }
        if (conditions.size > MAX_CONDITIONS) {
            throw FilterException("too many conditions: ${conditions.size} (max $MAX_CONDITIONS)")
        }
        conditions.forEachIndexed { i, condition ->
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
        }
        return conditions
    }

    /**
     * Every column is matched against [columnNames] (the live
     * `information_schema` allow-list, from [Catalog]) before it's spliced
     * into SQL — the same discipline `sort` gets. Conditions are joined by
     * their own `logic` tokens, relying on SQL's native AND-tighter-than-OR
     * precedence; there is no grouping/nesting in the AST.
     */
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
                "\"$column\"::text ${opSql(condition.op)} ?"
            } else {
                "\"$column\"::text ${opSql(condition.op)}"
            }
            val wrapped = if (condition.not) "(NOT ($inner))" else "($inner)"

            if (i > 0) {
                clause.append(if (condition.logic == "OR") " OR " else " AND ")
            }
            clause.append(wrapped)
        }
        return WhereClause(" where $clause", values)
    }

    /** The hardcoded operator -> SQL-fragment table (`spec/protocol.md` §5.4.2) — wire text is never used as an operator except through this match. */
    private fun opSql(op: String): String = when (op) {
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
}
