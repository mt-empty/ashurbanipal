package io.github.mtempty.ashurbanipal

import jakarta.servlet.FilterChain
import jakarta.servlet.ServletException
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.web.filter.OncePerRequestFilter
import org.springframework.web.multipart.MultipartException

/**
 * DispatcherServlet parses a multipart `Content-Type` before routing, so a
 * boundary-less header throws `MultipartException` ahead of any controller
 * `@ExceptionHandler`. Answer it as a malformed request (`spec/protocol.md` §2).
 */
class MultipartGuardFilter : OncePerRequestFilter() {
    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
        try {
            chain.doFilter(request, response)
        } catch (e: ServletException) {
            if (generateSequence<Throwable>(e) { it.cause }.none { it is MultipartException }) throw e
            response.reset()
            response.status = HttpServletResponse.SC_BAD_REQUEST
            response.setHeader("x-ashurbanipal-protocol", "1")
            response.characterEncoding = "UTF-8"
            response.contentType = "application/problem+json"
            response.writer.write(
                """{"type":"about:blank","title":"malformed multipart request","status":400,"code":"invalid_parameter"}""",
            )
        }
    }
}
