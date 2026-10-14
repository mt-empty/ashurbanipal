package io.github.mtempty.ashurbanipal

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.web.multipart.MultipartException

class MultipartExceptionResolverTest {
    private val resolver = MultipartExceptionResolver("/__ashurbanipal")

    private fun resolve(uri: String, ex: Exception, contextPath: String = ""): Pair<Any?, MockHttpServletResponse> {
        val request = MockHttpServletRequest("GET", uri).apply {
            this.contextPath = contextPath
            requestURI = uri
        }
        val response = MockHttpServletResponse()
        return resolver.resolveException(request, response, null, ex) to response
    }

    @Test
    fun `multipart error under the base path becomes a 400 problem`() {
        val (result, response) = resolve("/__ashurbanipal/api/sources", MultipartException("no boundary"))
        assertNotNull(result)
        assertEquals(400, response.status)
        assertEquals("1", response.getHeader("x-ashurbanipal-protocol"))
        assertEquals("invalid_parameter", """"code":"([^"]+)"""".toRegex().find(response.contentAsString)?.groupValues?.get(1))
    }

    @Test
    fun `base path is matched after the servlet context path`() {
        val (result, response) = resolve("/app/__ashurbanipal/api/sources", MultipartException("x"), "/app")
        assertNotNull(result)
        assertEquals(400, response.status)
    }

    @Test
    fun `multipart error outside the base path is left to the host`() {
        for (uri in listOf("/upload", "/__ashurbanipal-other/api", "/")) {
            val (result, response) = resolve(uri, MultipartException("x"))
            assertNull(result, uri)
            assertEquals(200, response.status, uri)
        }
    }

    @Test
    fun `other exceptions under the base path are left alone`() {
        val (result, _) = resolve("/__ashurbanipal/api/sources", IllegalStateException("x"))
        assertNull(result)
    }
}
