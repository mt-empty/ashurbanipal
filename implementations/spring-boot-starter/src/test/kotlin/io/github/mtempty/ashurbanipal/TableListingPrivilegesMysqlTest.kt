package io.github.mtempty.ashurbanipal

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.net.URI
import java.sql.DriverManager

private const val MYSQL_PRIV_SCHEMA = "ashb_test_table_privileges"
private const val MYSQL_PRIV_USER = "ashb_test_table_privileges_user"
private const val MYSQL_PRIV_PASSWORD = "ashb_test_pw"

/**
 * MySQL/MariaDB equivalent of [TableListingPrivilegesTest]. Neither engine
 * has a `has_table_privilege` function, and no cheap role-aware way to
 * narrow `information_schema.tables` to SELECT-able tables (see
 * `docs/adapter-decisions.md` §5.2/§5.3) — so the listing is NOT gated: an
 * INSERT-only table still shows up. What must hold: a residual
 * `ER_TABLEACCESS_DENIED_ERROR` (1142, both engines) at the row fetch is
 * mapped to a clean [NotAllowedException] (400), never a driver 500.
 */
class TableListingPrivilegesMysqlTest {
    @Test
    fun `residual select-denied maps to NotAllowed on every reachable instance`() {
        var ranAny = false
        for (envVar in listOf("MYSQL_TEST_URL", "MARIADB_TEST_URL")) {
            val raw = System.getenv(envVar)
            if (raw.isNullOrBlank()) continue
            ranAny = true
            runFor(raw, envVar)
        }
        assumeTrue(ranAny, "neither MYSQL_TEST_URL nor MARIADB_TEST_URL is set")
    }

    private fun runFor(rawUrl: String, envVar: String) {
        val uri = URI(rawUrl)
        val adminUrl = "jdbc:mysql://${uri.host}:${uri.port}"
        val (adminUser, adminPassword) = (uri.userInfo ?: ":")
            .split(":", limit = 2).let { it[0] to it.getOrElse(1) { "" } }

        DriverManager.getConnection(adminUrl, adminUser, adminPassword).use { conn ->
            conn.createStatement().use { st ->
                st.execute("drop database if exists $MYSQL_PRIV_SCHEMA")
                st.execute("drop user if exists '$MYSQL_PRIV_USER'@'%'")
                st.execute("create database $MYSQL_PRIV_SCHEMA")
                st.execute("create user '$MYSQL_PRIV_USER'@'%' identified by '$MYSQL_PRIV_PASSWORD'")
                st.execute("create table $MYSQL_PRIV_SCHEMA.readable (id int primary key, name varchar(50))")
                st.execute("insert into $MYSQL_PRIV_SCHEMA.readable values (1, 'a'), (2, 'b')")
                st.execute("create table $MYSQL_PRIV_SCHEMA.write_only (id int primary key)")
                st.execute("create table $MYSQL_PRIV_SCHEMA.no_grant (id int primary key)")
                st.execute("grant select on $MYSQL_PRIV_SCHEMA.readable to '$MYSQL_PRIV_USER'@'%'")
                st.execute("grant insert on $MYSQL_PRIV_SCHEMA.write_only to '$MYSQL_PRIV_USER'@'%'")
            }
        }

        try {
            HikariDataSource(
                HikariConfig().apply {
                    jdbcUrl = "$adminUrl/$MYSQL_PRIV_SCHEMA"
                    username = MYSQL_PRIV_USER
                    password = MYSQL_PRIV_PASSWORD
                    maximumPoolSize = 2
                    poolName = "table-privileges-mysql-${System.nanoTime()}"
                },
            ).use { ds ->
                val source = MySqlSource(ds, 5)
                val opts = QueryOpts(limit = 10, offset = 0, sort = null, descending = false, filter = null)

                val names = source.listTables(MYSQL_PRIV_SCHEMA).map { it.name }
                assertTrue("readable" in names, "[$envVar] $names")
                // Documented gap — if write_only ever stops being listed,
                // update docs/adapter-decisions.md.
                assertTrue("write_only" in names, "[$envVar] INSERT-only table still listed: $names")
                assertTrue("no_grant" !in names, "[$envVar] $names")

                source.queryTable(MYSQL_PRIV_SCHEMA, "readable", opts)

                assertThrows<NotAllowedException>("[$envVar] INSERT-only table must map to NotAllowed, not a 500") {
                    source.queryTable(MYSQL_PRIV_SCHEMA, "write_only", opts)
                }
                assertThrows<NotAllowedException>("[$envVar] table absent from the allow-list must be rejected") {
                    source.queryTable(MYSQL_PRIV_SCHEMA, "no_grant", opts)
                }
            }
        } finally {
            DriverManager.getConnection(adminUrl, adminUser, adminPassword).use { conn ->
                conn.createStatement().use { st ->
                    st.execute("drop database if exists $MYSQL_PRIV_SCHEMA")
                    st.execute("drop user if exists '$MYSQL_PRIV_USER'@'%'")
                }
            }
        }
    }
}
