package io.github.mtempty.ashurbanipal

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.sql.SQLException
import java.sql.SQLTimeoutException

/** Planning and SQL building are covered per engine by `spec/fixtures/join-builder-tests.json` ([JoinBuilderFixtureTest]). */
class JoinSupportTest {
    private fun col(name: String, type: String, columnClass: ColumnClass) = ColMeta(name, type, columnClass)

    private fun orders() = TableMeta(
        "orders",
        listOf(
            col("id", "uuid", ColumnClass.UUID),
            col("user_id", "uuid", ColumnClass.UUID),
        ),
        "public",
        listOf(0),
    )

    private fun users() =
        TableMeta("users", listOf(col("id", "uuid", ColumnClass.UUID), col("email", "text", ColumnClass.TEXT)), "public", listOf(0))

    @Test
    fun `a key with an unusable part is dropped`() {
        val parts = listOf(KeyPart("a", false, "x", true), KeyPart("a", false, "y", false), KeyPart("b", false, "x", true))
        assertEquals(listOf(UniqueKey("b", false, listOf("x"))), groupUniqueKeys(parts))
    }

    private fun opts() = JoinOpts(10, 0, null, null, false, null)

    private val join = """{"table":"orders","joins":[{"type":"left","table":"users",
        "on":[{"left":{"join":0,"column":"user_id"},"right":"id"}]}]}"""

    @Test
    fun `only a text column reports its collation`() {
        val text = ColMeta("name", "varchar(20)", ColumnClass.TEXT, collation = "utf8mb4_bin")
        val doc = ColMeta("doc", "json", ColumnClass.JSON, collation = "utf8mb4_bin")
        assertEquals("utf8mb4_bin", text.columnInfo().collation)
        assertEquals(null, doc.columnInfo().collation)
    }

    @Test
    fun `a float key says why it cannot join`() {
        val spec = parseJoin(join)
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
    fun `value forms`() {
        val cases = listOf(
            Triple(ValueForm.MYSQL_DECIMAL, "-12", true),
            Triple(ValueForm.MYSQL_DECIMAL, "+3.25", true),
            Triple(ValueForm.MYSQL_DECIMAL, "0.5", true),
            Triple(ValueForm.MYSQL_DECIMAL, ".5", false),
            Triple(ValueForm.MYSQL_DECIMAL, "5.", false),
            Triple(ValueForm.MYSQL_DECIMAL, "1e3", false),
            Triple(ValueForm.MYSQL_DECIMAL, "abc", false),
            Triple(ValueForm.MYSQL_DECIMAL, "", false),
            Triple(ValueForm.MYSQL_DECIMAL, "NaN", false),
            Triple(ValueForm.MYSQL_DECIMAL, "9".repeat(35), true),
            Triple(ValueForm.MYSQL_DECIMAL, "9".repeat(36), false),
            Triple(ValueForm.MYSQL_FLOAT, "1.5e-3", true),
            Triple(ValueForm.MYSQL_FLOAT, "2E10", true),
            Triple(ValueForm.MYSQL_FLOAT, "1e", false),
            Triple(ValueForm.MYSQL_FLOAT, "NaN", false),
            Triple(ValueForm.MYSQL_DATE, "2016-02-29", true),
            Triple(ValueForm.MYSQL_DATE, "2015-02-29", false),
            Triple(ValueForm.MYSQL_DATE, "2016-02-30", false),
            Triple(ValueForm.MYSQL_DATE, "0000-00-00", true),
            Triple(ValueForm.MYSQL_DATE, "0000-01-01", false),
            Triple(ValueForm.MYSQL_DATE, "12000-01-01", false),
            Triple(ValueForm.MYSQL_DATE, "2016-01-01 10:00", false),
            Triple(ValueForm.MYSQL_DATETIME, "2016-01-01", true),
            Triple(ValueForm.MYSQL_DATETIME, "2016-01-01 10:30", true),
            Triple(ValueForm.MYSQL_DATETIME, "2016-01-01T10:30:00.123456", true),
            Triple(ValueForm.MYSQL_DATETIME, "0000-00-00 00:00:00", true),
            Triple(ValueForm.MYSQL_DATETIME, "2016-01-01T10:30:00.1234567", false),
            Triple(ValueForm.MYSQL_DATETIME, "2016-01-01T10:30:00Z", false),
            Triple(ValueForm.MYSQL_DATETIME, "2016-01-01 ", false),
            Triple(ValueForm.MYSQL_DATETIME, "2016-01-01 24:00", false),
            Triple(ValueForm.MYSQL_TIME, "23:59:59", true),
            Triple(ValueForm.MYSQL_TIME, "-01:00:00", true),
            Triple(ValueForm.MYSQL_TIME, "100:00:00.5", true),
            Triple(ValueForm.MYSQL_TIME, "838:59:59", true),
            Triple(ValueForm.MYSQL_TIME, "839:00:00", false),
            Triple(ValueForm.MYSQL_TIME, "9:30", false),
            Triple(ValueForm.MYSQL_TIME, "10:60", false),
            Triple(ValueForm.PG_NUMERIC, "-12", true),
            Triple(ValueForm.PG_NUMERIC, "9".repeat(40), true),
            Triple(ValueForm.PG_NUMERIC, "NaN", true),
            Triple(ValueForm.PG_NUMERIC, "-Infinity", true),
            Triple(ValueForm.PG_NUMERIC, "1e3", false),
            Triple(ValueForm.PG_NUMERIC, "abc", false),
            Triple(ValueForm.PG_FLOAT, "1e+300", true),
            Triple(ValueForm.PG_FLOAT, "infinity", true),
            Triple(ValueForm.PG_FLOAT, "1e", false),
            Triple(ValueForm.PG_DATE, "2016-02-29", true),
            Triple(ValueForm.PG_DATE, "2016-02-30", false),
            Triple(ValueForm.PG_DATE, "12000-01-01", true),
            Triple(ValueForm.PG_DATE, "0044-03-15 BC", true),
            Triple(ValueForm.PG_DATE, "0001-02-29 BC", true),
            Triple(ValueForm.PG_DATE, "0002-02-29 BC", false),
            Triple(ValueForm.PG_DATE, "infinity", true),
            Triple(ValueForm.PG_DATE, "-infinity", true),
            Triple(ValueForm.PG_DATE, "0000-01-01", false),
            Triple(ValueForm.PG_DATE, "0000-00-00", false),
            Triple(ValueForm.PG_TIMESTAMP, "2016-01-01 10:30", true),
            Triple(ValueForm.PG_TIMESTAMP, "0044-03-15 10:00:00 BC", true),
            Triple(ValueForm.PG_TIMESTAMP, "12000-01-01 10:00:00", true),
            Triple(ValueForm.PG_TIMESTAMP, "2016-01-01 24:00:00", true),
            Triple(ValueForm.PG_TIMESTAMP, "infinity", true),
            Triple(ValueForm.PG_TIMESTAMP, "2016-01-01T10:30:00Z", false),
            Triple(ValueForm.PG_TIME, "23:59:59", true),
            Triple(ValueForm.PG_TIME, "24:00", true),
            Triple(ValueForm.PG_TIME, "24:00:00.000", true),
            Triple(ValueForm.PG_TIME, "24:00:01", false),
            Triple(ValueForm.PG_TIME, "10:60", false),
            Triple(ValueForm.PG_TIME, "9:30", false),
            Triple(ValueForm.PG_TIME, "10:00+02", false),
            Triple(ValueForm.PG_TIMESTAMP_TZ, "2016-01-01 10:00:00+00", true),
            Triple(ValueForm.PG_TIMESTAMP_TZ, "2016-01-01T10:00:00.5+05:30", true),
            Triple(ValueForm.PG_TIMESTAMP_TZ, "1890-01-01 00:00:00+00:53:28", true),
            Triple(ValueForm.PG_TIMESTAMP_TZ, "0044-03-15 10:00:00+00:53:28 BC", true),
            Triple(ValueForm.PG_TIMESTAMP_TZ, "2016-01-01 10:00-0300", true),
            Triple(ValueForm.PG_TIMESTAMP_TZ, "2016-01-01 10:00Z", true),
            Triple(ValueForm.PG_TIMESTAMP_TZ, "2016-01-01", true),
            Triple(ValueForm.PG_TIMESTAMP_TZ, "-infinity", true),
            Triple(ValueForm.PG_TIMESTAMP_TZ, "2016-01-01Z", false),
            Triple(ValueForm.PG_TIMESTAMP_TZ, "2016-01-01 10:00+5", false),
            Triple(ValueForm.PG_TIMESTAMP_TZ, "2016-01-01 10:00+05:3", false),
            Triple(ValueForm.PG_TIME_TZ, "10:00:00+02", true),
            Triple(ValueForm.PG_TIME_TZ, "24:00:00+00", true),
            Triple(ValueForm.PG_TIME_TZ, "10:00", true),
            Triple(ValueForm.PG_TIME_TZ, "10:00+", false),
        )
        for ((form, v, ok) in cases) assertEquals(ok, form.accepts(v), "$form $v")
    }

    @Test
    fun `a table in another schema is reported under it`() {
        val plan = planJoin(parseJoin(join), listOf(orders(), users().copy(schema = "warehouse")), opts())
        for (c in plan.columnInfos("public")) {
            assertEquals(if (c.table == "users") "warehouse" else null, c.schema, "${c.table}.${c.column}")
        }
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
        assertEquals(ColumnClass.NUMBER, pgColumnClass("smallint", "", "", false))
        assertEquals(ColumnClass.TEMPORAL, pgColumnClass("date", "", "", false))
        assertEquals(ColumnClass.TEMPORAL, pgColumnClass("timestamp without time zone", "", "", false))
        assertEquals(ColumnClass.TEMPORAL, pgColumnClass("timestamp with time zone", "", "", false))
        assertEquals(ColumnClass.TIME, pgColumnClass("time without time zone", "", "", false))
        assertEquals(ColumnClass.TIME, pgColumnClass("time with time zone", "", "", false))
        assertEquals(ColumnClass.OTHER, pgColumnClass("money", "", "", false))
        assertEquals(ColumnClass.OTHER, pgColumnClass("USER-DEFINED", "public", "geometry", false))

        assertEquals(ColumnClass.NUMBER, mysqlColumnClass("bigint", "bigint"))
        assertEquals(ColumnClass.TEXT, mysqlColumnClass("VARCHAR", "varchar(20)"))
        assertEquals(ColumnClass.enum("enum('a','b')"), mysqlColumnClass("enum", "enum('a','b')"))
        assertEquals(ColumnClass.JSON, mysqlColumnClass("json", "json"))
        assertEquals(ColumnClass.FLOAT, mysqlColumnClass("double", "double"))
        assertEquals(ColumnClass.OTHER, mysqlColumnClass("set", "set('a','b')"))
        assertEquals(ColumnClass.NUMBER, mysqlColumnClass("TINYINT", "tinyint(1)"))
        assertEquals(ColumnClass.NUMBER, mysqlColumnClass("decimal", "decimal(10,2)"))
        assertEquals(ColumnClass.TEMPORAL, mysqlColumnClass("date", "date"))
        assertEquals(ColumnClass.TEMPORAL, mysqlColumnClass("datetime", "datetime"))
        assertEquals(ColumnClass.TEMPORAL, mysqlColumnClass("timestamp", "timestamp(6)"))
        assertEquals(ColumnClass.TIME, mysqlColumnClass("time", "time"))
        assertEquals(ColumnClass.FLOAT, mysqlColumnClass("float", "float"))
        assertEquals(ColumnClass.OTHER, mysqlColumnClass("year", "year"))

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

    @Test
    fun `a MySQL zero date compares the column's text on the table route`() {
        val d = ColMeta("d", "date", ColumnClass.TEMPORAL, compare = TypedCompare(ValueForm.MYSQL_DATE))
        val table = TableMeta("t", listOf(d))
        for ((cond, want) in listOf(
            Condition(column = "d", op = "=", value = "2016-02-29") to " where (\"d\" = ?)",
            Condition(column = "d", op = "=", value = "0000-00-00") to " where (\"d\"::text = ?)",
            Condition(column = "d", op = "IN", value = listOf("2016-02-29", "0000-00-00")) to " where (\"d\"::text IN (?, ?))",
        )) {
            assertEquals(want, tableWhereClause(listOf(cond), table, PG_DIALECT).sql)
        }
    }
}
