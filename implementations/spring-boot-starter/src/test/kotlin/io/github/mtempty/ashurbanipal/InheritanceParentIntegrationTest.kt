package io.github.mtempty.ashurbanipal

import tools.jackson.databind.JsonNode
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Test
import java.net.URI
import java.sql.DriverManager

/**
 * A plain select on a table with inheritance children returns their rows too,
 * so its row estimate, keys and common values must describe those rows.
 */
class InheritanceParentIntegrationTest : AshurbanipalHttpTestBase() {

    private val schema = "ashb_test_spring_inheritance_parent"

    private fun exec(sql: String) {
        val databaseUrl = requireTestEnv("DATABASE_URL")
            ?: error("DATABASE_URL must be set (the devcontainer sets it automatically)")
        val uri = URI(databaseUrl)
        val (user, password) = (uri.userInfo ?: ":").split(":", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
        DriverManager.getConnection("jdbc:postgresql://${uri.host}:${uri.port}${uri.path}", user, password).use { conn ->
            conn.createStatement().use { it.execute(sql.replace("\$s", schema)) }
        }
    }

    private fun totalApprox(): Long = getJson("/api/tables/data?schema=$schema&table=tickets")["total_approx"].asLong()

    private fun counts(): Map<String, Long> =
        (getJson("/api/table-counts?schema=$schema")["counts"] as Iterable<JsonNode>)
            .associate { it["table"].asText() to it["approx_rows"].asLong() }

    private fun commonValues(table: String): Map<String, Double> =
        (getJson("/api/tables/common-values?schema=$schema&table=$table&column=status")["values"] as Iterable<JsonNode>)
            .associate { it["value"].asText() to it["freq"].asDouble() }

    @Test
    fun `an inheritance parent describes its children's rows too`() {
        // Three levels: tickets (30 rows: open/pending/closed), tickets_archive
        // (70: archived/closed) and tickets_purged (20: purged). Ids repeat across
        // them, so the parent's primary key does not hold. Autovacuum is off so
        // each table's statistics change only when the test analyzes it.
        exec(
            "drop schema if exists \$s cascade; create schema \$s; " +
                "create table \$s.tickets (id int primary key, status text not null) with (autovacuum_enabled = false); " +
                "create table \$s.tickets_archive (id int not null, status text not null) with (autovacuum_enabled = false); " +
                "create table \$s.tickets_purged () inherits (\$s.tickets_archive) with (autovacuum_enabled = false); " +
                "create table \$s.lone (id int primary key); " +
                "insert into \$s.tickets " +
                "  select g, (array['open','pending','closed'])[g % 3 + 1] from generate_series(1, 30) g; " +
                "insert into \$s.tickets_archive " +
                "  select g, (array['archived','closed'])[g % 2 + 1] from generate_series(1, 70) g; " +
                "insert into \$s.tickets_purged select g, 'purged' from generate_series(1, 20) g",
        )
        try {
            // The parent is analyzed while it has no children, so it has only its
            // own statistics row; then the archive (and its child) is attached.
            exec("analyze \$s.tickets; alter table \$s.tickets_archive inherit \$s.tickets")
            assertEquals(30L, totalApprox(), "children with no estimate yet add nothing")
            assertEquals(-1L, counts()["tickets_archive"], "no table in its tree has one")
            assertEquals(emptyMap<String, Double>(), commonValues("tickets"), "no with-children statistics row yet")

            exec("analyze \$s.tickets; analyze \$s.tickets_archive; analyze \$s.tickets_purged")
            val page1 = getJson("/api/tables/data?schema=$schema&table=tickets&limit=100")
            val page2 = getJson("/api/tables/data?schema=$schema&table=tickets&limit=100&offset=100")
            assertEquals(120, page1["rows"].size() + page2["rows"].size(), "all three levels' rows")
            val id = (page1["columns"] as Iterable<JsonNode>).first { it["name"].asText() == "id" }
            assertFalse(id.has("key"), "the parent's primary key does not hold over its children's rows")
            val lone = getJson("/api/tables/data?schema=$schema&table=lone")
            assertEquals("pk", lone["columns"][0]["key"].asText())

            assertEquals(120L, totalApprox(), "the estimate sums every descendant")
            assertEquals(
                mapOf("tickets" to 120L, "tickets_archive" to 90L, "tickets_purged" to 20L),
                counts().filterKeys { it.startsWith("tickets") },
            )

            val parent = commonValues("tickets")
            assertEquals(5, parent.size, "every level's values; got $parent")
            assertEquals(0.375, parent.getValue("closed"), 0.001)
            assertEquals(1, commonValues("tickets_purged").size)
        } finally {
            exec("drop schema if exists \$s cascade")
        }
    }
}
