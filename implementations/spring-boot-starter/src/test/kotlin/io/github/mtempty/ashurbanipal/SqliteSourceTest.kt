package io.github.mtempty.ashurbanipal

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File
import java.sql.DriverManager
import kotlin.system.measureTimeMillis

/**
 * Port of `implementations/rust/src/db/sqlite.rs`'s test suite. Uses a real
 * on-disk file (not `sqlite::memory:`) since the query-timeout test needs a
 * connection Xerial's `sqlite-jdbc` driver can actually interrupt — verified
 * empirically here (a real slow query, timing-based proof of abortion), not
 * just trusted from the JDBC API's documented intent, per PORTING.md's
 * per-backend review bar.
 */
class SqliteSourceTest {
    private val dbFile = File.createTempFile("ashurbanipal-sqlite-test", ".db")

    private fun seededDataSource(): HikariDataSource {
        val jdbcUrl = "jdbc:sqlite:${dbFile.absolutePath}"
        DriverManager.getConnection(jdbcUrl).use { conn ->
            conn.createStatement().use { st ->
                st.execute(
                    "create table users (" +
                        "id integer primary key, email text not null, age integer)",
                )
                st.execute(
                    "create table orders (" +
                        "id integer primary key, user_id integer references users(id), status text not null)",
                )
                st.execute(
                    "create table order_extra (" +
                        "order_id integer primary key references orders(id), gift_message text)",
                )
                st.execute("insert into users (email, age) values ('a@x.com', 30), ('b@x.com', 30), ('c@x.com', 40)")
                st.execute("insert into orders (user_id, status) values (1, 'open')")
                st.execute("insert into order_extra (order_id, gift_message) values (1, 'enjoy!')")
            }
        }
        return HikariDataSource(
            HikariConfig().apply {
                this.jdbcUrl = jdbcUrl
                maximumPoolSize = 2
                poolName = "sqlite-source-test"
            },
        )
    }

    @AfterEach
    fun cleanup() {
        dbFile.delete()
    }

    @Test
    fun `list tables and query table round trip`() {
        val ds = seededDataSource()
        try {
            val source = SqliteSource(ds, 5)

            val tables = source.listTables(null)
            assertEquals(listOf("order_extra", "orders", "users"), tables.map { it.name })
            assertTrue(tables.all { it.comment == null })

            assertEquals(listOf("main"), source.listSchemas())
            assertThrows(NotAllowedException::class.java) { source.listTables("other") }

            val data = source.queryTable(null, "users", QueryOpts(10, 0, "age", false, null))
            // No reltuples-equivalent estimate on SQLite; always the -1 sentinel.
            assertEquals(-1L, data.totalApprox)
            assertEquals(3, data.rows.size)
            assertEquals("pk", data.columns.find { it.name == "id" }?.key)
        } finally {
            ds.close()
        }
    }

    /** SQLite's `LIKE` is already ASCII case-insensitive, so `ILIKE` maps to it unmodified (`docs/adapter-decisions.md` §5.4.2). */
    @Test
    fun `ILIKE filter matches case-insensitively`() {
        val ds = seededDataSource()
        try {
            val source = SqliteSource(ds, 5)
            val data = source.queryTable(
                null,
                "users",
                QueryOpts(10, 0, null, false, listOf(Condition(column = "email", op = "ILIKE", value = "A@X.COM"))),
            )
            assertEquals(1, data.rows.size)
            assertEquals("a@x.com", data.rows.first()["email"])
        } finally {
            ds.close()
        }
    }

    @Test
    fun `AND-combined filter conditions narrow the result`() {
        val ds = seededDataSource()
        try {
            val source = SqliteSource(ds, 5)
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
            assertEquals(1, data.rows.size)
            assertEquals("b@x.com", data.rows.first()["email"])
        } finally {
            ds.close()
        }
    }

    @Test
    fun `foreign key column reports key and references`() {
        val ds = seededDataSource()
        try {
            val source = SqliteSource(ds, 5)
            val data = source.queryTable(null, "orders", QueryOpts(10, 0, null, false, null))
            val userIdCol = data.columns.find { it.name == "user_id" }!!
            assertEquals("fk", userIdCol.key)
            assertEquals("users", userIdCol.references?.table)
            assertEquals("id", userIdCol.references?.column)
        } finally {
            ds.close()
        }
    }

    @Test
    fun `pk and fk column reports both`() {
        val ds = seededDataSource()
        try {
            val source = SqliteSource(ds, 5)
            val data = source.queryTable(null, "order_extra", QueryOpts(10, 0, null, false, null))
            val orderIdCol = data.columns.find { it.name == "order_id" }!!
            assertEquals("pk", orderIdCol.key)
            assertEquals("orders", orderIdCol.references?.table)
            assertEquals("id", orderIdCol.references?.column)
        } finally {
            ds.close()
        }
    }

    @Test
    fun `table counts report the no-estimate sentinel`() {
        val ds = seededDataSource()
        try {
            val source = SqliteSource(ds, 5)
            val counts = source.tableCounts(null)
            assertEquals(
                listOf(CountEntry("order_extra", -1L), CountEntry("orders", -1L), CountEntry("users", -1L)),
                counts,
            )
        } finally {
            ds.close()
        }
    }

    @Test
    fun `common values is always empty`() {
        val ds = seededDataSource()
        try {
            val source = SqliteSource(ds, 5)
            assertTrue(source.commonValues(null, "users", "age").isEmpty())
            assertThrows(NotAllowedException::class.java) { source.commonValues(null, "users", "nope") }
        } finally {
            ds.close()
        }
    }

    @Test
    fun `unknown column in sort is rejected`() {
        val ds = seededDataSource()
        try {
            val source = SqliteSource(ds, 5)
            assertThrows(NotAllowedException::class.java) {
                source.queryTable(null, "users", QueryOpts(10, 0, "nope", false, null))
            }
        } finally {
            ds.close()
        }
    }

    /**
     * Empirical proof, not documentation trust, that [SqliteSource.bounded]'s
     * progress-handler mechanism actually interrupts a running query, not
     * just abandons the wait for one. Plain JDBC `Statement.setQueryTimeout`
     * was tried first and does *not* work on Xerial's driver — it only maps
     * to `SQLiteConnection.setBusyTimeout` (file-lock waits), so a first
     * version of this test against that mechanism ran a full ~11s instead of
     * aborting near budget (see `docs/adapter-decisions.md` §6). A recursive
     * CTE generating far more rows than a 1s budget allows must actually be
     * interrupted here.
     */
    @Test
    fun `slow query is actually aborted by the progress handler, not just abandoned`() {
        val ds = seededDataSource()
        try {
            val source = SqliteSource(ds, 1)
            var errored = false
            val elapsedMs = measureTimeMillis {
                try {
                    source.bounded(1) { conn ->
                        conn.prepareStatement(
                            "with recursive slow(x) as (" +
                                "select 1 union all select x + 1 from slow where x < 100000000" +
                                ") select count(*) from slow",
                        ).use { it.executeQuery() }
                    }
                } catch (e: Exception) {
                    errored = true
                }
            }
            assertTrue(errored, "expected the slow query to be interrupted by the progress handler")
            // Generous upper bound: proves this is a real interrupt near the
            // 1s budget, not a lucky fast completion nor an unrelated hang.
            assertTrue(elapsedMs < 10_000, "expected abortion near the 1s budget, took ${elapsedMs}ms")

            // The pool must still be usable afterward — proves the handler
            // was cleared, not left armed with a stale deadline (a reused
            // connection inheriting an already-elapsed deadline would abort
            // instantly).
            val stillWorks = source.bounded(5) { conn ->
                conn.prepareStatement("select 1").use { ps ->
                    ps.executeQuery().use { rs -> rs.next(); rs.getInt(1) }
                }
            }
            assertEquals(1, stillWorks)
        } finally {
            ds.close()
        }
    }
}
