package io.github.mtempty.ashurbanipal.hostroutes

import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.servlet.resource.NoResourceFoundException

/** The host app's own routes from `spec/fixtures/host-routes-untouched.json`, with the viewer at `/__ashurbanipal`. */
@RestController
class HostRoutes {
    @GetMapping(
        "/health",
        "/api/orders",
        "/__ashurbanipalx",
        "/__ashurbanipal-admin",
        "/__ashurbanipal/other",
        "/__ashurbanipal/api",
        "/__ashurbanipal/api/orders",
        "/__ashurbanipal/api/tables/extra",
    )
    fun get() = "host-route"

    @PostMapping("/__ashurbanipal", "/__ashurbanipal/api/tables")
    fun post() = "host-route"

    @DeleteMapping("/__ashurbanipal/api/sources")
    fun delete() = "host-route"
}

/** The host app's own 404, so a test can tell it from the viewer's. */
@RestControllerAdvice
class HostNotFound {
    @ExceptionHandler(NoResourceFoundException::class)
    fun notFound(): ResponseEntity<String> = ResponseEntity.status(404).body("host-404")
}
