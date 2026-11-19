package io.github.mtempty.ashurbanipal

import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import java.io.File

/** Engine-native catalogs from `spec/fixtures/catalogs.json`, shared by the join and filter fixture runners (schema: `spec/fixtures/README.md`). */
internal object CatalogFixture {
    val mapper = ObjectMapper()

    fun read(name: String): JsonNode {
        val repoRoot = System.getProperty("ashurbanipal.repoRoot")
            ?: error("ashurbanipal.repoRoot system property not set (see build.gradle.kts)")
        return mapper.readTree(File(repoRoot, "spec/fixtures/$name"))
    }

    private val catalogs: JsonNode = read("catalogs.json")["catalogs"]

    /** One engine's half of the fixtures: how a catalog column row becomes a [ColMeta], as that backend builds it. */
    class Engine(
        val name: String,
        val dialect: JoinDialect,
        /** SQLite has no schema above the database. */
        val splicesSchema: Boolean,
        val column: (JsonNode) -> ColMeta,
    )

    val engines = listOf(
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

    fun catalog(engine: Engine): JsonNode = catalogs[engine.name] ?: error("catalogs.json has no ${engine.name} catalog")

    /** Every catalog table as the backend's lookup would build it, keyed `schema.table`. */
    fun tables(engine: Engine): Map<String, TableMeta> =
        catalog(engine)["tables"].properties().associate { (key, t) ->
            val (schema, name) = key.split(".", limit = 2)
            val columns = t["columns"].items().map(engine.column)
            val keys = t["unique_keys"].items().map { UniqueKey(it.text("name"), it["primary"].asBoolean(), it["columns"].strings()) }
            key to TableMeta(name, columns, schema.takeIf { engine.splicesSchema }, tieBreakKeys(columns, keys))
        }
}

internal fun JsonNode.text(key: String): String = this[key]?.asText() ?: ""

/** Jackson 3's own [JsonNode.map] shadows Kotlin's, so array elements go through a plain list. */
internal fun JsonNode.items(): List<JsonNode> = (0 until size()).map { get(it) }

internal fun JsonNode.strings(): List<String> = items().map { it.asText() }

/** The fixtures' placeholders are `\$n` (Postgres) or `?`; this port binds positional `?` everywhere. */
internal fun normalizePlaceholders(sql: String): String = sql.replace(Regex("\\$\\d+"), "?")
