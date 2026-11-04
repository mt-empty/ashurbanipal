package io.github.mtempty.ashurbanipal

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.sql.SQLException
import java.sql.SQLTimeoutException

/** `spec/protocol.md` §5.11 parsing, planning and SQL building; no database needed. */
class JoinSupportTest {
    private fun col(name: String, type: String, columnClass: ColumnClass) = ColMeta(name, type, columnClass)

    private fun orders() = TableMeta(
        "orders",
        listOf(
            col("id", "uuid", ColumnClass.UUID),
            col("user_id", "uuid", ColumnClass.UUID),
            col("status", "text", ColumnClass.TEXT),
            col("tags", "ARRAY", ColumnClass.ARRAY),
        ),
    )

    private fun users() = TableMeta("users", listOf(col("id", "uuid", ColumnClass.UUID), col("email", "text", ColumnClass.TEXT)))

    private fun opts(
        sort: String? = null,
        sortJoin: Int? = null,
        filter: List<Condition>? = null,
    ) = JoinOpts(10, 0, sort, sortJoin, false, filter)

    private val join = """{"table":"orders","joins":[{"type":"left","table":"users",
        "on":[{"left":{"join":0,"column":"user_id"},"right":"id"}]}]}"""

    private val pg = JoinDialect(::quoteIdent, { "$it::text" }, "native")

    @Test
    fun `only a text column reports its collation`() {
        val text = ColMeta("name", "varchar(20)", ColumnClass.TEXT, collation = "utf8mb4_bin")
        val doc = ColMeta("doc", "json", ColumnClass.JSON, collation = "utf8mb4_bin")
        assertEquals("utf8mb4_bin", text.columnInfo().collation)
        assertEquals(null, doc.columnInfo().collation)
    }

    @Test
    fun `parses a valid join`() {
        val spec = parseJoin(join)
        assertEquals(listOf("orders", "users"), spec.tableNames())
        assertTrue(spec.joins[0].left)
    }

    @Test
    fun `rejects structural violations with BadJoinException`() {
        val pair = """{"left":{"join":0,"column":"a"},"right":"b"}"""
        val entry = """{"type":"left","table":"u","on":[$pair]}"""
        val cases = mapOf(
            "not json" to "not json",
            "array" to "[]",
            "no joins" to """{"table":"o","joins":[]}""",
            "right join" to """{"table":"o","joins":[{"type":"right","table":"u","on":[$pair]}]}""",
            "uppercase type" to """{"table":"o","joins":[{"type":"LEFT","table":"u","on":[$pair]}]}""",
            "no pairs" to """{"table":"o","joins":[{"type":"left","table":"u","on":[]}]}""",
            "four pairs" to """{"table":"o","joins":[{"type":"left","table":"u","on":[$pair,$pair,$pair,$pair]}]}""",
            "forward position" to """{"table":"o","joins":[{"type":"left","table":"u","on":[{"left":{"join":1,"column":"a"},"right":"b"}]}]}""",
            "negative position" to """{"table":"o","joins":[{"type":"left","table":"u","on":[{"left":{"join":-1,"column":"a"},"right":"b"}]}]}""",
            "fractional position" to """{"table":"o","joins":[{"type":"left","table":"u","on":[{"left":{"join":0.5,"column":"a"},"right":"b"}]}]}""",
            "operator key" to """{"table":"o","joins":[{"type":"left","table":"u","on":[{"left":{"join":0,"column":"a"},"right":"b","op":">"}]}]}""",
            "empty columns" to """{"table":"o","joins":[$entry],"columns":[]}""",
            "duplicate columns" to """{"table":"o","joins":[$entry],"columns":[{"join":0,"column":"a"},{"join":0,"column":"a"}]}""",
            "five tables" to """{"table":"o","joins":[$entry,$entry,$entry,$entry]}""",
            "oversize" to """{"table":"${"t".repeat(MAX_JOIN_BYTES)}","joins":[$entry]}""",
            "unknown key" to """{"table":"o","joins":[$entry],"x":1}""",
        )
        for ((name, raw) in cases) {
            assertThrows(BadJoinException::class.java, { parseJoin(raw) }, name)
        }
        parseJoin("""{"table":"o","joins":[$entry,$entry,$entry]}""")
    }

    @Test
    fun `plan rejects unknown names, hostile names and incompatible pairs`() {
        val spec = parseJoin(join)
        planJoin(spec, listOf(orders(), users()), opts())

        val hostile = spec.copy(joins = listOf(spec.joins[0].copy(on = listOf(OnPair(ColumnPos(0, "user_id"), "id\"; drop table users; --")))))
        assertThrows(BadJoinException::class.java) { planJoin(hostile, listOf(orders(), users()), opts()) }

        val cross = spec.copy(joins = listOf(spec.joins[0].copy(on = listOf(OnPair(ColumnPos(0, "status"), "id")))))
        val ex = assertThrows(BadJoinException::class.java) { planJoin(cross, listOf(orders(), users()), opts()) }
        assertTrue(ex.message!!.contains("orders.status (text)") && ex.message!!.contains("users.id (uuid)"), ex.message)

        val array = spec.copy(joins = listOf(spec.joins[0].copy(on = listOf(OnPair(ColumnPos(0, "tags"), "id")))))
        assertThrows(BadJoinException::class.java) { planJoin(array, listOf(orders(), users()), opts()) }

        val withScore = orders().let { it.copy(columns = it.columns + col("score", "double precision", ColumnClass.FLOAT)) }
        val float = spec.copy(joins = listOf(spec.joins[0].copy(on = listOf(OnPair(ColumnPos(0, "score"), "id")))))
        val fex = assertThrows(BadJoinException::class.java) { planJoin(float, listOf(withScore, users()), opts()) }
        assertTrue(
            fex.message!!.contains("orders.score (double precision)") &&
                fex.message!!.contains("floating-point values are not compared exactly"),
            fex.message,
        )
    }

    @Test
    fun `enums pair only within one type and text collations must match`() {
        fun enumTable(name: String, id: String) = TableMeta(name, listOf(col("e", "USER-DEFINED", ColumnClass.enum(id))))
        val spec = JoinSpec("x", listOf(JoinEntry(false, "y", listOf(OnPair(ColumnPos(0, "e"), "e")))))
        planJoin(spec, listOf(enumTable("x", "a"), enumTable("y", "a")), opts())
        assertThrows(BadJoinException::class.java) { planJoin(spec, listOf(enumTable("x", "a"), enumTable("y", "b")), opts()) }

        fun textTable(name: String, collation: String) = TableMeta(name, listOf(ColMeta("e", "varchar", ColumnClass.TEXT, collation)))
        val ex = assertThrows(BadJoinException::class.java) {
            planJoin(spec, listOf(textTable("x", "utf8mb4_bin"), textTable("y", "utf8mb4_general_ci")), opts())
        }
        assertTrue(ex.message!!.contains("collation"))
    }

    @Test
    fun `filter and sort positions are range checked`() {
        val spec = parseJoin(join)
        assertThrows(FilterException::class.java) {
            planJoin(spec, listOf(orders(), users()), opts(filter = listOf(Condition(column = "id", op = "IS NULL", join = 2))))
        }
        assertThrows(BadParameterException::class.java) { planJoin(spec, listOf(orders(), users()), opts(sortJoin = 1)) }
        assertThrows(NotAllowedException::class.java) { planJoin(spec, listOf(orders(), users()), opts(sort = "email")) }
    }

    @Test
    fun `labels are unique and stable`() {
        assertEquals(listOf("id_0", "id_1_2", "email", "id_1"), assignJoinLabels(listOf("id", "id", "email", "id_1"), listOf(0, 1, 1, 0)))
        assertEquals(listOf("id_0", "id_1", "email"), assignJoinLabels(listOf("id", "id", "email"), listOf(0, 1, 1)))
    }

    @Test
    fun `builds sql from catalog names and generated aliases only`() {
        val plan = planJoin(
            parseJoin(join),
            listOf(orders(), users()),
            opts(
                sort = "email",
                sortJoin = 1,
                filter = listOf(
                    Condition(column = "email", op = "=", value = "a@b.c", join = 1),
                    Condition(logic = "OR", not = true, column = "status", op = "IS NULL"),
                ),
            ),
        )
        val (body, values) = buildJoinSelect(plan, pg, "public")
        assertTrue(body.startsWith("t0.\"id\"::text as c0, "), body)
        assertTrue(body.contains(" from \"public\".\"orders\" t0 left join \"public\".\"users\" t1 on t1.\"id\" = t0.\"user_id\""), body)
        assertTrue(body.contains(" where (t1.\"email\"::text = ?) OR (NOT (t0.\"status\"::text IS NULL))"), body)
        assertTrue(body.endsWith(" order by t1.\"email\" asc limit ? offset ?"), body)
        assertEquals(listOf("a@b.c"), values)
    }

    @Test
    fun `a join key in a filter is only accepted when the route allows it`() {
        val raw = """[{"join":1,"column":"email","op":"IS NULL"}]"""
        assertThrows(FilterException::class.java) { FilterValidator().parse(raw) }
        assertEquals(1, FilterValidator().parse(raw, allowJoin = true)[0].join)
        assertThrows(FilterException::class.java) { FilterValidator().parse("""[{"join":-1,"column":"e","op":"IS NULL"}]""", allowJoin = true) }
    }

    @Test
    fun `column classes follow the engine's catalog types`() {
        assertEquals(ColumnClass.NUMBER, pgColumnClass("integer", "", "", false))
        assertEquals(ColumnClass.enum("public.mood"), pgColumnClass("USER-DEFINED", "public", "mood", true))
        assertEquals(ColumnClass.ARRAY, pgColumnClass("ARRAY", "", "", false))
        assertEquals(ColumnClass.JSON, pgColumnClass("jsonb", "", "", false))
        assertEquals(ColumnClass.JSON, pgColumnClass("json", "", "", false))
        assertEquals(ColumnClass.FLOAT, pgColumnClass("double precision", "", "", false))
        assertEquals(ColumnClass.FLOAT, pgColumnClass("real", "", "", false))
        assertEquals(ColumnClass.OTHER, pgColumnClass("money", "", "", false))
        assertEquals(ColumnClass.OTHER, pgColumnClass("USER-DEFINED", "public", "geometry", false))

        assertEquals(ColumnClass.NUMBER, mysqlColumnClass("bigint", "bigint"))
        assertEquals(ColumnClass.TEXT, mysqlColumnClass("VARCHAR", "varchar(20)"))
        assertEquals(ColumnClass.enum("enum('a','b')"), mysqlColumnClass("enum", "enum('a','b')"))
        assertEquals(ColumnClass.JSON, mysqlColumnClass("json", "json"))
        assertEquals(ColumnClass.FLOAT, mysqlColumnClass("double", "double"))
        assertEquals(ColumnClass.OTHER, mysqlColumnClass("set", "set('a','b')"))

        assertEquals(ColumnClass.NUMBER, sqliteColumnClass("DECIMAL(10,2)"))
        assertEquals(ColumnClass.TEXT, sqliteColumnClass("VARCHAR(20)"))
        assertEquals(ColumnClass.UUID, sqliteColumnClass("UUID"))
        assertEquals(ColumnClass.UNTYPED, sqliteColumnClass(""))
        assertEquals(ColumnClass.FLOAT, sqliteColumnClass("REAL"))
        assertEquals(ColumnClass.FLOAT, sqliteColumnClass("DOUBLE PRECISION"))
        assertEquals(ColumnClass.JSON, sqliteColumnClass("JSON"))
    }

    @Test
    fun `isQueryTimeout recognises every engine's signal and nothing else`() {
        assertTrue(isQueryTimeout(SQLException("canceling statement", "57014")))
        assertTrue(isQueryTimeout(SQLException("max execution time", "HY000", 3024)))
        assertTrue(isQueryTimeout(SQLException("statement timeout", "HY000", 1969)))
        assertTrue(isQueryTimeout(SQLTimeoutException("timeout")))
        assertTrue(isQueryTimeout(SQLException("[SQLITE_INTERRUPT] Operation terminated by sqlite3_interrupt()")))
        assertTrue(isQueryTimeout(RuntimeException("wrapped", SQLException("canceling statement", "57014"))))
        assertFalse(isQueryTimeout(SQLException("permission denied", "42501")))
        assertFalse(isQueryTimeout(RuntimeException("boom")))
    }
}
