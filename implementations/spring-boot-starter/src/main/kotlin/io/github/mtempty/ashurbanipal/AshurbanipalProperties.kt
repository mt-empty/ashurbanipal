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
    }

    /** What `/api/siblings` reports; never rejected, see [SiblingsView]. */
    val siblingsView: SiblingsView = buildSiblingsView()

    private fun buildSiblingsView(): SiblingsView {
        val warnings = mutableListOf<String>()
        val instance = instance?.takeIf { it.name.isNotEmpty() && it.label.isNotEmpty() }
        if (this.instance != null && instance == null) warnings += "instance needs a non-empty name and label; ignored"
        val copies = mutableMapOf<Pair<String, String?>, Int>()
        val siblings = siblings.map { configured ->
            val sibling = if (configured.label == "") {
                warnings += "sibling \"${configured.name}\" has an empty label; treated as unlabelled"
                configured.copy(label = null)
            } else {
                configured
            }
            val n = copies.merge(sibling.name to sibling.label, 1, Int::plus)
            if (n == 2) {
                warnings += if (sibling.label == null) {
                    "two siblings share the name \"${sibling.name}\" and no label"
                } else {
                    "two siblings share the name \"${sibling.name}\" and the label \"${sibling.label}\""
                }
            }
            sibling
        }
        return SiblingsView(instance, siblings, warnings)
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

/** The sibling config after `spec/protocol.md` §5.6's corrections, which never reject it: each one is reported in [warnings]. */
data class SiblingsView(val instance: Instance?, val siblings: List<Sibling>, val warnings: List<String>) {
    /** Whether [sibling] is this instance's own entry, reported healthy without a health check: it is serving the response. */
    fun isInstance(sibling: Sibling): Boolean =
        instance != null && sibling.name == instance.name && sibling.label == instance.label
}
