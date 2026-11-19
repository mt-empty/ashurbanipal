package io.github.mtempty.ashurbanipal

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import tools.jackson.databind.JsonNode

/** Consumes `spec/fixtures/join-builder-tests.json` (schema: `spec/fixtures/README.md`) for each engine. */
class JoinBuilderFixtureTest {
    private val root: JsonNode = CatalogFixture.read("join-builder-tests.json")

    private data class Outcome(
        val sql: String? = null,
        val values: List<String>? = null,
        val labels: List<String>? = null,
        val error: String? = null,
    )

    private fun run(engine: CatalogFixture.Engine, catalog: JsonNode, tables: Map<String, TableMeta>, case: JsonNode): Outcome {
        val request = case["schema"]?.asText() ?: catalog.text("default_schema")
        val listed = catalog["schemas"].strings()
        check(request in listed) { "request schema $request is not in the ${engine.name} catalog" }
        return try {
            val raw = case["join_raw"]?.asText() ?: CatalogFixture.mapper.writeValueAsString(case["join"])
            val spec = parseJoin(raw)
            val opts = JoinOpts(
                limit = 50,
                offset = 0,
                sort = case["sort"]?.asText(),
                sortJoin = case["sort_join"]?.asInt(),
                descending = case["order"]?.asText() == "desc",
                filter = case["filter"]?.let { FilterValidator().parse(CatalogFixture.mapper.writeValueAsString(it), allowJoin = true) },
            )
            val refs = spec.tableRefs()
            val schemas = tableSchemas(refs, request, listed)
            val metas = refs.mapIndexed { i, r ->
                tables["${schemas[i]}.${r.table}"] ?: throw BadJoinException("unknown table \"${r.table}\"")
            }
            val plan = planJoin(spec, metas, opts)
            val (sql, values) = buildJoinSelect(plan, engine.dialect)
            Outcome(sql = sql, values = values, labels = plan.labels)
        } catch (e: RuntimeException) {
            Outcome(error = requestProblemCode(e))
        }
    }

    private fun expected(engine: CatalogFixture.Engine, case: JsonNode): Outcome? {
        case["expect_error"]?.let { return Outcome(error = it.asText()) }
        val want = case["expect"][engine.name] ?: return null
        want["error"]?.let { return Outcome(error = it.asText()) }
        return Outcome(normalizePlaceholders(want.text("sql")), want["values"].strings(), want["labels"].strings())
    }

    @TestFactory
    fun joinBuilderFixtures(): List<DynamicTest> = CatalogFixture.engines.flatMap { engine ->
        val catalog = CatalogFixture.catalog(engine)
        val tables = CatalogFixture.tables(engine)
        val cases = root["cases"].items().mapNotNull { case -> expected(engine, case)?.let { case to it } }
        assertTrue(cases.isNotEmpty(), "no join fixture cases for ${engine.name}")
        cases.map { (case, want) ->
            DynamicTest.dynamicTest("${engine.name}: ${case.text("name")}") {
                assertEquals(want, run(engine, catalog, tables, case))
            }
        }
    }
}
