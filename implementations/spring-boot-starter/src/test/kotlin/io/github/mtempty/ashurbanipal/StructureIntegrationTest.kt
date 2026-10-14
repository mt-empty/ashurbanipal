package io.github.mtempty.ashurbanipal

import tools.jackson.databind.JsonNode
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.http.HttpStatus
import org.springframework.web.client.HttpClientErrorException
import java.net.URI
import java.sql.DriverManager
import java.sql.Statement

/**
 * `GET /api/tables/structure` (`spec/protocol.md` §5.10) against Postgres
 * catalog quirks: partitioned tables (parent rejected, child reports its own
 * copies) and index shapes (`INCLUDE` columns, expression entries). Each
 * test uses its own schema so JUnit's method order cannot make two of them
 * race over one `create schema`.
 */
class StructureIntegrationTest : AshurbanipalHttpTestBase() {

    private fun withAdminConnection(block: (Statement) -> Unit) {
        val databaseUrl = System.getenv("DATABASE_URL")
            ?: error("DATABASE_URL must be set (the devcontainer sets it automatically)")
        val uri = URI(databaseUrl)
        val (user, password) = (uri.userInfo ?: ":").split(":", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
        DriverManager.getConnection("jdbc:postgresql://${uri.host}:${uri.port}${uri.path}", user, password).use { conn ->
            conn.createStatement().use(block)
        }
    }

    private fun withSchema(schema: String, vararg ddl: String, block: () -> Unit) {
        withAdminConnection { st ->
            st.execute("drop schema if exists $schema cascade")
            st.execute("create schema $schema")
            ddl.forEach { st.execute(it) }
        }
        try {
            block()
        } finally {
            withAdminConnection { it.execute("drop schema if exists $schema cascade") }
        }
    }

    @Test
    fun `rejects a partitioned parent and a child reports its own inherited copies`() {
        val s = "ashb_test_spring_structure_partitions"
        withSchema(
            s,
            "create table $s.users (id int primary key)",
            "create table $s.events (id bigint not null, user_id int references $s.users(id)) partition by range (id)",
            "create index events_user_idx on $s.events (user_id)",
            "create table $s.events_p1 partition of $s.events for values from (1) to (1000)",
        ) {
            val ex = assertThrows(HttpClientErrorException::class.java) {
                http.getForObject(URI(url("/api/tables/structure?schema=$s&table=events")), String::class.java)
            }
            assertEquals(HttpStatus.BAD_REQUEST, ex.statusCode)

            val body = getJson("/api/tables/structure?schema=$s&table=events_p1")
            val indexes = body["indexes"] as Iterable<JsonNode>
            assertTrue(indexes.any { it["columns"].size() == 1 && it["columns"][0].asText() == "user_id" }, "$body")
            val fks = body["constraints"]["foreign_keys"]
            assertEquals(1, fks.size())
            assertEquals("users", fks[0]["table"].asText())
        }
    }

    @Test
    fun `reports a FK to a partitioned table once, not per referenced partition`() {
        val s = "ashb_test_spring_structure_fk_to_partitioned"
        withSchema(
            s,
            "create table $s.events (id int primary key) partition by range (id)",
            "create table $s.events_p1 partition of $s.events for values from (0) to (100)",
            "create table $s.events_p2 partition of $s.events for values from (100) to (200)",
            "create table $s.orders (id int primary key, event_id int, " +
                "constraint orders_event_fk foreign key (event_id) references $s.events(id))",
        ) {
            val fks = getJson("/api/tables/structure?schema=$s&table=orders")["constraints"]["foreign_keys"]
            assertEquals(1, fks.size(), "$fks")
            assertEquals("orders_event_fk", fks[0]["name"].asText())
            assertEquals("events", fks[0]["table"].asText())
        }
    }

    @Test
    fun `index columns exclude INCLUDE columns and keep expression entries in position`() {
        val s = "ashb_test_spring_structure_indexes"
        withSchema(
            s,
            "create table $s.items (id int primary key, email text, a int, b int, status text)",
            "create index items_cover_idx on $s.items (a) include (b)",
            "create index items_expr_only_idx on $s.items (lower(email))",
            "create index items_mixed_idx on $s.items (lower(email), a)",
            "create index items_partial_idx on $s.items (a) where status = 'open'",
        ) {
            val body = getJson("/api/tables/structure?schema=$s&table=items")
            val byName = (body["indexes"] as Iterable<JsonNode>).associateBy { it["name"].asText() }
            fun cols(name: String) = (byName.getValue(name)["columns"] as Iterable<JsonNode>).map { it.asText() }

            assertEquals(listOf("a"), cols("items_cover_idx"))
            assertEquals(1, cols("items_expr_only_idx").size)
            assertTrue(cols("items_expr_only_idx")[0].contains("lower"))
            val mixed = cols("items_mixed_idx")
            assertEquals(2, mixed.size)
            assertTrue(mixed[0].contains("lower") && mixed[1] == "a", "$mixed")
            assertTrue(byName.getValue("items_partial_idx")["predicate"].asText().contains("open"))
            assertNull(byName.getValue("items_cover_idx")["predicate"], "a non-partial index must omit predicate")
        }
    }

    @Test
    fun `reports the seed's composite FK and non-default FK action`() {
        val counts = getJson("/api/tables/structure?table=inventory_counts")["constraints"]["foreign_keys"]
        val composite = (counts as Iterable<JsonNode>).first { it["columns"].size() == 2 }
        assertEquals("inventory_locations", composite["table"].asText())

        val orders = getJson("/api/tables/structure?table=orders")["constraints"]["foreign_keys"]
        assertEquals("CASCADE", orders[0]["on_delete"].asText())
    }

    @Test
    fun `unknown table, schema and source are rejected and the header rides the response`() {
        for (suffix in listOf("?table=no_such_table", "?schema=no_such_schema&table=users", "?source=nope&table=users", "")) {
            val ex = assertThrows(HttpClientErrorException::class.java) {
                http.getForObject(URI(url("/api/tables/structure") + suffix), String::class.java)
            }
            assertEquals(HttpStatus.BAD_REQUEST, ex.statusCode, suffix)
            assertEquals("1", ex.responseHeaders?.getFirst("x-ashurbanipal-protocol"))
        }
        val ok = http.getForEntity(url("/api/tables/structure?table=users"), String::class.java)
        assertEquals("1", ok.headers.getFirst("x-ashurbanipal-protocol"))
    }
}
