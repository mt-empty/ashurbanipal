package io.github.mtempty.ashurbanipal

import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

/** Consumes the shared filter fixtures directly from the repository root. */
class FilterValidatorFixtureTest {
    private val mapper = ObjectMapper()
    private val fixturesFile: File = run {
        val repoRoot = System.getProperty("ashurbanipal.repoRoot")
            ?: error("ashurbanipal.repoRoot system property not set (see build.gradle.kts)")
        File(repoRoot, "spec/fixtures/filter-builder-tests.json")
    }

    /** The fixture's `tables` map in place of the live catalog lookup (spec/fixtures/README.md). */
    private fun seedTable(root: JsonNode, table: String): TableMeta {
        val columns = root["tables"][table] ?: error("fixture references unmapped table $table")
        return TableMeta(table, columns.properties().map { (name, c) ->
            val type = c["type"].asText()
            ColMeta(name = name, type = type, columnClass = pgColumnClass(type, "", "", false), compare = pgTypedCompare(type))
        })
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
                    val whereClause = runCatching { tableWhereClause(conditions, seedTable(root, table), PG_DIALECT) }
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
                    val thrown = assertThrows(NotAllowedException::class.java, { tableWhereClause(conditions, seedTable(root, table), PG_DIALECT) }, "case $name")
                    assertEquals(NotAllowedKind.COLUMN, thrown.kind, "case $name")
                }
                expectError == "invalid_value" -> {
                    val conditions = runCatching { validator.parse(raw) }
                        .getOrElse { throw AssertionError("case $name: should parse (rejection is builder-stage): ${it.message}", it) }
                    assertThrows(FilterException::class.java, { tableWhereClause(conditions, seedTable(root, table), PG_DIALECT) }, "case $name")
                }
                expectError != null -> {
                    assertThrows(FilterException::class.java, { validator.parse(raw) }, "case $name: expected structural rejection ($expectError)")
                }
                else -> throw AssertionError("case $name: neither expect nor expect_error present")
            }
        }
    }
}
