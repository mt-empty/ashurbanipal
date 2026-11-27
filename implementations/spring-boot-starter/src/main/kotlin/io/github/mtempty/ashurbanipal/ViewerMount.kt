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

/** A root `base-path` would take `/` and `/api/...` from the host (`spec/protocol.md` §3). */
class InvalidBasePathException(message: String) : RuntimeException(message)

/**
 * Where the viewer sits below the context path, and its exact paths. Never a
 * prefix match: a host route beside or under the mount stays the host's
 * (`spec/protocol.md` §3).
 */
internal class ViewerMount(
    /** Without a trailing slash; never empty, since a root `base-path` fails startup. */
    val path: String,
) {
    val paths: List<String> = listOf(path) + VIEWER_API_PATHS.map { path + it }

    /** [requestPath] is below the context path. */
    fun owns(requestPath: String): Boolean = requestPath in paths

    companion object {
        /**
         * The controller sits under the DispatcherServlet's own `spring.mvc.servlet.path`, which servlet paths include.
         * Only enabled beans call this, so a disabled viewer with a root `base-path` still starts.
         */
        fun of(environment: Environment, basePath: String): ViewerMount {
            val base = basePath.trim('/')
            if (base.isEmpty()) {
                throw InvalidBasePathException(
                    "ashurbanipal.base-path must not be the root: it would take / and /api/... from the host app; " +
                        "mount the viewer under a path of its own (spec/protocol.md §3)",
                )
            }
            val servletPath = environment.getProperty("spring.mvc.servlet.path", "/").trimEnd('/')
            return ViewerMount("$servletPath/$base")
        }
    }
}
