package io.github.mtempty.ashurbanipal

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.net.URI
import java.sql.DriverManager
import java.sql.Statement
import kotlin.system.measureTimeMillis

/**
 * `GET /api/tables/join` (`spec/protocol.md` §5.11) against Postgres catalog
 * types the conformance seed cannot vary: enum identity, arrays, and the
 * timeout label. One schema per test so JUnit's method order cannot make two
 * of them race over one `create schema`.
 */
class JoinIntegrationTest {
    private val databaseUrl = System.getenv("DATABASE_URL")
    private val uri get() = URI(databaseUrl)
    private val credentials get() = (uri.userInfo ?: ":").split(":", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
    private val jdbcUrl get() = "jdbc:postgresql://${uri.host}:${uri.port}${uri.path}"

    private fun withAdminConnection(block: (Statement) -> Unit) {
        org.junit.jupiter.api.Assumptions.assumeTrue(!databaseUrl.isNullOrBlank(), "DATABASE_URL not set")
        DriverManager.getConnection(jdbcUrl, credentials.first, credentials.second).use { conn ->
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

    private fun source(timeoutSecs: Int): Pair<PostgresSource, HikariDataSource> {
        // Local vals: inside `apply`, `credentials`/`jdbcUrl` would resolve to HikariConfig's own members.
        val url = jdbcUrl
        val (user, pass) = credentials
        val ds = HikariDataSource(
            HikariConfig().apply {
                jdbcUrl = url
                username = user
                password = pass
                maximumPoolSize = 2
                poolName = "join-it-${System.nanoTime()}"
            },
        )
        return PostgresSource(ds, timeoutSecs, FilterValidator()) to ds
    }

    private fun pair(left: String, leftCol: String, right: String, rightCol: String) = parseJoin(
        """{"table":"$left","joins":[{"type":"inner","table":"$right",
            "on":[{"left":{"join":0,"column":"$leftCol"},"right":"$rightCol"}]}]}""",
    )

    private val opts = JoinOpts(10, 0, null, null, false, null)

    @Test
    fun `enums pair only within one type and arrays never join`() {
        val s = "ashb_test_spring_join_types"
        withSchema(
            s,
            "create type $s.mood as enum ('ok', 'sad')",
            "create type $s.size as enum ('s', 'm')",
            "create table $s.a (id int primary key, m $s.mood, z $s.size, tags text[], n numeric)",
            "create table $s.b (id int primary key, m $s.mood, z $s.size, tags text[], n bigint)",
            "insert into $s.a values (1, 'ok', 's', '{x}', 1.0)",
            "insert into $s.b values (1, 'ok', 's', '{x}', 1)",
        ) {
            val (source, ds) = source(5)
            ds.use {
                assertEquals(1, source.queryJoin(s, pair("a", "m", "b", "m"), opts).rows.size)
                assertThrows(BadJoinException::class.java) { source.queryJoin(s, pair("a", "m", "b", "z"), opts) }
                assertThrows(BadJoinException::class.java) { source.queryJoin(s, pair("a", "tags", "b", "tags"), opts) }
                assertEquals(1, source.queryJoin(s, pair("a", "n", "b", "n"), opts).rows.size)
            }
        }
    }

    // Postgres rejects a comparison of two different explicit collations, while
    // the default collation yields to an explicit one; the metadata reports only
    // the explicit ones.
    @Test
    fun `text columns with clashing collations do not join`() {
        val s = "ashb_test_spring_join_collation"
        withSchema(
            s,
            "create table $s.a (id int primary key, c text collate \"C\", p text collate \"POSIX\", d text)",
            "create table $s.b (id int primary key, c text collate \"C\", p text collate \"C\", d text)",
            "insert into $s.a values (1, 'x', 'x', 'x')",
            "insert into $s.b values (1, 'x', 'x', 'x')",
        ) {
            val (source, ds) = source(5)
            ds.use {
                val table = source.queryTable(s, "a", QueryOpts(10, 0, null, false, null))
                assertEquals(listOf(null, "C", "POSIX", null), table.columns.map { it.collation })
                for ((left, right) in listOf("c" to "c", "c" to "d", "d" to "c", "d" to "d")) {
                    assertEquals(1, source.queryJoin(s, pair("a", left, "b", right), opts).rows.size, "$left to $right")
                }
                val clash = assertThrows(BadJoinException::class.java) { source.queryJoin(s, pair("a", "p", "b", "p"), opts) }
                assertTrue(clash.message!!.contains("different text collations"), clash.message)
            }
        }
    }

    // A json, xml or geometric column has no ordering operator, so a sort on it
    // is a 400 unsortable_column, not a 500; jsonb sorts, and a domain over it
    // reports the json class.
    @Test
    fun `sorting an unorderable column is a client error`() {
        val s = "ashb_test_spring_join_sort"
        withSchema(
            s,
            "create domain $s.settings as jsonb",
            "create table $s.a (id int primary key, doc json, bag jsonb, dom $s.settings)",
            "create table $s.b (id int primary key)",
            "insert into $s.a values (1, '{}', '{}', '{}'), (2, '[]', '[]', '[]')",
            "insert into $s.b values (1)",
        ) {
            val (source, ds) = source(5)
            ds.use {
                fun page(sort: String? = null) = QueryOpts(10, 0, sort, false, null)
                val tableErr = assertThrows(UnsortableException::class.java) { source.queryTable(s, "a", page("doc")) }
                assertEquals("cannot sort by doc: its type has no ordering", tableErr.message)
                assertThrows(UnsortableException::class.java) {
                    source.queryJoin(s, pair("a", "id", "b", "id"), opts.copy(sort = "doc", sortJoin = 0))
                }
                for (column in listOf("bag", "dom", "id")) source.queryTable(s, "a", page(column))
                assertEquals("json", source.queryTable(s, "a", page()).columns[3].columnClass)
            }
        }
    }

    @Test
    fun `a slow join is a query timeout and releases the connection`() {
        val s = "ashb_test_spring_join_slow"
        withSchema(
            s,
            "create table $s.a as select g as id, g % 2 as k from generate_series(1, 20000) g",
            "create table $s.b as select g as id, g % 2 as k from generate_series(1, 20000) g",
        ) {
            val (source, ds) = source(1)
            ds.use {
                var timedOut = false
                val elapsedMs = measureTimeMillis {
                    try {
                        source.queryJoin(s, pair("a", "k", "b", "k"), opts.copy(sort = "id", descending = true))
                    } catch (e: Exception) {
                        timedOut = isQueryTimeout(e)
                    }
                }
                assertTrue(timedOut, "expected the join to be stopped by the query timeout")
                assertTrue(elapsedMs < 5_000, "took ${elapsedMs}ms")

                val ok = source.queryJoin(s, pair("a", "id", "b", "id"), opts)
                assertEquals(10, ok.rows.size)
                assertTrue(ok.hasMore)
            }
        }
    }
}
