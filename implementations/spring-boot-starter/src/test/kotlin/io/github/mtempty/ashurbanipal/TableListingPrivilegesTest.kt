package io.github.mtempty.ashurbanipal

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.net.URI
import java.sql.Connection
import java.sql.DriverManager
import java.sql.SQLException
import java.sql.SQLFeatureNotSupportedException
import javax.sql.DataSource

private const val SCHEMA = "ashb_test_table_privileges"
private const val ROLE = "ashb_test_table_privileges_role"

private fun jdbcCredentials(): Triple<String, String, String> {
    val databaseUrl = System.getenv("DATABASE_URL")
        ?: error("DATABASE_URL must be set (the devcontainer sets it automatically)")
    val uri = URI(databaseUrl)
    val (user, password) = (uri.userInfo ?: ":").split(":", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
    return Triple("jdbc:postgresql://${uri.host}:${uri.port}${uri.path}", user, password)
}

/** Every connection runs as [ROLE] — USAGE on [SCHEMA] but SELECT on only one of its tables. */
private class SetRoleDataSource(
    private val jdbcUrl: String,
    private val user: String,
    private val password: String,
) : DataSource {
    override fun getConnection(): Connection {
        val conn = DriverManager.getConnection(jdbcUrl, user, password)
        conn.createStatement().use { it.execute("set role $ROLE") }
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
 * The table listing, the counts, and the `table` allow-list must all
 * exclude tables the connected role can't `SELECT` (spec/protocol.md
 * §5.2), and an `INSERT`-only table must come back as a clean
 * `NotAllowedException`, never a raw `permission denied` 500 — Kotlin
 * equivalent of `implementations/rust/axum/tests/table_listing_privileges.rs`.
 */
class TableListingPrivilegesTest {
    @Test
    fun `listing and allow-list exclude non-selectable tables`() {
        val (jdbcUrl, user, password) = jdbcCredentials()

        HikariDataSource(
            HikariConfig().apply {
                this.jdbcUrl = jdbcUrl
                username = user
                this.password = password
                maximumPoolSize = 1
                poolName = "table-privileges-setup"
            },
        ).use { setupDs ->
            setupDs.connection.use { conn ->
                conn.createStatement().use { st ->
                    st.execute("drop schema if exists $SCHEMA cascade")
                    st.execute("drop role if exists $ROLE")
                    st.execute("create role $ROLE nosuperuser")
                    // Lets this session `set role` to it in SetRoleDataSource.
                    st.execute("grant $ROLE to current_user")
                    st.execute("create schema $SCHEMA")
                    st.execute("grant usage on schema $SCHEMA to $ROLE")
                    st.execute("create table $SCHEMA.readable (id int primary key, name text)")
                    st.execute("insert into $SCHEMA.readable values (1, 'a'), (2, 'b')")
                    st.execute("create table $SCHEMA.write_only (id int primary key)")
                    st.execute("create table $SCHEMA.no_grant (id int primary key)")
                    st.execute("grant select on $SCHEMA.readable to $ROLE")
                    st.execute("grant insert on $SCHEMA.write_only to $ROLE")
                }
            }

            try {
                val source = PostgresSource(SetRoleDataSource(jdbcUrl, user, password), 5, FilterValidator())
                val opts = QueryOpts(limit = 10, offset = 0, sort = null, descending = false, filter = null)

                assertEquals(
                    listOf("readable"),
                    source.listTables(SCHEMA).map { it.name },
                    "listTables must omit write_only (INSERT only) and no_grant (no privilege)",
                )
                assertEquals(
                    listOf("readable"),
                    source.tableCounts(SCHEMA).map { it.table },
                    "tableCounts must track the same set as listTables",
                )

                source.queryTable(SCHEMA, "readable", opts)

                assertThrows<NotAllowedException>("an INSERT-only table must be rejected, not reach a permission-denied 500") {
                    source.queryTable(SCHEMA, "write_only", opts)
                }
                assertThrows<NotAllowedException>("a table the role has no privilege on must be rejected") {
                    source.queryTable(SCHEMA, "no_grant", opts)
                }
            } finally {
                setupDs.connection.use { conn ->
                    conn.createStatement().use { st ->
                        st.execute("drop schema if exists $SCHEMA cascade")
                        st.execute("drop role if exists $ROLE")
                    }
                }
            }
        }
    }
}
