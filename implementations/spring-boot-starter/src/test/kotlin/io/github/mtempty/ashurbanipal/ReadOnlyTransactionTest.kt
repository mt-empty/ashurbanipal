package io.github.mtempty.ashurbanipal

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.net.URI
import java.sql.SQLException

private const val SCHEMA = "ashb_test_spring_read_only_tx"
private const val ROLE = "ashb_test_spring_read_only_tx_role"

private fun sqlStateOf(e: Throwable): String? =
    generateSequence(e) { it.cause }.filterIsInstance<SQLException>().firstOrNull()?.sqlState

/**
 * Every operation runs in a read-only transaction (`spec/protocol.md` §6). A
 * row-level security policy that calls a writing function is the one way a
 * plain SELECT on a listed table can write; RLS does not apply to a superuser,
 * so the source's sessions `set role` to an ordinary role.
 */
class ReadOnlyTransactionTest {
    private fun pool(name: String, initSql: String? = null): HikariDataSource {
        val databaseUrl = requireTestEnv("DATABASE_URL")
            ?: error("DATABASE_URL must be set (the devcontainer sets it automatically)")
        val uri = URI(databaseUrl)
        val (u, p) = (uri.userInfo ?: ":").split(":", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
        return HikariDataSource(
            HikariConfig().apply {
                jdbcUrl = "jdbc:postgresql://${uri.host}:${uri.port}${uri.path}"
                username = u
                password = p
                maximumPoolSize = 1
                poolName = name
                connectionInitSql = initSql
            },
        )
    }

    @Test
    fun `a select that would write fails and writes nothing`() {
        pool("read-only-tx-setup").use { admin ->
            admin.connection.use { conn ->
                conn.createStatement().use { st ->
                    st.execute("drop schema if exists $SCHEMA cascade")
                    st.execute("drop role if exists $ROLE")
                    st.execute("create role $ROLE nosuperuser")
                    st.execute("grant $ROLE to current_user")
                    st.execute("create schema $SCHEMA")
                    st.execute("grant usage on schema $SCHEMA to $ROLE")
                    // The role may insert, so only the read-only transaction stops the write.
                    st.execute("create table $SCHEMA.audit (id serial primary key)")
                    st.execute("grant insert on $SCHEMA.audit to $ROLE")
                    st.execute("grant usage on sequence $SCHEMA.audit_id_seq to $ROLE")
                    st.execute(
                        "create function $SCHEMA.log_read() returns boolean language sql volatile " +
                            "as \$\$ insert into $SCHEMA.audit default values; select true \$\$",
                    )
                    st.execute("create table $SCHEMA.watched (id int primary key)")
                    st.execute("insert into $SCHEMA.watched values (1)")
                    st.execute("alter table $SCHEMA.watched enable row level security")
                    st.execute(
                        "create policy log_every_read on $SCHEMA.watched for select to $ROLE " +
                            "using ($SCHEMA.log_read())",
                    )
                    st.execute("grant select on $SCHEMA.watched to $ROLE")
                }
            }
            try {
                pool("read-only-tx-role", "set role $ROLE").use { roleDs ->
                    val source = PostgresSource(roleDs, 5)
                    val opts = QueryOpts(limit = 10, offset = 0, sort = null, descending = false, filter = null)
                    val e = assertThrows<Exception> { source.queryTable(SCHEMA, "watched", opts) }
                    assertEquals("25006", sqlStateOf(e), e.toString())
                }
                admin.connection.use { conn ->
                    conn.createStatement().use { st ->
                        st.executeQuery("select count(*) from $SCHEMA.audit").use { rs ->
                            rs.next()
                            assertEquals(0, rs.getInt(1))
                        }
                    }
                }
            } finally {
                admin.connection.use { conn ->
                    conn.createStatement().use { st ->
                        st.execute("drop schema if exists $SCHEMA cascade")
                        st.execute("drop role if exists $ROLE")
                    }
                }
            }
        }
    }
}
