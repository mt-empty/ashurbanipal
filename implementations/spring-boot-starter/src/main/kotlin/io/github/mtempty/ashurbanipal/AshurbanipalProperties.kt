package io.github.mtempty.ashurbanipal

import org.springframework.boot.context.properties.ConfigurationProperties

private val VALID_BACKENDS = setOf("postgres", "mysql", "sqlite")

/** Config load fails outright on an unrecognized `backend` value. */
class InvalidBackendException(value: String) : RuntimeException(
    "ashurbanipal.backend must be one of $VALID_BACKENDS, got \"$value\""
)

/** Rejects invalid source names before lookup (`spec/protocol.md` §1). */
class InvalidSourceException(message: String) : RuntimeException(message)

/** Rejects an invalid `instance` or sibling `label` (`spec/protocol.md` §5.6). */
class InvalidSiblingException(message: String) : RuntimeException(message)

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
    val instance: Instance? = null,
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
        if (enabled) validateSiblings()
    }

    private fun validateSiblings() {
        if (instance != null && (instance.name.isEmpty() || instance.label.isEmpty())) {
            throw InvalidSiblingException("ashurbanipal.instance needs a non-empty name and label")
        }
        siblings.firstOrNull { it.label == "" }?.let {
            throw InvalidSiblingException("ashurbanipal.siblings entry \"${it.name}\" has an empty label; omit it instead")
        }
        val duplicates = siblings.groupBy { it.name to it.label }.filterValues { it.size > 1 }.keys
        if (duplicates.isNotEmpty()) {
            throw InvalidSiblingException("ashurbanipal.siblings name and label pairs must be unique, duplicated: $duplicates")
        }
    }

    /** Whether [sibling] is this instance's own entry, reported healthy without a health check: it is serving the response. */
    fun isInstance(sibling: Sibling): Boolean =
        instance != null && sibling.name == instance.name && sibling.label == instance.label

    val isEnabled: Boolean get() = enabled

    /** Never empty: falls back to `default` (`spec/protocol.md` §1). */
    val resolvedSources: List<Source> get() = sources.ifEmpty { listOf(Source(name = "default")) }
}

data class Limits(
    val defaultPageSize: Int = 50,
    val maxPageSize: Int = 100,
    val queryTimeoutSecs: Int = 5,
)

/** This instance's own name and label. Labels are opaque host strings: echoed, never parsed or acted on (`spec/protocol.md` §4). */
data class Instance(
    val name: String = "",
    val label: String = "",
)

/** `label` is last so a positional `Sibling(name, baseUrl, healthPath)` keeps its meaning. */
data class Sibling(
    val name: String = "",
    val baseUrl: String = "",
    val healthPath: String = "",
    val label: String? = null,
)
