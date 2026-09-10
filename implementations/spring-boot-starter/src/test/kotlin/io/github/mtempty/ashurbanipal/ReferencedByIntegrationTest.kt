package io.github.mtempty.ashurbanipal

import tools.jackson.databind.JsonNode
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.http.HttpStatus
import org.springframework.web.client.HttpClientErrorException
import java.net.URI
import java.net.URLEncoder

/**
 * `GET /api/tables/referenced-by` (`spec/protocol.md` §5.9) against the
 * devcontainer's live Postgres with `conformance/seed/seed.sql`. Mirrors the
 * Rust `P5.9-*` conformance checks (`conformance/runner/referenced_by.rs`):
 * `public.users` is referenced by several tables incl. cross-schema
 * `warehouse.shipment_events`; `inventory_locations` by exactly one composite
 * FK; `feature_flags` by nothing.
 */
class ReferencedByIntegrationTest : AshurbanipalHttpTestBase() {

    private fun referencedBy(table: String): JsonNode =
        getJson("/api/tables/referenced-by?table=$table")["referenced_by"]

    private fun entriesFor(list: JsonNode, table: String): List<JsonNode> =
        (list as Iterable<JsonNode>).filter { it["table"].asText() == table }

    private fun onlyPair(entry: JsonNode): Pair<String, String> {
        assertEquals(1, entry["columns"].size(), "expected a single column pair in $entry")
        val c = entry["columns"].first()
        return c["from"].asText() to c["to"].asText()
    }

    private fun expectBadRequest(pathSuffix: String) {
        val ex = assertThrows(HttpClientErrorException::class.java) {
            http.getForObject(URI(url("/api/tables/referenced-by") + pathSuffix), String::class.java)
        }
        assertEquals(HttpStatus.BAD_REQUEST, ex.statusCode)
        // §5.9: the protocol-version header rides the error response too.
        assertEquals("1", ex.responseHeaders?.getFirst("x-ashurbanipal-protocol"))
    }

    @Test
    fun `lists incoming FK constraints with explicit column pairs`() {
        val list = referencedBy("users")

        val orders = entriesFor(list, "orders")
        assertEquals(1, orders.size)
        assertEquals("user_id" to "id", onlyPair(orders.first()))
        assertTrue(orders.first()["constraint"].asText().isNotEmpty())
        assertFalse(orders.first().has("schema"), "same-schema referrer must omit schema")

        // support_tickets has two separate FKs into users → two entries.
        val tickets = entriesFor(list, "support_tickets")
        assertEquals(2, tickets.size)
        assertEquals(
            setOf("user_id" to "id", "assigned_admin_id" to "id"),
            tickets.map { onlyPair(it) }.toSet(),
        )
        tickets.forEach { assertFalse(it.has("schema")) }

        // (table, constraint) is unique within one response.
        val keys = (list as Iterable<JsonNode>).map { it["table"].asText() to it["constraint"].asText() }
        assertEquals(keys.size, keys.toSet().size, "duplicate (table, constraint) in $list")
    }

    @Test
    fun `composite foreign keys are included with every column pair`() {
        val list = referencedBy("inventory_locations")
        assertEquals(1, list.size(), "inventory_locations has exactly one referrer")
        val entry = list.first()
        assertEquals("inventory_counts", entry["table"].asText())
        val pairs = (entry["columns"] as Iterable<JsonNode>).map { it["from"].asText() to it["to"].asText() }
        assertEquals(
            listOf("warehouse_code" to "warehouse_code", "bin_code" to "bin_code"),
            pairs,
            "column pairs must be in the constraint's own column order",
        )
    }

    @Test
    fun `a table nothing references returns an empty list`() {
        assertEquals(0, referencedBy("feature_flags").size())
    }

    @Test
    fun `cross-schema referrers carry a schema field`() {
        val se = entriesFor(referencedBy("users"), "shipment_events")
        assertEquals(1, se.size)
        assertEquals("warehouse", se.first()["schema"].asText())
        assertEquals("handled_by_user_id" to "id", onlyPair(se.first()))
    }

    @Test
    fun `explicit schema=public matches the implicit default`() {
        assertEquals(
            getJson("/api/tables/referenced-by?table=users"),
            getJson("/api/tables/referenced-by?schema=public&table=users"),
        )
    }

    @Test
    fun `unknown or malicious table values are rejected cleanly`() {
        for (bad in listOf("", "no_such_table", "users\"; drop table users; --", "users' OR '1'='1")) {
            expectBadRequest("?table=" + URLEncoder.encode(bad, "UTF-8"))
        }
        expectBadRequest("") // no table param at all
    }

    @Test
    fun `unknown schema and unknown source are rejected cleanly`() {
        expectBadRequest("?schema=no_such_schema&table=users")
        expectBadRequest("?source=no_such_source&table=users")
    }

    @Test
    fun `the 200 response carries the protocol version header`() {
        val response = http.getForEntity(url("/api/tables/referenced-by?table=users"), String::class.java)
        assertEquals("1", response.headers.getFirst("x-ashurbanipal-protocol"))
    }
}
