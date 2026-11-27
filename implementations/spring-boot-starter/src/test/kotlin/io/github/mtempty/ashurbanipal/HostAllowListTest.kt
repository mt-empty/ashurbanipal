package io.github.mtempty.ashurbanipal

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.runner.WebApplicationContextRunner
import org.springframework.boot.web.servlet.FilterRegistrationBean
import org.springframework.mock.web.MockFilterChain
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.mock.web.MockHttpServletResponse

/** The optional `Host` allow-list (`spec/protocol.md` §3.1). */
class HostAllowListTest {
    @Test
    fun `shared fixture cases`() {
        for (case in CatalogFixture.read("host-allow-list-tests.json")["cases"]) {
            val host = case["host"].takeUnless { it.isNull }?.asText()
            assertThat(HostAllowList(case["allowed_hosts"].strings()).allows(host)).describedAs(case.text("name")).isEqualTo(case["allowed"].asBoolean())
        }
    }

    @Test
    fun `warns when the list is absent and for each bad entry`() {
        assertThat(HostAllowList(emptyList()).warnings).singleElement().asString().contains("allowed_hosts is not set")
        val warnings = HostAllowList(listOf("http://localhost", "localhost/x", "*.example", "localhost:abc", "ok.example")).warnings
        assertThat(warnings).hasSize(4)
        assertThat(warnings[0]).contains("\"http://localhost\"")
    }

    private fun filterStatus(hosts: List<String>, headers: Map<String, String>): Int {
        val request = MockHttpServletRequest("GET", "/__ashurbanipal/api/tables")
        request.removeHeader("Host")
        headers.forEach { (name, value) -> request.addHeader(name, value) }
        val response = MockHttpServletResponse()
        val chain = MockFilterChain()
        HostAllowListFilter(HostAllowList(hosts)).doFilter(request, response, chain)
        return if (chain.request == null) response.status else 200
    }

    @Test
    fun `the filter rejects an unlisted Host with 404`() {
        val hosts = listOf("localhost")
        assertThat(filterStatus(hosts, mapOf("Host" to "rebind.invalid"))).isEqualTo(404)
        assertThat(filterStatus(hosts, mapOf("Host" to "rebind.invalid", "X-Forwarded-Host" to "localhost"))).isEqualTo(404)
        assertThat(filterStatus(hosts, emptyMap())).isEqualTo(404)
        assertThat(filterStatus(hosts, mapOf("Host" to "LOCALHOST:4000"))).isEqualTo(200)
    }

    private fun urlPatterns(vararg properties: String): Collection<String> {
        var patterns: Collection<String> = emptyList()
        WebApplicationContextRunner()
            .withUserConfiguration(AshurbanipalAutoConfiguration::class.java, TestDataSourceConfig::class.java)
            .withPropertyValues("ashurbanipal.enabled=true", "ashurbanipal.allowed-hosts=localhost", *properties)
            .run { context ->
                assertThat(context).hasNotFailed()
                patterns = context.getBean("ashurbanipalHostAllowListFilter", FilterRegistrationBean::class.java).urlPatterns
            }
        return patterns
    }

    private fun viewerPaths(mount: String) = listOf(mount) + VIEWER_API_PATHS.map { mount + it }

    @Test
    fun `the filter covers only the viewer's exact paths`() {
        assertThat(urlPatterns()).containsExactlyInAnyOrderElementsOf(viewerPaths("/__ashurbanipal"))
        assertThat(urlPatterns("ashurbanipal.base-path=/viewer/")).containsExactlyInAnyOrderElementsOf(viewerPaths("/viewer"))
    }

    @Test
    fun `the filter follows the DispatcherServlet's own path`() {
        assertThat(urlPatterns("spring.mvc.servlet.path=/app"))
            .containsExactlyInAnyOrderElementsOf(viewerPaths("/app/__ashurbanipal"))
        assertThat(urlPatterns("spring.mvc.servlet.path=/app/", "ashurbanipal.base-path=viewer"))
            .containsExactlyInAnyOrderElementsOf(viewerPaths("/app/viewer"))
    }

    @Test
    fun `the filter is off without a list`() {
        WebApplicationContextRunner()
            .withUserConfiguration(AshurbanipalAutoConfiguration::class.java, TestDataSourceConfig::class.java)
            .withPropertyValues("ashurbanipal.enabled=true")
            .run { context ->
                val registration = context.getBean("ashurbanipalHostAllowListFilter", FilterRegistrationBean::class.java)
                assertThat(registration.isEnabled).isFalse()
            }
    }
}
