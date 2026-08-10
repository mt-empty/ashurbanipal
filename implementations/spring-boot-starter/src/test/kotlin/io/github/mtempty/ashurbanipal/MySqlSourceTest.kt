package io.github.mtempty.ashurbanipal

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.net.URI
import java.sql.DriverManager
import java.util.concurrent.atomic.AtomicLong
import kotlin.system.measureTimeMillis

/**
 * Port of `implementations/rust/src/db/mysql.rs`'s test suite. Runs against
 * whichever of `MYSQL_TEST_URL`/`MARIADB_TEST_URL` is set (the devcontainer's
 * `mysql`/`mariadb` services) — each test method is parameterized so both
 * forks get the same coverage, including the fork-specific timeout SQL
 * branch (`docs/adapter-decisions.md` §6). Skips cleanly (JUnit5
 * `@EnabledIfEnvironmentVariable`) rather than failing when neither is
 * reachable, matching `implementations/rust/src/db/mysql.rs`'s tests.
 */
class MySqlSourceTest {
    companion object {
        private val counter = AtomicLong(0)
    }

    private fun jdbcUrlFor(envVar: String): String {
        val raw = System.getenv(envVar) ?: error("$envVar must be set to run this test")
        val uri = URI(raw)
        return "jdbc:mysql://${uri.host}:${uri.port}"
    }

    private fun credentialsFor(envVar: String): Pair<String, String> {
        val raw = System.getenv(envVar)!!
        val userInfo = URI(raw).userInfo ?: ":"
        val parts = userInfo.split(":", limit = 2)
        return parts[0] to parts.getOrElse(1) { "" }
    }

    /** Each test gets its own throwaway database — MySQL has no `sqlite::memory:`-style disposable instance. */
    private inner class SeededDb(envVar: String) : AutoCloseable {
        val name: String
        val dataSource: HikariDataSource
        private val adminUrl: String
        private val dbUser: String
        private val dbPassword: String

        init {
            adminUrl = jdbcUrlFor(envVar)
            val (u, p) = credentialsFor(envVar)
            dbUser = u
            dbPassword = p
            val nanos = System.nanoTime()
            name = "ashurbanipal_test_${nanos}_${counter.getAndIncrement()}"
            DriverManager.getConnection(adminUrl, dbUser, dbPassword).use { conn ->
                conn.createStatement().use { it.execute("create database `$name`") }
            }
            // Local vals, not the outer dbUser/dbPassword directly: inside
            // `apply`, an unqualified reference to a name that's also a
            // HikariConfig property (like `password`) resolves to the
            // receiver's own field, not the enclosing scope — silently
            // reading it back as null instead of assigning it.
            val u2 = dbUser
            val p2 = dbPassword
            dataSource = HikariDataSource(
                HikariConfig().apply {
                    jdbcUrl = "$adminUrl/$name"
                    username = u2
                    password = p2
                    maximumPoolSize = 4
                    poolName = "mysql-source-test-$name"
                },
            )
            dataSource.connection.use { conn ->
                conn.createStatement().use { st ->
                    st.execute(
                        "create table users (" +
                            "id integer primary key auto_increment, email varchar(255) not null, age integer)",
                    )
                    st.execute(
                        "create table orders (" +
                            "id integer primary key auto_increment, user_id integer, status varchar(50) not null, " +
                            "constraint fk_orders_user foreign key (user_id) references users(id))",
                    )
                    st.execute(
                        "create table order_extra (" +
                            "order_id integer primary key, gift_message varchar(255), " +
                            "constraint fk_order_extra_order foreign key (order_id) references orders(id))",
                    )
                    st.execute("insert into users (email, age) values ('a@x.com', 30), ('b@x.com', 30), ('c@x.com', 40)")
                    st.execute("insert into orders (user_id, status) values (1, 'open')")
                    st.execute("insert into order_extra (order_id, gift_message) values (1, 'enjoy!')")
                }
            }
        }

        override fun close() {
            dataSource.close()
            DriverManager.getConnection(adminUrl, dbUser, dbPassword).use { conn ->
                conn.createStatement().use { it.execute("drop database `$name`") }
            }
        }
    }

    private fun forEachReachableInstance(block: (envVar: String) -> Unit) {
        var ranAny = false
        for (envVar in listOf("MYSQL_TEST_URL", "MARIADB_TEST_URL")) {
            // The Gradle `Test` task forwards these as "" rather than unset
            // when the outer process doesn't have them (build.gradle.kts) —
            // blank must be treated the same as absent.
            if (!System.getenv(envVar).isNullOrBlank()) {
                ranAny = true
                block(envVar)
            }
        }
        org.junit.jupiter.api.Assumptions.assumeTrue(ranAny, "neither MYSQL_TEST_URL nor MARIADB_TEST_URL is set")
    }

    /**
     * `database()` returns SQL NULL for a connection with no default
     * database — `resolveSchema` must surface a clear error rather than
     * `getString`'s platform-typed null silently reaching the "not
     * allowed: schema $resolved" message as the literal string "null".
     */
    @Test
    fun `resolving the default schema with no default database gives a clear error`() = forEachReachableInstance { envVar ->
        val (u, p) = credentialsFor(envVar)
        val ds = HikariDataSource(
            HikariConfig().apply {
                jdbcUrl = jdbcUrlFor(envVar)
                username = u
                password = p
                maximumPoolSize = 2
                poolName = "mysql-source-test-no-default-db-${System.nanoTime()}"
            },
        )
        try {
            val source = MySqlSource(ds, 5)
            val ex = assertThrows(NotAllowedException::class.java) { source.listTables(null) }
            assertTrue(
                ex.message?.contains("no default database") == true,
                "[$envVar] expected a clear no-default-database message, got: ${ex.message}",
            )
        } finally {
            ds.close()
        }
    }

    @Test
    fun `list tables and query table round trip against every reachable instance`() = forEachReachableInstance { envVar ->
        SeededDb(envVar).use { db ->
            val source = MySqlSource(db.dataSource, 5)

            val tables = source.listTables(null)
            // Set, not List: MariaDB's default collation sorts "order_extra" after
            // "orders" (underscore outweighs letters), unlike MySQL/Postgres/SQLite —
            // exact cross-collation ordering isn't a guarantee this project makes.
            assertEquals(setOf("order_extra", "orders", "users"), tables.map { it.name }.toSet(), "[$envVar]")
            assertTrue(tables.all { it.comment == null }, "[$envVar]")

            assertThrows(NotAllowedException::class.java) { source.listTables("no_such_schema") }

            val data = source.queryTable(null, "users", QueryOpts(10, 0, "age", false, null))
            assertEquals(3, data.rows.size, "[$envVar]")
            assertEquals("pk", data.columns.find { it.name == "id" }?.key, "[$envVar]")
        }
    }

    /** MySQL's plain `LIKE` case-sensitivity depends on collation, so `ILIKE` is wrapped in `LOWER(...)` rather than a bare keyword swap (`docs/adapter-decisions.md` §5.4.2) — verified against a real instance since collation behavior can't be assumed from documentation alone. */
    @Test
    fun `ILIKE filter matches case-insensitively`() = forEachReachableInstance { envVar ->
        SeededDb(envVar).use { db ->
            val source = MySqlSource(db.dataSource, 5)
            val data = source.queryTable(
                null,
                "users",
                QueryOpts(10, 0, null, false, listOf(Condition(column = "email", op = "ILIKE", value = "A@X.COM"))),
            )
            assertEquals(1, data.rows.size, "[$envVar]")
            assertEquals("a@x.com", data.rows.first()["email"], "[$envVar]")
        }
    }

    @Test
    fun `AND-combined filter conditions narrow the result`() = forEachReachableInstance { envVar ->
        SeededDb(envVar).use { db ->
            val source = MySqlSource(db.dataSource, 5)
            val data = source.queryTable(
                null,
                "users",
                QueryOpts(
                    10,
                    0,
                    null,
                    false,
                    listOf(
                        Condition(column = "age", op = "=", value = "30"),
                        Condition(logic = "AND", column = "email", op = "=", value = "b@x.com"),
                    ),
                ),
            )
            assertEquals(1, data.rows.size, "[$envVar]")
            assertEquals("b@x.com", data.rows.first()["email"], "[$envVar]")
        }
    }

    @Test
    fun `foreign key column reports key and references`() = forEachReachableInstance { envVar ->
        SeededDb(envVar).use { db ->
            val source = MySqlSource(db.dataSource, 5)
            val data = source.queryTable(null, "orders", QueryOpts(10, 0, null, false, null))
            val userIdCol = data.columns.find { it.name == "user_id" }!!
            assertEquals("fk", userIdCol.key, "[$envVar]")
            assertEquals("users", userIdCol.references?.table, "[$envVar]")
            assertEquals("id", userIdCol.references?.column, "[$envVar]")
        }
    }

    @Test
    fun `pk and fk column reports both`() = forEachReachableInstance { envVar ->
        SeededDb(envVar).use { db ->
            val source = MySqlSource(db.dataSource, 5)
            val data = source.queryTable(null, "order_extra", QueryOpts(10, 0, null, false, null))
            val orderIdCol = data.columns.find { it.name == "order_id" }!!
            assertEquals("pk", orderIdCol.key, "[$envVar]")
            assertEquals("orders", orderIdCol.references?.table, "[$envVar]")
            assertEquals("id", orderIdCol.references?.column, "[$envVar]")
        }
    }

    @Test
    fun `table counts reports a real estimate`() = forEachReachableInstance { envVar ->
        SeededDb(envVar).use { db ->
            db.dataSource.connection.use { conn ->
                conn.createStatement().use { it.execute("analyze table users") }
            }
            val source = MySqlSource(db.dataSource, 5)
            val counts = source.tableCounts(null)
            val usersCount = counts.find { it.table == "users" }!!.approxRows
            assertTrue(usersCount >= 0, "[$envVar] expected a real estimate, got the no-estimate sentinel: $usersCount")
        }
    }

    @Test
    fun `common values is always empty`() = forEachReachableInstance { envVar ->
        SeededDb(envVar).use { db ->
            val source = MySqlSource(db.dataSource, 5)
            assertTrue(source.commonValues(null, "users", "age").isEmpty(), "[$envVar]")
            assertThrows(NotAllowedException::class.java) { source.commonValues(null, "users", "nope") }
        }
    }

    /**
     * Empirically proves the fork-specific timeout SQL actually aborts a
     * running query on *each* real instance it's run against — this is the
     * one mechanism PR #26 flagged as needing a real MariaDB instance to
     * catch (the MAX_EXECUTION_TIME-vs-max_statement_time divergence never
     * shows up against MySQL alone). A recursive CTE iterates enough rows
     * that a 1s budget must interrupt it before it finishes counting.
     */
    @Test
    fun `slow query is aborted by the timeout mechanism on every reachable instance`() = forEachReachableInstance { envVar ->
        SeededDb(envVar).use { db ->
            val source = MySqlSource(db.dataSource, 1)
            val variant = source.variant()
            db.dataSource.connection.use { conn ->
                // Both forks cap recursive CTEs by default, independently of
                // the query-timeout mechanism under test here — without
                // raising the cap the CTE finishes in under a millisecond,
                // before the 1s timeout gets a chance to fire, making this a
                // broken test rather than a passing one (it would "pass" for
                // an unrelated reason on either fork).
                val raiseCap = if (variant == Variant.MARIADB) {
                    "set session max_recursive_iterations = 100000000"
                } else {
                    "set session cte_max_recursion_depth = 100000000"
                }
                conn.createStatement().use { it.execute(raiseCap) }

                // Drives MySqlSource's own timedSelect directly — the same
                // fork-branching function query_table uses internally — so
                // this proves the real mechanism, not a hand-copied SQL string.
                val sql = timedSelect(
                    variant,
                    1,
                    "count(*) from (with recursive slow(x) as (" +
                        "select 1 union all select x + 1 from slow where x < 100000000" +
                        ") select x from slow) t",
                )
                var errored = false
                // execute() + getResultSet(), not executeQuery(): Connector/J's
                // executeQuery() rejects MariaDB's `SET STATEMENT ... FOR
                // SELECT` wrapping client-side before the server ever gets a
                // chance to enforce the timeout (see MySqlSource.kt's query()
                // helper, which this test must mirror to exercise the real
                // mechanism rather than tripping over the same JDBC quirk it
                // exists to route around).
                val elapsedMs = measureTimeMillis {
                    try {
                        conn.createStatement().use { st ->
                            st.execute(sql)
                            st.resultSet?.use { it.next() }
                        }
                    } catch (e: Exception) {
                        errored = true
                    }
                }
                assertTrue(errored, "[$envVar] expected the slow query to be interrupted")
                // Generous upper bound: proves this is a real interrupt near
                // the 1s budget, not a lucky fast completion (e.g. the CTE
                // cap silently biting again) nor an unrelated hang.
                assertTrue(elapsedMs < 10_000, "[$envVar] expected abortion near the 1s budget, took ${elapsedMs}ms")

                // The same connection must still be usable afterward — proves
                // the per-statement mechanism is self-resetting.
                val ok = conn.createStatement().use { st ->
                    st.executeQuery("select 1").use { rs -> rs.next(); rs.getInt(1) }
                }
                assertEquals(1, ok, "[$envVar]")
            }
        }
    }
}
