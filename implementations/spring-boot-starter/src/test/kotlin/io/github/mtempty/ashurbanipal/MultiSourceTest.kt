package io.github.mtempty.ashurbanipal

import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
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
 * Boots the starter with two named `ashurbanipal.sources` entries — both
 * left without a `dataSourceBean`, so both resolve to the same primary
 * `DataSource` bean (`AshurbanipalAutoConfiguration.ashurbanipalDbSources`);
 * this test only cares about `source`-param routing, not distinct backing
 * stores. Same harness shape as
 * `AshurbanipalIntegrationTest`/`SchemaIsolationTest`'s "unrecognized value
 * rejected cleanly" coverage, applied to `source` instead of `schema`.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    classes = [MultiSourceTest.TestApp::class],
)
class MultiSourceTest {

    // See AshurbanipalIntegrationTest.TestApp for why scanBasePackages points
    // at an empty package: avoids a second, component-scanned
    // DbViewerController bean colliding with AshurbanipalAutoConfiguration's.
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
            registry.add("ashurbanipal.sources[0].name") { "alpha" }
            registry.add("ashurbanipal.sources[1].name") { "beta" }
        }
    }

    @LocalServerPort
    private var port: Int = 0

    private val http = RestTemplate()
    private val mapper = ObjectMapper()

    private fun url(path: String) = "http://localhost:$port/__ashurbanipal$path"

    private fun getJson(path: String): JsonNode = mapper.readTree(http.getForObject(url(path), String::class.java))

    @Test
    fun `api sources lists the registered names in config order`() {
        val body = getJson("/api/sources")
        val names = (body["sources"] as Iterable<JsonNode>).map { it["name"].asText() }
        assertEquals(listOf("alpha", "beta"), names)
    }

    @Test
    fun `unrecognized source is rejected with 400 on a source-aware route`() {
        for (path in listOf(
            "/api/schemas?source=nonexistent",
            "/api/tables?source=nonexistent",
            "/api/table-counts?source=nonexistent",
            "/api/tables/data?source=nonexistent&table=users",
            "/api/tables/common-values?source=nonexistent&table=users&column=email",
        )) {
            val ex = assertThrows(HttpClientErrorException::class.java) {
                http.getForObject(url(path), String::class.java)
            }
            assertEquals(HttpStatus.BAD_REQUEST, ex.statusCode, path)
        }
    }

    @Test
    fun `omitting source resolves to the first-registered one`() {
        assertEquals(getJson("/api/tables"), getJson("/api/tables?source=alpha"))
    }
}
