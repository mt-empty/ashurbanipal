package io.github.mtempty.ashurbanipal

import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.http.HttpStatus
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.web.client.HttpClientErrorException
import org.springframework.web.client.RestTemplate
import java.net.URI

/**
 * Boots the starter as a real Spring Boot app against the devcontainer's
 * live Postgres with `conformance/seed/seed.sql` applied directly (no
 * Testcontainers/Docker available in this environment — see PORTING.md).
 * This is a spot-check of the JSON shapes with a real HTTP client; the
 * actual conformance bar is the golden-fixture runner and schemathesis run
 * externally against this same app.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    classes = [AshurbanipalIntegrationTest.TestApp::class],
)
class AshurbanipalIntegrationTest {

    // scanBasePackages points at an empty package deliberately: TestApp lives
    // in the same package as DbViewerController, and @RestController is a
    // component stereotype — without this, component-scanning would register
    // a *second* DbViewerController bean alongside the one
    // AshurbanipalAutoConfiguration's @Bean method creates, both mapping the
    // same routes ("Ambiguous mapping"). A real host app wouldn't hit this
    // (its own base package doesn't contain io.github.mtempty.ashurbanipal),
    // so this is a test-harness-only workaround, not a starter design issue.
    @SpringBootApplication(scanBasePackages = ["io.github.mtempty.ashurbanipal.testapp"])
    class TestApp

    companion object {
        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            val databaseUrl = System.getenv("DATABASE_URL")
                ?: error("DATABASE_URL must be set (the devcontainer sets it automatically)")
            val uri = URI(databaseUrl)
            val (user, password) = (uri.userInfo ?: ":").split(":", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
            registry.add("spring.datasource.url") { "jdbc:postgresql://${uri.host}:${uri.port}${uri.path}" }
            registry.add("spring.datasource.username") { user }
            registry.add("spring.datasource.password") { password }
            registry.add("ashurbanipal.enabled") { "true" }
        }
    }

    @LocalServerPort
    private var port: Int = 0

    private val http = RestTemplate()
    private val mapper = ObjectMapper()

    private fun url(path: String) = "http://localhost:$port/__ashurbanipal$path"

    private fun getJson(path: String): JsonNode = mapper.readTree(http.getForObject(url(path), String::class.java))

    /**
     * `RestTemplate.getForObject(String, ...)` treats a plain `String` URL as
     * a template and percent-encodes it again, so a pre-encoded `filter`
     * value gets double-encoded (and the `URI(scheme, host, path, query,
     * fragment)` multi-arg constructor still leaves enough of `{`/`"`
     * unescaped that Tomcat's own URI parser 400s before the request even
     * reaches Spring). Percent-encoding the raw JSON exactly once with
     * `URLEncoder`, then handing the fully-formed string to the single-arg
     * `URI(String)` constructor (which parses without re-encoding) and the
     * `getForObject(URI, ...)` overload (which sends it as-is), is the one
     * combination that encodes exactly once.
     */
    private fun getJsonWithRawQuery(path: String, rawQueryTemplate: String, filterJson: String): JsonNode {
        val encodedFilter = java.net.URLEncoder.encode(filterJson, "UTF-8")
        val uri = URI("${url(path)}?$rawQueryTemplate&filter=$encodedFilter")
        return mapper.readTree(http.getForObject(uri, String::class.java))
    }

    @Test
    fun `lists exactly the seeded tables in alphabetical order`() {
        val body = getJson("/api/tables")
        val names = (body["tables"] as Iterable<JsonNode>).map { it["name"].asText() }
        val expected = listOf(
            "_conformance_meta", "audit_log", "events", "feature_flags", "inventory_counts",
            "inventory_locations", "order_extra", "orders", "payments", "products", "reviews",
            "saved_reports", "sessions", "support_tickets", "users",
        )
        assertEquals(expected, names)
    }

    @Test
    fun `table comments are present only where seeded`() {
        val body = getJson("/api/tables")
        val byName = { n: String -> body["tables"].first { it["name"].asText() == n } }
        assertTrue(byName("users").has("comment"))
        assertFalse(byName("products").has("comment"))
    }

    @Test
    fun `table-counts reports -1 for the never-analyzed table`() {
        val body = getJson("/api/table-counts")
        val featureFlags = body["counts"].first { it["table"].asText() == "feature_flags" }
        assertEquals(-1, featureFlags["approx_rows"].asInt())
    }

    @Test
    fun `pk and fk column metadata is correct`() {
        val body = getJson("/api/tables/data?table=orders&limit=1")
        val columns = body["columns"]
        val id = columns.first { it["name"].asText() == "id" }
        assertEquals("pk", id["key"].asText())
        val userId = columns.first { it["name"].asText() == "user_id" }
        assertEquals("fk", userId["key"].asText())
        assertEquals("users", userId["references"]["table"].asText())
        assertEquals("id", userId["references"]["column"].asText())
    }

    @Test
    fun `pk and fk column reports both`() {
        // docs/feature-backlog/13-pk-that-is-also-fk-loses-references.md:
        // order_extra.order_id is both its own table's PK and an FK into
        // orders(id) — key must still report pk, but references must be
        // populated too, not omitted the way a plain PK's is.
        val body = getJson("/api/tables/data?table=order_extra&limit=1")
        val orderId = body["columns"].first { it["name"].asText() == "order_id" }
        assertEquals("pk", orderId["key"].asText())
        assertEquals("orders", orderId["references"]["table"].asText())
        assertEquals("id", orderId["references"]["column"].asText())
    }

    @Test
    fun `composite foreign key columns omit key metadata entirely`() {
        val body = getJson("/api/tables/data?table=inventory_counts&limit=1")
        val columns = body["columns"]
        for (composite in listOf("warehouse_code", "bin_code")) {
            val col = columns.first { it["name"].asText() == composite }
            assertFalse(col.has("key"), "$composite should have no key field")
            assertFalse(col.has("references"), "$composite should have no references field")
        }
        val productId = columns.first { it["name"].asText() == "product_id" }
        assertEquals("fk", productId["key"].asText())
    }

    @Test
    fun `every cell value is a json string or null`() {
        val body = getJson("/api/tables/data?table=users&limit=10")
        for (row in body["rows"]) {
            for (field in listOf("login_count", "is_active", "metadata", "id", "created_at")) {
                val v = row[field]
                assertTrue(v.isTextual || v.isNull, "users.$field = $v is not a string or null")
            }
        }
    }

    @Test
    fun `limit clamps to the configured range`() {
        assertEquals(50, getJson("/api/tables/data?table=events")["rows"].size())
        assertEquals(100, getJson("/api/tables/data?table=events&limit=1000")["rows"].size())
        assertEquals(1, getJson("/api/tables/data?table=events&limit=0")["rows"].size())
    }

    @Test
    fun `offset beyond table size returns empty rows not an error`() {
        val body = getJson("/api/tables/data?table=users&offset=10000")
        assertEquals(0, body["rows"].size())
    }

    @Test
    fun `sort on a numeric column is numeric not lexicographic`() {
        val body = getJson("/api/tables/data?table=products&sort=price&order=asc&limit=100")
        val prices = (body["rows"] as Iterable<JsonNode>).map { it["price"].asText().toDouble() }
        assertEquals(prices.sorted(), prices)
    }

    @Test
    fun `equality filter narrows rows`() {
        val filter = """[{"column":"status","op":"=","value":"completed"}]"""
        val body = getJsonWithRawQuery("/api/tables/data", "table=orders", filter)
        val rows = body["rows"]
        assertTrue(rows.size() > 0)
        for (row in rows) {
            assertEquals("completed", row["status"].asText())
        }
    }

    @Test
    fun `total_approx is unaffected by filter`() {
        val unfiltered = getJson("/api/tables/data?table=orders")
        val filter = """[{"column":"status","op":"=","value":"pending"}]"""
        val filtered = getJsonWithRawQuery("/api/tables/data", "table=orders", filter)
        assertEquals(unfiltered["total_approx"].asLong(), filtered["total_approx"].asLong())
        assertTrue(filtered["rows"].size() < unfiltered["rows"].size())
    }

    @Test
    fun `unknown table is rejected with 400`() {
        val ex = org.junit.jupiter.api.Assertions.assertThrows(HttpClientErrorException::class.java) {
            http.getForObject(url("/api/tables/data?table=nonexistent"), String::class.java)
        }
        assertEquals(HttpStatus.BAD_REQUEST, ex.statusCode)
    }

    @Test
    fun `common-values on a never-analyzed column yields an empty list not an error`() {
        val body = getJson("/api/tables/common-values?table=feature_flags&column=enabled")
        assertEquals(0, body["values"].size())
    }

    @Test
    fun `common-values renders booleans as true false not pg array literals`() {
        val body = getJson("/api/tables/common-values?table=users&column=is_active")
        val values = (body["values"] as Iterable<JsonNode>).map { it["value"].asText() }
        assertTrue(values.contains("true") || values.contains("false"))
        assertFalse(values.any { it == "t" || it == "f" })
    }

    @Test
    fun `siblings endpoint returns an empty list by default`() {
        val body = getJson("/api/siblings")
        assertEquals(0, body["siblings"].size())
    }

    @Test
    fun `every api response carries the protocol version header`() {
        val response = http.getForEntity(url("/api/tables"), String::class.java)
        assertEquals("1", response.headers.getFirst("x-ashurbanipal-protocol"))
    }

    @Test
    fun `html route has no protocol header and serves the vendored frontend`() {
        val response = http.getForEntity(url(""), String::class.java)
        assertNull(response.headers.getFirst("x-ashurbanipal-protocol"))
        assertTrue(response.body?.contains("id=\"tables\"") == true)
    }

    @Test
    fun `schema scoping excludes other schemas`() {
        val body = getJson("/api/tables")
        val names = (body["tables"] as Iterable<JsonNode>).map { it["name"].asText() }
        assertFalse(names.contains("decoy_items"))
    }

    @Test
    fun `api schemas lists the seed's schemas excluding system namespaces`() {
        val body = getJson("/api/schemas")
        val names = (body["schemas"] as Iterable<JsonNode>).map { it.asText() }
        assertTrue(names.contains("public") && names.contains("other_schema") && names.contains("warehouse"))
        assertFalse(names.any { it == "pg_catalog" || it == "information_schema" || it.startsWith("pg_") })
    }

    @Test
    fun `explicit schema=public matches the implicit default`() {
        assertEquals(getJson("/api/tables"), getJson("/api/tables?schema=public"))
    }

    @Test
    fun `explicit other schema selects only its own table`() {
        val body = getJson("/api/tables?schema=other_schema")
        val names = (body["tables"] as Iterable<JsonNode>).map { it["name"].asText() }
        assertEquals(listOf("decoy_items"), names)

        val data = getJson("/api/tables/data?schema=other_schema&table=decoy_items")
        assertEquals(2, data["rows"].size())
    }

    @Test
    fun `unrecognized schema values are rejected cleanly on every route`() {
        for (evil in listOf("", "nonexistent_schema", "public\"; drop schema public cascade; --", "public' OR '1'='1")) {
            for (path in listOf(
                "/api/tables?schema=$evil",
                "/api/table-counts?schema=$evil",
                "/api/tables/data?schema=$evil&table=users",
                "/api/tables/common-values?schema=$evil&table=users&column=email",
            )) {
                val ex = org.junit.jupiter.api.Assertions.assertThrows(HttpClientErrorException::class.java) {
                    http.getForObject(url(path), String::class.java)
                }
                assertEquals(HttpStatus.BAD_REQUEST, ex.statusCode, path)
            }
        }

        // Confirm no damage: the default view is unaffected by the attempts above.
        val body = getJson("/api/tables")
        val names = (body["tables"] as Iterable<JsonNode>).map { it["name"].asText() }
        assertFalse(names.contains("decoy_items"))
        assertTrue(names.contains("users"))
    }

    @Test
    fun `cross-schema fk reference includes the referenced table's schema`() {
        val body = getJson("/api/tables/data?schema=warehouse&table=shipments&limit=1")
        val columns = body["columns"]
        val orderId = columns.first { it["name"].asText() == "order_id" }
        assertEquals("fk", orderId["key"].asText())
        assertEquals("orders", orderId["references"]["table"].asText())
        assertEquals("public", orderId["references"]["schema"].asText())
    }

    @Test
    fun `same-schema fk reference omits the schema field`() {
        val body = getJson("/api/tables/data?table=orders&limit=1")
        val userId = body["columns"].first { it["name"].asText() == "user_id" }
        assertFalse(userId["references"].has("schema"))
    }

    @Test
    fun `every schemas response carries the protocol version header`() {
        val response = http.getForEntity(url("/api/schemas"), String::class.java)
        assertEquals("1", response.headers.getFirst("x-ashurbanipal-protocol"))
    }
}
