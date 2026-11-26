package io.github.mtempty.ashurbanipal

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import java.net.Socket

/**
 * The `Host` check on a real server whose viewer sits under a context path, a
 * DispatcherServlet path and a custom base path (`spec/protocol.md` §3.1).
 * Raw sockets, because Java's HTTP clients won't send a chosen `Host`.
 */
class HostAllowListHttpTest : AshurbanipalHttpTestBase() {
    companion object {
        @JvmStatic
        @DynamicPropertySource
        fun hostProperties(registry: DynamicPropertyRegistry) {
            registry.add("server.servlet.context-path") { "/ctx" }
            registry.add("spring.mvc.servlet.path") { "/app" }
            registry.add("ashurbanipal.base-path") { "/viewer" }
            registry.add("ashurbanipal.allowed-hosts") { "localhost" }
        }
    }

    private fun status(method: String, path: String, host: String): Int =
        Socket("127.0.0.1", port).use { socket ->
            socket.getOutputStream().write(
                "$method $path HTTP/1.1\r\nHost: $host\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray(),
            )
            socket.getInputStream().bufferedReader().readLine().split(" ")[1].toInt()
        }

    @Test
    fun `an unlisted Host gets 404 under a custom mount`() {
        for (path in listOf("/ctx/app/viewer", "/ctx/app/viewer/api/sources")) {
            assertThat(status("GET", path, "rebind.invalid")).describedAs(path).isEqualTo(404)
            assertThat(status("POST", path, "rebind.invalid")).describedAs("POST $path").isEqualTo(404)
            assertThat(status("GET", path, "localhost:$port")).describedAs(path).isEqualTo(200)
        }
    }
}
