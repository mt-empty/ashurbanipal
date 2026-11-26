package io.github.mtempty.ashurbanipal

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping
import java.net.Socket

/**
 * The viewer never changes a host route, with the `Host` check on
 * (`spec/protocol.md` §3, `spec/fixtures/host-routes-untouched.json`). Raw
 * sockets, because Java's HTTP clients won't send a chosen `Host`.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    classes = [HostRoutesUntouchedHttpTest.HostApp::class],
)
class HostRoutesUntouchedHttpTest : AshurbanipalHttpTestBase() {
    @SpringBootApplication(scanBasePackages = ["io.github.mtempty.ashurbanipal.hostroutes"])
    class HostApp

    companion object {
        private const val PREFIX = "/ctx/app"
        private const val MOUNT = "/__ashurbanipal"

        @JvmStatic
        @DynamicPropertySource
        fun hostProperties(registry: DynamicPropertyRegistry) {
            registry.add("server.servlet.context-path") { "/ctx" }
            registry.add("spring.mvc.servlet.path") { "/app" }
            registry.add("ashurbanipal.allowed-hosts") { "localhost" }
        }
    }

    @Autowired
    @Qualifier("requestMappingHandlerMapping")
    private lateinit var mappings: RequestMappingHandlerMapping

    private val fixture = CatalogFixture.read("host-routes-untouched.json")

    private fun send(method: String, path: String, host: String): Pair<Int, String> =
        Socket("127.0.0.1", port).use { socket ->
            socket.getOutputStream().write(
                "$method $PREFIX$path HTTP/1.1\r\nHost: $host\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray(),
            )
            val response = socket.getInputStream().bufferedReader().readText()
            response.lineSequence().first().split(" ")[1].toInt() to response.substringAfter("\r\n\r\n")
        }

    private fun check(key: String, status: Int, marker: String) {
        for (route in fixture[key].items()) {
            val method = route.text("method")
            val path = route.text("path").replace("{mount}", MOUNT)
            for (host in listOf("localhost:$port", "rebind.invalid")) {
                val (gotStatus, body) = send(method, path, host)
                assertThat(gotStatus).describedAs("$method $path from $host").isEqualTo(status)
                assertThat(body).describedAs("$method $path from $host").contains(marker)
            }
        }
    }

    @Test
    fun `host routes answer for every host`() = check("host_routes", 200, "host-route")

    @Test
    fun `unrouted requests get the host's own 404 for every host`() = check("unrouted", 404, "host-404")

    @Test
    fun `the filter's paths are the controller's`() {
        val controllerPaths = mappings.handlerMethods
            .filterValues { it.beanType == AshurbanipalController::class.java }
            .keys.flatMap { it.patternValues }
        val fixturePaths = fixture["viewer_paths"].strings().map { MOUNT + it }
        assertThat(controllerPaths).containsExactlyInAnyOrderElementsOf(fixturePaths)
        assertThat(ViewerMount(MOUNT).paths).containsExactlyInAnyOrderElementsOf(fixturePaths)
    }
}
