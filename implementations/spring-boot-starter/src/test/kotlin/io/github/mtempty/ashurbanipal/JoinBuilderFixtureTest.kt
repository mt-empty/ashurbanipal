package io.github.mtempty.ashurbanipal

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import java.io.File

/** Consumes `spec/fixtures/join-builder-tests.json` (schema: `spec/fixtures/README.md`) for each engine. */
class JoinBuilderFixtureTest {
    private val mapper = ObjectMapper()
    private val root: JsonNode = run {
        val repoRoot = System.getProperty("ashurbanipal.repoRoot")
            ?: error("ashurbanipal.repoRoot system property not set (see build.gradle.kts)")
        mapper.readTree(File(repoRoot, "spec/fixtures/join-builder-tests.json"))
    }

    /** One engine's half of the fixture: how a catalog column row becomes a [ColMeta], as that backend builds it. */
    private class Engine(
        val name: String,
        val dialect: JoinDialect,
        /** SQLite has no schema above the database. */
        val splicesSchema: Boolean,
        val column: (JsonNode) -> ColMeta,
    )

    private data class Outcome(
        val sql: String? = null,
        val values: List<String>? = null,
        val labels: List<String>? = null,
        val error: String? = null,
    )

    private fun JsonNode.text(key: String): String = this[key]?.asText() ?: ""

    /** Jackson 3's own [JsonNode.map] shadows Kotlin's, so array elements go through a plain list. */
    private fun JsonNode.items(): List<JsonNode> = (0 until size()).map { get(it) }

    private val engines = listOf(
        Engine("postgres", PG_DIALECT, true) { c ->
            ColMeta(
                name = c.text("name"),
                type = c.text("type"),
                columnClass = pgColumnClass(c.text("data_type"), c.text("udt_schema"), c.text("udt_name"), c["is_enum"].asBoolean()),
                compare = pgTypedCompare(c.text("data_type")),
                collation = c["collation"]?.asText(),
            )
        },
        Engine("mysql", MYSQL_DIALECT, true) { c ->
            ColMeta(
                name = c.text("name"),
                type = c.text("column_type"),
                columnClass = mysqlColumnClass(c.text("data_type"), c.text("column_type")),
                compare = mysqlTypedCompare(c.text("data_type")),
                collation = c["collation"]?.asText(),
            )
        },
        Engine("sqlite", SQLITE_DIALECT, false) { c ->
            val declared = c.text("declared")
            val columnClass = sqliteColumnClass(declared)
            ColMeta(
                name = c.text("name"),
                type = declared.ifEmpty { "unknown" },
                columnClass = columnClass,
                compare = sqliteTypedCompare(columnClass),
            )
        },
    )

    private fun strings(node: JsonNode): List<String> = node.items().map { it.asText() }

    private fun tables(engine: Engine, catalog: JsonNode): Map<String, TableMeta> =
        catalog["tables"].properties().associate { (key, t) ->
            val (schema, name) = key.split(".", limit = 2)
            val columns = t["columns"].items().map(engine.column)
            val keys = t["unique_keys"].items().map { UniqueKey(it.text("name"), it["primary"].asBoolean(), strings(it["columns"])) }
            key to TableMeta(name, columns, schema.takeIf { engine.splicesSchema }, tieBreakKeys(columns, keys))
        }

    /** The fixture's placeholders are `$n` (Postgres) or `?`; this port binds positional `?` everywhere. */
    private fun normalize(sql: String): String = sql.replace(Regex("\\$\\d+"), "?")

    private fun run(engine: Engine, catalog: JsonNode, tables: Map<String, TableMeta>, case: JsonNode): Outcome {
        val request = case["schema"]?.asText() ?: catalog.text("default_schema")
        val listed = strings(catalog["schemas"])
        check(request in listed) { "request schema $request is not in the ${engine.name} catalog" }
        return try {
            val raw = case["join_raw"]?.asText() ?: mapper.writeValueAsString(case["join"])
            val spec = parseJoin(raw)
            val opts = JoinOpts(
                limit = 50,
                offset = 0,
                sort = case["sort"]?.asText(),
                sortJoin = case["sort_join"]?.asInt(),
                descending = case["order"]?.asText() == "desc",
                filter = case["filter"]?.let { FilterValidator().parse(mapper.writeValueAsString(it), allowJoin = true) },
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

    private fun expected(engine: Engine, case: JsonNode): Outcome? {
        case["expect_error"]?.let { return Outcome(error = it.asText()) }
        val want = case["expect"][engine.name] ?: return null
        want["error"]?.let { return Outcome(error = it.asText()) }
        return Outcome(normalize(want.text("sql")), strings(want["values"]), strings(want["labels"]))
    }

    @TestFactory
    fun joinBuilderFixtures(): List<DynamicTest> = engines.flatMap { engine ->
        val catalog = root["catalogs"][engine.name] ?: error("fixture has no ${engine.name} catalog")
        val tables = tables(engine, catalog)
        val cases = root["cases"].items().mapNotNull { case -> expected(engine, case)?.let { case to it } }
        assertTrue(cases.isNotEmpty(), "no join fixture cases for ${engine.name}")
        cases.map { (case, want) ->
            DynamicTest.dynamicTest("${engine.name}: ${case.text("name")}") {
                assertEquals(want, run(engine, catalog, tables, case))
            }
        }
    }
}
