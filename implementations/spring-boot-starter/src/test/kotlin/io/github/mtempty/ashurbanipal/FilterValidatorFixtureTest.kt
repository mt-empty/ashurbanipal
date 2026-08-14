package io.github.mtempty.ashurbanipal

import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

/**
 * Consumes `spec/fixtures/filter-builder-tests.json` directly from the repo
 * root (schema: `spec/fixtures/README.md`) — the same file
 * `implementations/rust/core/src/db/postgres.rs`'s unit runner and the
 * black-box HTTP suite consume, so this port's validation/building
 * behavior can't drift from the reference's without a fixture-level
 * failure. Not copied into `src/test/resources`.
 */
class FilterValidatorFixtureTest {
    private val mapper = ObjectMapper()
    private val fixturesFile: File = run {
        val repoRoot = System.getProperty("ashurbanipal.repoRoot")
            ?: error("ashurbanipal.repoRoot system property not set (see build.gradle.kts)")
        File(repoRoot, "spec/fixtures/filter-builder-tests.json")
    }

    /** Static mirror of the seed schema's columns for the fixture's tables (README: unit runners substitute this for the live information_schema lookup). */
    private fun seedColumns(table: String): List<String> = when (table) {
        "users" -> listOf(
            "id", "email", "full_name", "age", "is_active", "login_count",
            "metadata", "last_login_at", "created_at",
        )
        "orders" -> listOf(
            "id", "user_id", "status", "total_cents", "discount_pct", "tags",
            "line_items", "created_at",
        )
        "products" -> listOf(
            "id", "sku", "name", "category", "price", "weight_kg", "in_stock",
            "description", "created_on",
        )
        else -> error("fixture references unmapped table $table")
    }

    /** The fixture's `$n` placeholders are Postgres-numbered; this port binds positional `?` instead, so only order/count matter, not numbering. */
    private fun normalizePlaceholders(fragment: String): String = fragment.replace(Regex("\\$\\d+"), "?")

    @Test
    fun filterBuilderFixtures() {
        val root = mapper.readTree(fixturesFile)
        val cases = root["cases"]
        assertTrue(cases.size() > 0, "fixture file has no cases")
        val validator = FilterValidator()

        for (case in cases) {
            val name = case["name"].asText()
            val table = case["table"].asText()
            val raw = if (case.has("raw")) case["raw"].asText() else mapper.writeValueAsString(case["conditions"])
            val expect = case["expect"]
            val expectError = case["expect_error"]?.asText()

            when {
                expect != null -> {
                    val conditions = runCatching { validator.parse(raw) }
                        .getOrElse { throw AssertionError("case $name: parse failed: ${it.message}", it) }
                    val whereClause = runCatching { validator.buildWhereClause(conditions, seedColumns(table)) }
                        .getOrElse { throw AssertionError("case $name: build failed: ${it.message}", it) }

                    val expectedWhereRaw = expect["where"].asText()
                    val expectedWhere = if (expectedWhereRaw.isEmpty()) "" else " where ${normalizePlaceholders(expectedWhereRaw)}"
                    assertEquals(expectedWhere, whereClause.sql, "case $name: WHERE mismatch")

                    val expectedValues = (expect["values"] as Iterable<JsonNode>).map { it.asText() }
                    assertEquals(expectedValues, whereClause.values, "case $name: bind values mismatch")
                }
                expectError == "unknown_column" -> {
                    val conditions = runCatching { validator.parse(raw) }
                        .getOrElse { throw AssertionError("case $name: should parse (rejection is builder-stage): ${it.message}", it) }
                    assertThrows(FilterException::class.java, { validator.buildWhereClause(conditions, seedColumns(table)) }, "case $name")
                }
                expectError != null -> {
                    assertThrows(FilterException::class.java, { validator.parse(raw) }, "case $name: expected structural rejection ($expectError)")
                }
                else -> throw AssertionError("case $name: neither expect nor expect_error present")
            }
        }
    }
}
