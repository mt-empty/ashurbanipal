package io.github.mtempty.ashurbanipal

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.springframework.http.HttpStatus
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.web.client.HttpClientErrorException
import tools.jackson.databind.JsonNode

/**
 * Boots the starter with two named `ashurbanipal.sources` entries — both
 * left without a `dataSourceBean`, so both resolve to the same primary
 * `DataSource` bean (`AshurbanipalAutoConfiguration.ashurbanipalDbSources`);
 * this test only cares about `source`-param routing, not distinct backing
 * stores. Same harness shape as `AshurbanipalIntegrationTest`'s
 * "unrecognized value rejected cleanly" coverage, applied to `source`
 * instead of `schema`.
 */
class MultiSourceTest : AshurbanipalHttpTestBase() {

    companion object {
        // Layers onto AshurbanipalHttpTestBase.baseProperties — Spring
        // collects @DynamicPropertySource methods from the whole class
        // hierarchy, so this only needs the properties this test adds.
        @JvmStatic
        @DynamicPropertySource
        fun sourceProperties(registry: DynamicPropertyRegistry) {
            registry.add("ashurbanipal.sources[0].name") { "alpha" }
            registry.add("ashurbanipal.sources[1].name") { "beta" }
        }
    }

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
