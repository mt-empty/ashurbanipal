package io.github.mtempty.ashurbanipal

import org.springframework.boot.context.properties.ConfigurationProperties

/** Case-insensitive; `production` itself is deliberately not representable in `enabledFor`. */
private val PRODUCTION_ALIASES = setOf("production", "prod", "prd", "live")

private fun isProductionLike(value: String): Boolean =
    PRODUCTION_ALIASES.any { it.equals(value, ignoreCase = true) }

/** Config load fails outright rather than silently ignoring the value — mirrors `Config::validate` (implementations/rust/core/src/config.rs). */
class ProductionEnabledException(value: String) : RuntimeException(
    "ashurbanipal must never be enabled in production: `enabled-for` contains \"$value\""
)

private val VALID_BACKENDS = setOf("postgres", "mysql", "sqlite")

/** Config load fails outright on an unrecognized `backend` value, same fail-fast treatment as [ProductionEnabledException]. */
class InvalidBackendException(value: String) : RuntimeException(
    "ashurbanipal.backend must be one of $VALID_BACKENDS, got \"$value\""
)

/**
 * Mirrors the Rust TOML config 1:1. Absent config binds every field to its
 * default here, which makes [isEnabled] false (`enabledFor` defaults to
 * empty) — the no-config case is disabled by construction, not by a
 * separate check.
 */
@ConfigurationProperties(prefix = "ashurbanipal")
class AshurbanipalProperties(
    val environment: String = "",
    val enabledFor: List<String> = emptyList(),
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
        for (value in enabledFor) {
            if (isProductionLike(value)) {
                throw ProductionEnabledException(value)
            }
        }
        if (backend.lowercase() !in VALID_BACKENDS) {
            throw InvalidBackendException(backend)
        }
    }

    /** `any` matches every environment except production-like ones. */
    val isEnabled: Boolean
        get() {
            if (isProductionLike(environment)) return false
            return enabledFor.any { it.equals("any", ignoreCase = true) || it.equals(environment, ignoreCase = true) }
        }

    companion object {
        fun productionLike(value: String) = isProductionLike(value)
    }
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
