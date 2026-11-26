package io.github.mtempty.ashurbanipal.demo

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

/** A host route of the demo's own, which the conformance runner probes to show the `Host` check leaves it alone. */
@RestController
class HealthController {
    @GetMapping("/health")
    fun health() = "ok"
}
