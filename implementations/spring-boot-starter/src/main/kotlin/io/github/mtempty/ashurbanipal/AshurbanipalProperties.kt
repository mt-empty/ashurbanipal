package io.github.mtempty.ashurbanipal

import org.springframework.boot.context.properties.ConfigurationProperties

private val VALID_BACKENDS = setOf("postgres", "mysql", "sqlite")

/** Config load fails outright on an unrecognized `backend` value. */
class InvalidBackendException(value: String) : RuntimeException(
    "ashurbanipal.backend must be one of $VALID_BACKENDS, got \"$value\""
)

/** Rejects invalid source names before lookup (`spec/protocol.md` §1). */
class InvalidSourceException(message: String) : RuntimeException(message)

/** A named browsable data source (`spec/protocol.md` §1). */
data class Source(
    val name: String = "",
    val dataSourceBean: String? = null,
    val backend: String = "postgres",
)

/** Defaults to disabled (`spec/protocol.md` §4). */
@ConfigurationProperties(prefix = "ashurbanipal")
class AshurbanipalProperties(
    val enabled: Boolean = false,
    val basePath: String = "/__ashurbanipal",
    /** Empty resolves to the implicit `default` source (`spec/protocol.md` §1). */
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

    /** Never empty: falls back to `default` (`spec/protocol.md` §1). */
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
