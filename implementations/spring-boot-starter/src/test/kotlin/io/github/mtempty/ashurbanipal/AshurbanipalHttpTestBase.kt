package io.github.mtempty.ashurbanipal

import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.web.client.RestTemplate
import java.net.URI

/**
 * Shared HTTP-integration harness for tests that boot the starter as a real
 * Spring Boot app against the devcontainer's live Postgres — used by
 * [AshurbanipalIntegrationTest] and [MultiSourceTest]. A subclass adds its
 * own `ashurbanipal.*` properties (e.g. `ashurbanipal.sources[...]`) via its
 * own `@DynamicPropertySource` method: Spring collects these from the whole
 * class hierarchy, so a subclass's method layers on top of [baseProperties]
 * rather than replacing it.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    classes = [AshurbanipalHttpTestBase.TestApp::class],
)
abstract class AshurbanipalHttpTestBase {

    // scanBasePackages points at an empty package deliberately: TestApp lives
    // in the same package as DbViewerController, and @RestController is a
    // component stereotype — without this, component-scanning would register
    // a *second* DbViewerController bean alongside the one
    // AshurbanipalAutoConfiguration's @Bean method creates, both mapping the
    // same routes ("Ambiguous mapping"). A real host app wouldn't hit this
    // (its own base package doesn't contain io.github.mtempty.ashurbanipal),
    // so this is a test-harness-only workaround, not a starter design issue.
    @SpringBootApplication(scanBasePackages = ["io.github.mtempty.ashurbanipal.testapp"])
    class TestApp

    companion object {
        @JvmStatic
        @DynamicPropertySource
        fun baseProperties(registry: DynamicPropertyRegistry) {
            val databaseUrl = System.getenv("DATABASE_URL")
                ?: error("DATABASE_URL must be set (the devcontainer sets it automatically)")
            val uri = URI(databaseUrl)
            val (user, password) = (uri.userInfo ?: ":").split(":", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
            registry.add("spring.datasource.url") { "jdbc:postgresql://${uri.host}:${uri.port}${uri.path}" }
            registry.add("spring.datasource.username") { user }
            registry.add("spring.datasource.password") { password }
            registry.add("ashurbanipal.enabled") { "true" }
        }
    }

    @LocalServerPort
    protected var port: Int = 0

    protected val http = RestTemplate()
    protected val mapper = ObjectMapper()

    protected fun url(path: String) = "http://localhost:$port/__ashurbanipal$path"

    protected fun getJson(path: String): JsonNode = mapper.readTree(http.getForObject(url(path), String::class.java))
}
