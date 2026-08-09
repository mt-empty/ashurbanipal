package io.github.mtempty.ashurbanipal

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class IdentifierQuotingTest {
    @Test
    fun `quoteIdent doubles embedded quotes`() {
        assertEquals("\"users\"", quoteIdent("users"))
        // A name containing `"` must not let the attacker close the quoted
        // identifier early — doubling is the escape, not omission.
        assertEquals("\"foo\"\"bar\"", quoteIdent("foo\"bar"))
        assertEquals(
            "\"a\"\"; drop table users; --\"",
            quoteIdent("a\"; drop table users; --"),
        )
    }
}
