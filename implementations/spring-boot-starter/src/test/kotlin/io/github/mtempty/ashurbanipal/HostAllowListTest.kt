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
    fun `matching follows the entry rules`() {
        val cases = listOf(
            Triple(listOf(), "anything.example", true),
            Triple(listOf(), null, true),
            Triple(listOf("billing.internal"), "billing.internal", true),
            Triple(listOf("billing.internal"), "billing.internal:4000", true),
            Triple(listOf("billing.internal"), "evil.example", false),
            Triple(listOf("billing.internal"), "billing.internal.evil.example", false),
            Triple(listOf("billing.internal:4000"), "billing.internal:4000", true),
            Triple(listOf("billing.internal:4000"), "billing.internal", false),
            Triple(listOf("billing.internal:4000"), "billing.internal:4001", false),
            Triple(listOf("Billing.Internal"), "BILLING.internal:4000", true),
            Triple(listOf("billing.internal"), "billing.internal.", true),
            Triple(listOf("billing.internal"), "billing.internal.:4000", true),
            Triple(listOf("other.internal."), "other.internal", true),
            Triple(listOf("localhost"), ".", false),
            Triple(listOf("billing.internal"), "billing.internal..", false),
            Triple(listOf("[::1]:4000"), "[::1]:4000", true),
            Triple(listOf("[::1]:4000"), "[::1]:4001", false),
            Triple(listOf("[fe80::1]"), "[FE80::1]:80", true),
            Triple(listOf("[::1]"), "::1", false),
            Triple(listOf("localhost"), null, false),
            Triple(listOf("localhost"), "", false),
            Triple(listOf("localhost"), "localhost:", false),
            Triple(listOf("localhost"), "localhost:99999", false),
            Triple(listOf("localhost"), "localhost:80x", false),
            Triple(listOf("localhost"), "user@localhost", false),
            Triple(listOf("localhost"), "localhost/path", false),
            Triple(listOf("localhost"), "local host", false),
            Triple(listOf("http://localhost"), "localhost", false),
            Triple(listOf("http://localhost", "ok.example"), "ok.example", true),
        )
        for ((entries, host, want) in cases) {
            assertThat(HostAllowList(entries).allows(host)).describedAs("entries %s, Host %s", entries, host).isEqualTo(want)
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

    @Test
    fun `the filter covers only the mount`() {
        assertThat(urlPatterns()).containsExactlyInAnyOrder("/__ashurbanipal", "/__ashurbanipal/*")
        assertThat(urlPatterns("ashurbanipal.base-path=/viewer/")).containsExactlyInAnyOrder("/viewer", "/viewer/*")
    }

    @Test
    fun `the filter follows the DispatcherServlet's own path`() {
        assertThat(urlPatterns("spring.mvc.servlet.path=/app"))
            .containsExactlyInAnyOrder("/app/__ashurbanipal", "/app/__ashurbanipal/*")
        assertThat(urlPatterns("spring.mvc.servlet.path=/app/", "ashurbanipal.base-path=viewer"))
            .containsExactlyInAnyOrder("/app/viewer", "/app/viewer/*")
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

    @Test
    fun `a root mount never covers the host's other routes`() {
        assertThat(urlPatterns("ashurbanipal.base-path=/")).containsExactlyInAnyOrder("", "/api/*")
        assertThat(urlPatterns("ashurbanipal.base-path=/", "spring.mvc.servlet.path=/app"))
            .containsExactlyInAnyOrder("/app", "/app/*")
    }
}
