package io.github.mtempty.ashurbanipal

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import tools.jackson.databind.JsonNode

/** Consumes `spec/fixtures/filter-builder-tests.json` (schema: `spec/fixtures/README.md`) for each engine. */
class FilterValidatorFixtureTest {
    private val root: JsonNode = CatalogFixture.read("filter-builder-tests.json")

    private data class Outcome(val where: String? = null, val values: List<String>? = null, val error: String? = null)

    /** Structural kinds all fail the parse before any schema access, so they compare as one. */
    private fun kind(k: String): String = if (k == "unknown_column" || k == "invalid_value") k else STRUCTURAL

    private fun expected(engine: CatalogFixture.Engine, case: JsonNode): Outcome? {
        case["expect_error"]?.let { return Outcome(error = kind(it.asText())) }
        val want = case["expect"][engine.name] ?: return null
        want["error"]?.let { return Outcome(error = kind(it.asText())) }
        return Outcome(normalizePlaceholders(want.text("where")), want["values"].strings())
    }

    private fun run(engine: CatalogFixture.Engine, table: TableMeta, case: JsonNode): Outcome {
        val raw = case["raw"]?.asText() ?: CatalogFixture.mapper.writeValueAsString(case["conditions"])
        val conditions = try {
            FilterValidator().parse(raw)
        } catch (_: FilterException) {
            return Outcome(error = STRUCTURAL)
        }
        return try {
            val where = tableWhereClause(conditions, table, engine.dialect)
            Outcome(where.sql.removePrefix(" where "), where.values)
        } catch (_: NotAllowedException) {
            Outcome(error = "unknown_column")
        } catch (_: FilterException) {
            Outcome(error = "invalid_value")
        }
    }

    @TestFactory
    fun filterBuilderFixtures(): List<DynamicTest> = CatalogFixture.engines.flatMap { engine ->
        val schema = CatalogFixture.catalog(engine).text("default_schema")
        val tables = CatalogFixture.tables(engine)
        val cases = root["cases"].items().mapNotNull { case -> expected(engine, case)?.let { case to it } }
        assertTrue(cases.isNotEmpty(), "no filter fixture cases for ${engine.name}")
        cases.map { (case, want) ->
            DynamicTest.dynamicTest("${engine.name}: ${case.text("name")}") {
                val key = "$schema.${case.text("table")}"
                val table = tables[key] ?: error("no $key in the ${engine.name} catalog")
                assertEquals(want, run(engine, table, case))
            }
        }
    }

    private companion object {
        const val STRUCTURAL = "structural"
    }
}
