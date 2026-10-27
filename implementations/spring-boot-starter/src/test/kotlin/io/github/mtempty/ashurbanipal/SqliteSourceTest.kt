package io.github.mtempty.ashurbanipal

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.sql.DriverManager
import kotlin.system.measureTimeMillis

/** Uses an on-disk SQLite file so Xerial's driver can interrupt a real slow query. */
class SqliteSourceTest {
    private val dbFile = Files.createTempFile("ashurbanipal-sqlite-test", ".db").toFile()

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

            assertEquals(SchemaListing(listOf("main"), "main"), source.listSchemas())
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
    fun `referenced-by lists incoming FKs with synthesized constraint names`() {
        val ds = seededDataSource()
        try {
            val source = SqliteSource(ds, 5)

            val toUsers = source.referencedBy(null, "users")
            assertEquals(1, toUsers.size)
            assertEquals("orders", toUsers.first().table)
            assertNull(toUsers.first().schema)
            assertEquals(listOf(ColumnPair("user_id", "id")), toUsers.first().columns)
            // SQLite FKs are unnamed — the label is synthesized fk_<id>.
            assertTrue(toUsers.first().constraint.matches(Regex("fk_\\d+")), toUsers.first().constraint)

            assertEquals(listOf("order_extra"), source.referencedBy(null, "orders").map { it.table })
            assertTrue(source.referencedBy(null, "order_extra").isEmpty())

            assertThrows(NotAllowedException::class.java) { source.referencedBy(null, "no_such_table") }
            assertThrows(NotAllowedException::class.java) { source.referencedBy("other", "users") }
        } finally {
            ds.close()
        }
    }

    @Test
    fun `partialIndexPredicate finds the top-level WHERE only`() {
        assertEquals("status = 'open'", partialIndexPredicate("CREATE INDEX i ON t(a) WHERE status = 'open'"))
        assertEquals("b > 1", partialIndexPredicate("CREATE INDEX i ON t(a)\nwhere\n  b > 1"))
        assertEquals("note = ' where '", partialIndexPredicate("CREATE INDEX i ON t(a) WHERE note = ' where '"))
        assertNull(partialIndexPredicate("CREATE INDEX i ON t(a || ' where ')"))
        assertNull(partialIndexPredicate("CREATE INDEX i ON t(lower(a) )"))
    }

    @Test
    fun `structure reports indexes, partial predicate, unique and FK actions`() {
        val ds = dataSourceFor(
            "create table users (id integer primary key, email text unique)",
            "create table orders (id integer primary key, user_id integer not null references users on delete cascade, " +
                "kind text, status text)",
            "create index orders_kind_status_idx on orders(kind, status)",
            "create index orders_open_idx on orders(user_id) where status = 'open'",
        )
        try {
            val source = SqliteSource(ds, 5)

            val s = source.structure(null, "orders")
            val byName = s.indexes.associateBy { it.name }
            assertEquals(listOf("kind", "status"), byName.getValue("orders_kind_status_idx").columns)
            assertEquals("status = 'open'", byName.getValue("orders_open_idx").predicate)
            assertNull(byName.getValue("orders_kind_status_idx").predicate)
            assertEquals(listOf("id"), s.constraints.primaryKey?.columns)
            val fk = s.constraints.foreignKeys.single()
            assertEquals("users", fk.table)
            assertEquals(listOf(ColumnPair("user_id", "id")), fk.columns)
            assertEquals("CASCADE", fk.onDelete)
            assertEquals("NO ACTION", fk.onUpdate)
            assertTrue(s.constraints.check.isEmpty())

            assertEquals(listOf(listOf("email")), source.structure(null, "users").constraints.unique.map { it.columns })

            assertThrows(NotAllowedException::class.java) { source.structure(null, "no_such_table") }
            assertThrows(NotAllowedException::class.java) { source.structure("other", "users") }
        } finally {
            ds.close()
        }
    }

    // Xerial's SQLite driver only runs the first statement of a
    // semicolon-joined batch passed to a single execute() call — each DDL
    // statement needs its own execute(), same as seededDataSource above.
    private fun dataSourceFor(vararg statements: String): HikariDataSource {
        val file = Files.createTempFile("ashurbanipal-sqlite-shorthand-fk-test", ".db").toFile()
        val jdbcUrl = "jdbc:sqlite:${file.absolutePath}"
        DriverManager.getConnection(jdbcUrl).use { conn ->
            conn.createStatement().use { st -> statements.forEach { st.execute(it) } }
        }
        return HikariDataSource(
            HikariConfig().apply {
                this.jdbcUrl = jdbcUrl
                maximumPoolSize = 2
                poolName = "sqlite-shorthand-fk-test"
            },
        )
    }

    // "REFERENCES parent" with no parenthesised column list is valid DDL
    // meaning "the parent's primary key", but pragma_foreign_key_list
    // reports "to" as NULL for that form rather than filling in the PK
    // name — the query must resolve it itself.
    @Test
    fun `referenced-by resolves a shorthand FK with no named parent column`() {
        val ds = dataSourceFor(
            "create table users (id integer primary key, email text not null)",
            "create table pets (id integer primary key, owner_id integer references users)",
        )
        try {
            val source = SqliteSource(ds, 5)
            val refs = source.referencedBy(null, "users")
            val pets = refs.find { it.table == "pets" }
            assertTrue(pets != null, "pets' FK to users must be reported")
            assertEquals(
                listOf(ColumnPair("owner_id", "id")),
                pets!!.columns,
                "an unnamed parent column must resolve to users' primary key, not null",
            )
        } finally {
            ds.close()
        }
    }

    // Same shorthand-FK bug, forward direction: keyMetadata (which supplies
    // queryTable's per-column references) shares referencedBy's pre-fix
    // bug — pragma_foreign_key_list.to is NULL for "REFERENCES parent" with
    // no named column, and until fixed keyMetadata doesn't resolve it the
    // way referencedBy now does.
    @Test
    fun `query table resolves a shorthand FK with no named parent column`() {
        val ds = dataSourceFor(
            "create table users (id integer primary key, email text not null)",
            "create table pets (id integer primary key, owner_id integer references users)",
        )
        try {
            val source = SqliteSource(ds, 5)
            val data = source.queryTable(null, "pets", QueryOpts(10, 0, null, false, null))
            val ownerIdCol = data.columns.find { it.name == "owner_id" }!!
            assertEquals("fk", ownerIdCol.key)
            assertEquals("users", ownerIdCol.references?.table)
            assertEquals(
                "id",
                ownerIdCol.references?.column,
                "an unnamed parent column must resolve to users' primary key, not null",
            )
        } finally {
            ds.close()
        }
    }

    @Test
    fun `referenced-by resolves a shorthand FK against a composite primary key`() {
        val ds = dataSourceFor(
            "create table warehouse_bins (" +
                "warehouse_code text not null, bin_code text not null, " +
                "primary key (warehouse_code, bin_code))",
            "create table bin_counts (" +
                "id integer primary key, warehouse_code text not null, bin_code text not null, " +
                "qty integer not null, " +
                "foreign key (warehouse_code, bin_code) references warehouse_bins)",
        )
        try {
            val source = SqliteSource(ds, 5)
            val refs = source.referencedBy(null, "warehouse_bins")
            val binCounts = refs.find { it.table == "bin_counts" }
            assertTrue(binCounts != null)
            assertEquals(2, binCounts!!.columns.size, "a composite FK must resolve every parent PK column")
            assertEquals(
                setOf(ColumnPair("warehouse_code", "warehouse_code"), ColumnPair("bin_code", "bin_code")),
                binCounts.columns.toSet(),
            )
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
                    errored = isQueryTimeout(e)
                }
            }
            assertTrue(errored, "expected the interrupt to be recognised as a query timeout")
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

    private fun usersOrders(type: String) = parseJoin(
        """{"table":"users","joins":[{"type":"$type","table":"orders",
            "on":[{"left":{"join":0,"column":"id"},"right":"user_id"}]}]}""",
    )

    private val joinOpts = JoinOpts(10, 0, null, null, false, null)

    @Test
    fun `join keeps unmatched rows on left and drops them on inner`() {
        val ds = seededDataSource()
        try {
            val source = SqliteSource(ds, 5)
            val left = source.queryJoin(null, usersOrders("left"), joinOpts)
            assertEquals(3, left.rows.size)
            assertFalse(left.hasMore)
            assertEquals(2, left.rows.count { it["status"] == null })
            assertEquals(1, source.queryJoin(null, usersOrders("inner"), joinOpts).rows.size)
        } finally {
            ds.close()
        }
    }

    @Test
    fun `self join has distinct labels and reports has_more`() {
        val ds = seededDataSource()
        try {
            val self = parseJoin(
                """{"table":"users","joins":[{"type":"inner","table":"users",
                    "on":[{"left":{"join":0,"column":"age"},"right":"age"}]}],
                    "columns":[{"join":0,"column":"id"},{"join":1,"column":"id"}]}""",
            )
            val page = SqliteSource(ds, 5).queryJoin(null, self, joinOpts.copy(limit = 2))
            assertEquals(2, page.rows.size)
            assertTrue(page.hasMore)
            assertEquals(listOf("id_0", "id_1"), page.columns.map { it.name })
        } finally {
            ds.close()
        }
    }

    @Test
    fun `join filters and sorts on a joined table's column`() {
        val ds = seededDataSource()
        try {
            val three = parseJoin(
                """{"table":"orders","joins":[
                    {"type":"left","table":"users","on":[{"left":{"join":0,"column":"user_id"},"right":"id"}]},
                    {"type":"left","table":"order_extra","on":[{"left":{"join":0,"column":"id"},"right":"order_id"}]}],
                    "columns":[{"join":0,"column":"id"},{"join":1,"column":"email"},{"join":2,"column":"gift_message"}]}""",
            )
            val data = SqliteSource(ds, 5).queryJoin(
                null,
                three,
                joinOpts.copy(sort = "email", sortJoin = 1, filter = listOf(Condition(column = "email", op = "LIKE", value = "a@%", join = 1))),
            )
            assertEquals(listOf(linkedMapOf<String, String?>("id" to "1", "email" to "a@x.com", "gift_message" to "enjoy!")), data.rows)
        } finally {
            ds.close()
        }
    }

    @Test
    fun `join rejects hostile names, mismatched types and other schemas`() {
        val ds = seededDataSource()
        try {
            val source = SqliteSource(ds, 5)
            val hostile = parseJoin(
                """{"table":"users\"; drop table users; --","joins":[{"type":"left","table":"orders",
                    "on":[{"left":{"join":0,"column":"id"},"right":"user_id"}]}]}""",
            )
            assertThrows(BadJoinException::class.java) { source.queryJoin(null, hostile, joinOpts) }
            val mismatch = parseJoin(
                """{"table":"users","joins":[{"type":"left","table":"orders",
                    "on":[{"left":{"join":0,"column":"email"},"right":"user_id"}]}]}""",
            )
            assertThrows(BadJoinException::class.java) { source.queryJoin(null, mismatch, joinOpts) }
            assertThrows(NotAllowedException::class.java) { source.queryJoin("other", usersOrders("left"), joinOpts) }
        } finally {
            ds.close()
        }
    }
}
