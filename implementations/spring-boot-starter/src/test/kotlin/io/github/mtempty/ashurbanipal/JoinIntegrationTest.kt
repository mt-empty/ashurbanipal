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
