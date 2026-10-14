package io.github.mtempty.ashurbanipal

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse

class MultipartResolverHttpTest : AshurbanipalHttpTestBase() {

    @Test
    fun `boundary-less multipart content type is a 400 problem, not a 500`() {
        val request = HttpRequest.newBuilder(URI(url("/api/sources")))
            .header("Content-Type", "multipart/form-data")
            .GET()
            .build()
        val response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString())

        assertEquals(400, response.statusCode())
        assertEquals("1", response.headers().firstValue("x-ashurbanipal-protocol").orElse(null))
        assertTrue(response.headers().firstValue("content-type").orElse("").startsWith("application/problem+json"))
        assertEquals("invalid_parameter", mapper.readTree(response.body()).get("code").asText())
    }
}
