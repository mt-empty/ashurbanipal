package io.github.mtempty.ashurbanipal

import org.springframework.core.env.Environment

/** The ten API routes, relative to the mount (`spec/protocol.md` §3). */
internal val VIEWER_API_PATHS = listOf(
    "/api/sources",
    "/api/schemas",
    "/api/tables",
    "/api/table-counts",
    "/api/tables/data",
    "/api/tables/common-values",
    "/api/tables/referenced-by",
    "/api/tables/structure",
    "/api/tables/join",
    "/api/siblings",
)

/**
 * Where the viewer sits below the context path, and its exact paths. Never a
 * prefix match: a host route beside, under or at the root of the mount
 * stays the host's (`spec/protocol.md` §3).
 */
internal class ViewerMount(
    /** Without a trailing slash; `""` for a root mount with no servlet path. */
    val path: String,
    /** A root `base-path`: deprecated, refused in a later release. */
    val root: Boolean = false,
) {
    /** `""` is the servlet pattern for exactly the context root. */
    val paths: List<String> = when {
        path.isEmpty() -> listOf("")
        root -> listOf(path, "$path/")
        else -> listOf(path)
    } + VIEWER_API_PATHS.map { path + it }

    /** [requestPath] is below the context path. */
    fun owns(requestPath: String): Boolean = requestPath in paths || (path.isEmpty() && requestPath == "/")

    companion object {
        /** The controller sits under the DispatcherServlet's own `spring.mvc.servlet.path`, which servlet paths include. */
        fun of(environment: Environment, basePath: String): ViewerMount {
            val servletPath = environment.getProperty("spring.mvc.servlet.path", "/").trimEnd('/')
            val base = basePath.trim('/')
            return ViewerMount(if (base.isEmpty()) servletPath else "$servletPath/$base", root = base.isEmpty())
        }
    }
}
