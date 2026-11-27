package io.github.mtempty.ashurbanipal

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class LimitsTest {
    @Test
    fun `a query timeout below 1 s falls back to the default`() {
        assertEquals(5, Limits(queryTimeoutSecs = 0).effectiveQueryTimeoutSecs)
        assertEquals(5, Limits(queryTimeoutSecs = -3).effectiveQueryTimeoutSecs)
        assertEquals(9, Limits(queryTimeoutSecs = 9).effectiveQueryTimeoutSecs)
    }
}
