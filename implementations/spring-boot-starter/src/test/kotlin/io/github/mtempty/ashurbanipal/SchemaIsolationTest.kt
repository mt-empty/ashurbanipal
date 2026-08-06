package io.github.mtempty.ashurbanipal

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.fail
import org.junit.jupiter.api.Test
import java.net.URI
import java.sql.Connection
import java.sql.DriverManager
import java.sql.SQLException
import java.sql.SQLFeatureNotSupportedException
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import javax.sql.DataSource

private const val SCHEMA_A = "ashb_test_schema_isolation_a"
private const val SCHEMA_B = "ashb_test_schema_isolation_b"

private fun jdbcCredentials(): Triple<String, String, String> {
    val databaseUrl = System.getenv("DATABASE_URL")
        ?: error("DATABASE_URL must be set (the devcontainer sets it automatically)")
    val uri = URI(databaseUrl)
    val (user, password) = (uri.userInfo ?: ":").split(":", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
    return Triple("jdbc:postgresql://${uri.host}:${uri.port}${uri.path}", user, password)
}

/** Backs a HikariCP pool but alternates each newly-created physical connection's search_path between two schemas, simulating a host pool whose sessions don't all agree on which schema current_schema() resolves to. Hikari calls getConnection() exactly once per physical connection it creates, so the SET here — unlike a per-borrow hook — runs once and then stays pinned for that connection's lifetime in the pool, matching what a real divergent-search_path pool would look like. */
private class AlternatingSchemaDataSource(
    private val jdbcUrl: String,
    private val user: String,
    private val password: String,
) : DataSource {
    private val connectionCount = AtomicInteger(0)

    override fun getConnection(): Connection {
        val conn = DriverManager.getConnection(jdbcUrl, user, password)
        val n = connectionCount.getAndIncrement()
        val schema = if (n % 2 == 0) SCHEMA_A else SCHEMA_B
        conn.createStatement().use { it.execute("set search_path = $schema") }
        return conn
    }

    override fun getConnection(username: String?, password: String?): Connection = getConnection()
    override fun getLogWriter(): java.io.PrintWriter? = null
    override fun setLogWriter(out: java.io.PrintWriter?) {}
    override fun setLoginTimeout(seconds: Int) {}
    override fun getLoginTimeout(): Int = 0
    override fun getParentLogger() = throw SQLFeatureNotSupportedException()
    override fun <T : Any?> unwrap(iface: Class<T>?): T = throw SQLException("not a wrapper")
    override fun isWrapperFor(iface: Class<*>?): Boolean = false
}

/**
 * Regression test for the "connection pool sessions with different
 * search_path settings must not let a request's schema resolution drift
 * mid-flight" guarantee — Kotlin equivalent of
 * `implementations/rust/tests/schema_isolation.rs`'s
 * `query_table_never_mixes_schemas_across_pooled_connections`.
 *
 * Runs directly against [Catalog] (like [CatalogTest], not the full Spring
 * app [AshurbanipalIntegrationTest] boots) so the pool under test can be
 * built by hand. [Catalog.queryTable] resolves+validates the schema and
 * later selects columns from it inside one [Catalog.inReadOnlyTransaction]
 * — pinned to one physical connection, per [Catalog.resolveSchema]'s doc
 * comment — so if those steps could ever land on different pooled
 * connections, a response would mix shapes/values across schemas or fail
 * outright.
 */
class SchemaIsolationTest {
    @Test
    fun `query_table never mixes schemas across pooled connections`() {
        val (jdbcUrl, user, password) = jdbcCredentials()

        HikariDataSource(
            HikariConfig().apply {
                this.jdbcUrl = jdbcUrl
                username = user
                this.password = password
                maximumPoolSize = 1
                poolName = "schema-isolation-setup"
            },
        ).use { setupDs ->
            setupDs.connection.use { conn ->
                conn.createStatement().use { st ->
                    for (schema in listOf(SCHEMA_A, SCHEMA_B)) {
                        st.execute("drop schema if exists $schema cascade")
                        st.execute("create schema $schema")
                    }
                    st.execute("create table $SCHEMA_A.probe_isolation (id int primary key, marker text)")
                    st.execute("insert into $SCHEMA_A.probe_isolation values (1, 'A'), (2, 'A')")
                    st.execute("create table $SCHEMA_B.probe_isolation (id int primary key, marker text, extra text)")
                    st.execute("insert into $SCHEMA_B.probe_isolation values (1, 'B', 'X'), (2, 'B', 'X')")
                }
            }

            try {
                HikariDataSource(
                    HikariConfig().apply {
                        dataSource = AlternatingSchemaDataSource(jdbcUrl, user, password)
                        minimumIdle = 2
                        maximumPoolSize = 2
                        poolName = "schema-isolation-under-test"
                    },
                ).use { poolDs ->
                    // Acquire both connections while both are still checked
                    // out (neither idle yet), forcing Hikari to open two
                    // distinct physical connections; only then release them
                    // both back to the idle set, so both schemas are
                    // represented once the concurrent calls below begin.
                    val c1 = poolDs.connection
                    val c2 = poolDs.connection
                    c1.close()
                    c2.close()

                    val catalog = Catalog(poolDs, 5, FilterValidator())
                    val opts = QueryOpts(limit = 10, offset = 0, sort = null, descending = false, filter = null)

                    val executor = Executors.newFixedThreadPool(8)
                    try {
                        val futures = (1..40).map {
                            executor.submit<TableData> { catalog.queryTable(null, "probe_isolation", opts) }
                        }
                        for (future in futures) {
                            val data = future.get()
                            val names = data.columns.map { it.name }
                            when (names) {
                                listOf("id", "marker") -> for (row in data.rows) {
                                    assertEquals("A", row["marker"], "schema_a shape must only ever contain schema_a's rows")
                                }
                                listOf("id", "marker", "extra") -> for (row in data.rows) {
                                    assertEquals("B", row["marker"], "schema_b shape must only ever contain schema_b's rows")
                                    assertEquals("X", row["extra"])
                                }
                                else -> fail<Unit>("response mixed columns from both schemas — mid-request schema drift: $names")
                            }
                        }
                    } finally {
                        executor.shutdown()
                    }
                }
            } finally {
                setupDs.connection.use { conn ->
                    conn.createStatement().use { st ->
                        for (schema in listOf(SCHEMA_A, SCHEMA_B)) {
                            st.execute("drop schema if exists $schema cascade")
                        }
                    }
                }
            }
        }
    }
}
