package io.github.mtempty.ashurbanipal

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.runner.WebApplicationContextRunner
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.web.multipart.MultipartException

class MultipartExceptionResolverTest {
    private fun resolve(
        uri: String,
        ex: Exception,
        contextPath: String = "",
        mount: String = "/__ashurbanipal",
    ): Pair<Any?, MockHttpServletResponse> {
        val request = MockHttpServletRequest("GET", uri).apply {
            this.contextPath = contextPath
            requestURI = uri
        }
        val response = MockHttpServletResponse()
        return MultipartExceptionResolver(ViewerMount(mount)).resolveException(request, response, null, ex) to response
    }

    @Test
    fun `multipart error under the base path becomes a 400 problem`() {
        val (result, response) = resolve("/__ashurbanipal/api/sources", MultipartException("no boundary"))
        assertNotNull(result)
        assertEquals(400, response.status)
        assertEquals("1", response.getHeader("x-ashurbanipal-protocol"))
        assertEquals("nosniff", response.getHeader("X-Content-Type-Options"))
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
    fun `a mount under the DispatcherServlet's path is matched`() {
        val (result, response) = resolve("/ctx/app/__ashurbanipal/api/sources", MultipartException("x"), "/ctx", "/app/__ashurbanipal")
        assertNotNull(result)
        assertEquals(400, response.status)
    }

    @Test
    fun `the resolver bean follows the DispatcherServlet's path`() {
        WebApplicationContextRunner()
            .withUserConfiguration(AshurbanipalAutoConfiguration::class.java, TestDataSourceConfig::class.java)
            .withPropertyValues("ashurbanipal.enabled=true", "spring.mvc.servlet.path=/app")
            .run { context ->
                val resolver = context.getBean(MultipartExceptionResolver::class.java)
                val request = MockHttpServletRequest("GET", "/app/__ashurbanipal/api/sources")
                assertNotNull(resolver.resolveException(request, MockHttpServletResponse(), null, MultipartException("x")))
            }
    }

    @Test
    fun `another method on a viewer path is left to the host`() {
        val request = MockHttpServletRequest("POST", "/__ashurbanipal/api/tables")
        val result = MultipartExceptionResolver(ViewerMount("/__ashurbanipal"))
            .resolveException(request, MockHttpServletResponse(), null, MultipartException("x"))
        assertNull(result)
    }

    @Test
    fun `a host path under the mount is left alone`() {
        val (result, _) = resolve("/__ashurbanipal/upload", MultipartException("x"))
        assertNull(result)
    }

    @Test
    fun `other exceptions under the base path are left alone`() {
        val (result, _) = resolve("/__ashurbanipal/api/sources", IllegalStateException("x"))
        assertNull(result)
    }
}
