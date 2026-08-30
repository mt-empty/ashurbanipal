package io.github.mtempty.ashurbanipal

import org.springframework.boot.context.properties.ConfigurationProperties

private val VALID_BACKENDS = setOf("postgres", "mysql", "sqlite")

/** Config load fails outright on an unrecognized `backend` value. */
class InvalidBackendException(value: String) : RuntimeException(
    "ashurbanipal.backend must be one of $VALID_BACKENDS, got \"$value\""
)

/** Config load fails outright on a duplicate or blank source `name` — nothing else would catch the collision before it silently shadowed a source at lookup time. */
class InvalidSourceException(message: String) : RuntimeException(message)

/**
 * One browsable datasource: `name` is the opaque, host-chosen identifier
 * the `source` query param (`spec/protocol.md` §5.2–§5.5, §5.7) and the
 * frontend's source dropdown select it by — never the bean name itself,
 * since bean names aren't always presentable (`ordersDataSourceV2`).
 * `dataSourceBean` mirrors [AshurbanipalProperties]'s old top-level field:
 * null means "the primary/only [DataSource] bean in the context".
 */
data class Source(
    val name: String = "",
    val dataSourceBean: String? = null,
    val backend: String = "postgres",
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
    /**
     * Datasources this instance browses. A host with exactly one
     * `DataSource` bean can omit this entirely: an empty list means "one
     * implicit source named `default`, backend `postgres`, bound to the
     * primary/only bean" — [AshurbanipalAutoConfiguration] fills that in,
     * so single-datasource hosts see no config-shape change from before
     * this field existed.
     */
    val sources: List<Source> = emptyList(),
    val limits: Limits = Limits(),
    val siblings: List<Sibling> = emptyList(),
) {
    init {
        for (source in sources) {
            if (source.backend.lowercase() !in VALID_BACKENDS) {
                throw InvalidBackendException(source.backend)
            }
            if (source.name.isBlank()) {
                throw InvalidSourceException("every ashurbanipal.sources entry needs a non-blank name")
            }
        }
        val duplicates = sources.groupBy { it.name }.filterValues { it.size > 1 }.keys
        if (duplicates.isNotEmpty()) {
            throw InvalidSourceException("ashurbanipal.sources names must be unique, duplicated: $duplicates")
        }
    }

    val isEnabled: Boolean get() = enabled

    /** Never empty: the implicit single-source default when the host sets nothing. */
    val resolvedSources: List<Source> get() = sources.ifEmpty { listOf(Source(name = "default")) }
}

data class Limits(
    val defaultPageSize: Int = 50,
    val maxPageSize: Int = 100,
    val queryTimeoutSecs: Int = 5,
)

data class Sibling(
    val name: String = "",
    val baseUrl: String = "",
    val healthPath: String = "",
)
