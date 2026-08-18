package io.github.mtempty.ashurbanipal

import org.springframework.boot.context.properties.ConfigurationProperties

private val VALID_BACKENDS = setOf("postgres", "mysql", "sqlite")

/** Config load fails outright on an unrecognized `backend` value. */
class InvalidBackendException(value: String) : RuntimeException(
    "ashurbanipal.backend must be one of $VALID_BACKENDS, got \"$value\""
)

/**
 * Absent config binds every field to its default here, which makes
 * [isEnabled] false (`enabled` defaults to false) — the no-config case is
 * disabled by construction, not by a separate check. This starter has no
 * opinion on which environment it should run in; that's the host's call.
 */
@ConfigurationProperties(prefix = "ashurbanipal")
class AshurbanipalProperties(
    val enabled: Boolean = false,
    val basePath: String = "/__ashurbanipal",
    /** Bean name of the DataSource to use, for hosts with more than one. Null means "the primary/only one". */
    val dataSourceBean: String? = null,
    /**
     * Which [DbSource] implementation to construct — `postgres` (default),
     * `mysql` (covers MariaDB too, detected at runtime, mirrors
     * `implementations/rust/core/src/db/mysql.rs`'s `Variant` sniff), or
     * `sqlite`. Deliberately an explicit opt-in property, never inferred
     * from which JDBC driver happens to be on the host's classpath —
     * `PORTING.md`'s hardening checklist item 2 flags classpath-presence
     * autoconfiguration as this project's highest-risk default failure
     * mode ("found on the classpath -> sensible defaults -> turned on").
     */
    val backend: String = "postgres",
    val limits: Limits = Limits(),
    val siblings: List<Sibling> = emptyList(),
) {
    init {
        if (backend.lowercase() !in VALID_BACKENDS) {
            throw InvalidBackendException(backend)
        }
    }

    val isEnabled: Boolean get() = enabled
}

data class Limits(
    val defaultPageSize: Int = 50,
    val maxPageSize: Int = 100,
    val queryTimeoutSecs: Int = 5,
)

data class Sibling(
    val name: String = "",
    val dbviewerUrl: String = "",
    val healthPath: String = "",
)
