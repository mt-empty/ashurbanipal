package io.github.mtempty.ashurbanipal

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** `spec/protocol.md` §5.1: when the UI route may send the page gzipped. */
class PageEncodingTest {
    @Test
    fun `accept-encoding is read with q values and wildcards`() {
        val cases = mapOf(
            emptyList<String>() to false,
            listOf("") to false,
            listOf("gzip") to true,
            listOf("GZIP") to true,
            listOf("x-gzip") to true,
            listOf("gzip, deflate, br, zstd") to true,
            listOf("br", "gzip") to true,
            listOf("gzip;q=0") to false,
            listOf("gzip; q=0.000") to false,
            listOf("gzip;q=0.5") to true,
            listOf("br") to false,
            listOf("identity") to false,
            listOf("*") to true,
            listOf("*;q=0") to false,
            listOf("gzip;q=0, *") to false,
            listOf("*;q=0, gzip") to true,
            listOf("gzip;q=abc") to false,
        )
        for ((headers, want) in cases) assertEquals(want, acceptsGzip(headers), "acceptsGzip($headers)")
    }
}
