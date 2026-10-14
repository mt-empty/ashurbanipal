package io.github.mtempty.ashurbanipal

import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.core.Ordered
import org.springframework.http.HttpStatus
import org.springframework.web.multipart.MultipartException
import org.springframework.web.servlet.HandlerExceptionResolver
import org.springframework.web.servlet.ModelAndView
import tools.jackson.databind.json.JsonMapper

/**
 * DispatcherServlet parses a multipart `Content-Type` before choosing a
 * handler, so a boundary-less header throws ahead of any controller
 * `@ExceptionHandler`. Answers it as a malformed request (`spec/protocol.md`
 * §2), only under [basePath] and only when no host resolver has.
 */
class MultipartExceptionResolver(basePath: String) : HandlerExceptionResolver, Ordered {
    private val prefix = basePath.trimEnd('/')
    private val mapper = JsonMapper()

    override fun getOrder(): Int = Ordered.LOWEST_PRECEDENCE - 1

    override fun resolveException(
        request: HttpServletRequest,
        response: HttpServletResponse,
        handler: Any?,
        ex: Exception,
    ): ModelAndView? {
        if (ex !is MultipartException) return null
        val path = request.requestURI.removePrefix(request.contextPath)
        if (path != prefix && !path.startsWith("$prefix/")) return null

        val problem = ProblemDetails(
            title = "malformed multipart request",
            status = HttpStatus.BAD_REQUEST.value(),
            code = "invalid_parameter",
        )
        response.status = problem.status
        response.setHeader(PROTOCOL_HEADER, PROTOCOL_VERSION)
        response.characterEncoding = "UTF-8"
        response.contentType = "application/problem+json"
        response.writer.write(mapper.writeValueAsString(problem))
        return ModelAndView()
    }
}
