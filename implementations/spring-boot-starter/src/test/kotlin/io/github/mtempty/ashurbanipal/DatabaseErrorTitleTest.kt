package io.github.mtempty.ashurbanipal

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Test
import org.springframework.dao.DataAccessResourceFailureException
import java.net.http.HttpClient

class DatabaseErrorTitleTest {
    private val controller =
        AshurbanipalController(AshurbanipalProperties(), emptyMap(), FilterValidator(), HttpClient.newHttpClient())

    @Test
    fun `a database error's title carries no SQL or engine text`() {
        val e = DataAccessResourceFailureException("PreparedStatementCallback; SQL [select secret from t]")
        for (response in listOf(controller.handleDatabaseError(e), controller.handleUnexpectedError(e))) {
            assertEquals(500, response.statusCode.value())
            assertEquals("database_error", response.body!!.code)
            assertEquals("database error", response.body!!.title)
            assertFalse(response.body.toString().contains("secret"))
        }
    }

    @Test
    fun `an unexpected non-database error is an internal error with no message`() {
        val response = controller.handleUnexpectedError(IllegalArgumentException("secret detail"))
        assertEquals(500, response.statusCode.value())
        assertEquals("internal error", response.body!!.title)
        assertFalse(response.body.toString().contains("secret"))
    }
}
