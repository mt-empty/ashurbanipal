package io.github.mtempty.ashurbanipal

import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.web.filter.OncePerRequestFilter

private val IPV6 = Regex("""\[[0-9A-Fa-f:.]+]""")
private val REG_NAME = Regex("""[A-Za-z0-9._-]+""")
private val PORT = Regex("""[0-9]{1,5}""")

/** `name` is lowercased; an IPv6 literal keeps its brackets. */
private data class HostPort(val name: String, val port: Int?)

/**
 * The optional `Host` allow-list against DNS rebinding (`spec/protocol.md`
 * §3.1). With no entries the check is off. Entries that fail to parse are
 * dropped, so a list of only bad entries is still on and rejects everything.
 */
class HostAllowList(hosts: List<String>) {
    val active: Boolean = hosts.isNotEmpty()
    val warnings: List<String>
    private val entries: List<HostPort>

    init {
        val warned = mutableListOf<String>()
        if (!active) {
            warned += "allowed_hosts is not set, so any Host header is accepted and a " +
                "DNS-rebinding page can read the viewer (spec/protocol.md §3.1)"
        }
        entries = hosts.mapNotNull { entry ->
            parseHostPort(entry).also {
                if (it == null) {
                    warned += "allowed_hosts entry \"$entry\" is not a host name with an optional port, " +
                        "so it matches nothing"
                }
            }
        }
        warnings = warned
    }

    /** [host] is the raw `Host` header, never a forwarded one; with the check on, a missing or malformed one is rejected. */
    fun allows(host: String?): Boolean {
        if (!active) return true
        val request = host?.let(::parseHostPort) ?: return false
        return entries.any { it.name == request.name && (it.port == null || it.port == request.port) }
    }
}

/** `name` or `name:port`, with an IPv6 literal in brackets; one trailing dot on the name is dropped. No scheme, path, userinfo or wildcard. */
private fun parseHostPort(text: String): HostPort? {
    val name: String
    val port: String?
    if (text.startsWith("[")) {
        val end = text.indexOf(']')
        if (end < 0) return null
        name = text.substring(0, end + 1)
        val rest = text.substring(end + 1)
        if (!IPV6.matches(name)) return null
        if (rest.isNotEmpty() && !rest.startsWith(":")) return null
        port = if (rest.isEmpty()) null else rest.substring(1)
    } else {
        // billing.internal. is the same DNS name as billing.internal.
        name = text.substringBefore(':').removeSuffix(".")
        port = if (':' in text) text.substringAfter(':') else null
        if (!REG_NAME.matches(name)) return null
    }
    if (port == null) return HostPort(name.lowercase(), null)
    if (!PORT.matches(port) || port.toInt() > 65535) return null
    return HostPort(name.lowercase(), port.toInt())
}

/**
 * Registered only for the mount's own paths, so it runs before anything else
 * there and never sees the host's other routes. A rejected request gets the
 * container's 404, the same as an unmounted path.
 */
class HostAllowListFilter(private val hosts: HostAllowList) : OncePerRequestFilter() {
    init {
        hosts.warnings.forEach { logger.warn("ashurbanipal: $it") }
    }

    // getHeader, not getServerName: that follows forwarded headers under
    // server.forward-headers-strategy.
    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
        if (hosts.allows(request.getHeader("Host"))) {
            chain.doFilter(request, response)
        } else {
            response.sendError(HttpServletResponse.SC_NOT_FOUND)
        }
    }
}
