package io.github.mtempty.ashurbanipal

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.annotation.JsonProperty
import org.springframework.core.io.ClassPathResource
import org.springframework.dao.DataAccessException
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.MissingServletRequestParameterException
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException
import java.math.BigInteger
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.CompletableFuture

internal const val PROTOCOL_HEADER = "x-ashurbanipal-protocol"

/** Bumped only for non-additive wire changes (spec/protocol.md §7). */
internal const val PROTOCOL_VERSION = "1"

/** Stops a browser from rendering echoed request text in a JSON error as HTML. */
internal const val NOSNIFF_HEADER = "X-Content-Type-Options"

data class SourceEntry(val name: String)
data class SourcesResponse(val sources: List<SourceEntry>)
data class SchemasResponse(val schemas: List<String>)
data class TablesResponse(val tables: List<TableInfo>)
data class CountsResponse(val counts: List<CountEntry>)
data class TableDataResponse(
    val columns: List<ColumnInfo>,
    val rows: List<LinkedHashMap<String, String?>>,
    @JsonProperty("total_approx") val totalApprox: Long,
)
data class CommonValuesResponse(val values: List<CommonValueEntry>)
data class ReferencedByResponse(@JsonProperty("referenced_by") val referencedBy: List<ReferencedByEntry>)
data class SiblingStatus(
    val name: String,
    @JsonInclude(JsonInclude.Include.NON_NULL) val label: String?,
    @JsonProperty("base_url") val baseUrl: String,
    val healthy: Boolean,
)
data class SiblingsResponse(
    @JsonInclude(JsonInclude.Include.NON_NULL) val instance: Instance?,
    val siblings: List<SiblingStatus>,
)

/**
 * `@RestController` on `${ashurbanipal.base-path:/__ashurbanipal}`: the HTML
 * route (classpath resource, `text/html`, no protocol header — spec/protocol.md
 * §5.1/§7 only require the header on the API routes) plus the API
 * routes, response shapes from `spec/openapi.yaml`. The
 * `":/__ashurbanipal"` default here intentionally duplicates
 * [AshurbanipalProperties]'s own default of the same value — a `@Bean`-built
 * controller's `@RequestMapping` can only use a property placeholder that
 * resolves even when the host never sets `ashurbanipal.base-path` at all, so
 * it can't just reference the properties object's own default.
 */
@RestController
@RequestMapping("\${ashurbanipal.base-path:/__ashurbanipal}")
class AshurbanipalController(
    private val properties: AshurbanipalProperties,
    private val dbSources: Map<String, DbSource>,
    private val filterValidator: FilterValidator,
    private val httpClient: HttpClient,
) {
    private val dbviewerHtml: ByteArray by lazy {
        ClassPathResource("ashurbanipal/dbviewer.html").inputStream.use { it.readBytes() }
    }

    /** Absent means the first-registered default; present requires an exact match (spec/protocol.md §1). */
    private fun resolveSource(name: String?): DbSource =
        if (name == null) dbSources.values.first()
        else dbSources[name] ?: throw NotAllowedException("source \"$name\"", NotAllowedKind.SOURCE)

    @GetMapping(produces = [MediaType.TEXT_HTML_VALUE])
    fun serveHtml(): ResponseEntity<ByteArray> =
        ResponseEntity.ok().contentType(MediaType.TEXT_HTML).body(dbviewerHtml)

    @GetMapping("/api/sources")
    fun listSources(): ResponseEntity<SourcesResponse> =
        apiOk(SourcesResponse(dbSources.keys.map { SourceEntry(it) }))

    @GetMapping("/api/schemas")
    fun listSchemas(@RequestParam(required = false) source: String?): ResponseEntity<SchemasResponse> =
        apiOk(SchemasResponse(resolveSource(source).listSchemas()))

    @GetMapping("/api/tables")
    fun listTables(
        @RequestParam(required = false) schema: String?,
        @RequestParam(required = false) source: String?,
    ): ResponseEntity<TablesResponse> =
        apiOk(TablesResponse(resolveSource(source).listTables(schema)))

    @GetMapping("/api/table-counts")
    fun tableCounts(
        @RequestParam(required = false) schema: String?,
        @RequestParam(required = false) source: String?,
    ): ResponseEntity<CountsResponse> =
        apiOk(CountsResponse(resolveSource(source).tableCounts(schema)))

    @GetMapping("/api/tables/data")
    fun tableData(
        @RequestParam(required = false) schema: String?,
        @RequestParam(required = false) source: String?,
        @RequestParam table: String,
        @RequestParam(required = false) filter: String?,
        @RequestParam(required = false) limit: String?,
        @RequestParam(required = false) offset: String?,
        @RequestParam(required = false) sort: String?,
        @RequestParam(required = false) order: String?,
    ): ResponseEntity<TableDataResponse> {
        // Empty (or whitespace-only) means "no filter", same as an absent
        // param; a valid-but-empty JSON array means the same thing
        // (spec/protocol.md §5.4.2).
        val conditions = filter?.takeIf { it.isNotBlank() }?.let { filterValidator.parse(it) }?.takeIf { it.isNotEmpty() }

        val limits = properties.limits
        val requestedLimit = parseSaturating(limit)
        val effectiveLimit = (requestedLimit ?: limits.defaultPageSize.toLong())
            .coerceIn(1L, limits.maxPageSize.toLong())
        val effectiveOffset = parseSaturating(offset) ?: 0L

        val descending = when (order) {
            null, "asc" -> false
            "desc" -> true
            else -> throw BadParameterException("invalid order \"$order\" (expected \"asc\" or \"desc\")")
        }

        val data = resolveSource(source).queryTable(
            schema,
            table,
            QueryOpts(
                limit = effectiveLimit,
                offset = effectiveOffset,
                sort = sort,
                descending = descending,
                filter = conditions,
            ),
        )
        return apiOk(TableDataResponse(data.columns, data.rows, data.totalApprox))
    }

    @GetMapping("/api/tables/join")
    fun tableJoin(
        @RequestParam(required = false) schema: String?,
        @RequestParam(required = false) source: String?,
        @RequestParam join: String,
        @RequestParam(required = false) filter: String?,
        @RequestParam(required = false) limit: String?,
        @RequestParam(required = false) offset: String?,
        @RequestParam(required = false) sort: String?,
        @RequestParam(name = "sort_join", required = false) sortJoin: String?,
        @RequestParam(required = false) order: String?,
    ): ResponseEntity<JoinData> {
        val spec = parseJoin(join)
        val conditions = filter?.takeIf { it.isNotBlank() }
            ?.let { filterValidator.parse(it, allowJoin = true) }
            ?.takeIf { it.isNotEmpty() }

        val limits = properties.limits
        val effectiveLimit = (parseSaturating(limit) ?: limits.defaultPageSize.toLong())
            .coerceIn(1L, limits.maxPageSize.toLong())
        val effectiveOffset = parseSaturating(offset) ?: 0L

        val descending = when (order) {
            null, "asc" -> false
            "desc" -> true
            else -> throw BadParameterException("invalid order \"$order\" (expected \"asc\" or \"desc\")")
        }
        val sortJoinPosition = sortJoin?.let {
            it.trim().toIntOrNull()?.takeIf { n -> n >= 0 }
                ?: throw BadParameterException("invalid sort_join \"$it\" (expected a table position)")
        }

        val data = resolveSource(source).queryJoin(
            schema,
            spec,
            JoinOpts(
                limit = effectiveLimit,
                offset = effectiveOffset,
                sort = sort?.takeIf { it.isNotEmpty() },
                sortJoin = sortJoinPosition,
                descending = descending,
                filter = conditions,
            ),
        )
        return apiOk(data)
    }

    @GetMapping("/api/tables/common-values")
    fun commonValues(
        @RequestParam(required = false) schema: String?,
        @RequestParam(required = false) source: String?,
        @RequestParam table: String,
        @RequestParam column: String,
    ): ResponseEntity<CommonValuesResponse> =
        apiOk(CommonValuesResponse(resolveSource(source).commonValues(schema, table, column)))

    @GetMapping("/api/tables/referenced-by")
    fun referencedBy(
        @RequestParam(required = false) schema: String?,
        @RequestParam(required = false) source: String?,
        @RequestParam table: String,
    ): ResponseEntity<ReferencedByResponse> =
        apiOk(ReferencedByResponse(resolveSource(source).referencedBy(schema, table)))

    @GetMapping("/api/tables/structure")
    fun structure(
        @RequestParam(required = false) schema: String?,
        @RequestParam(required = false) source: String?,
        @RequestParam table: String,
    ): ResponseEntity<Structure> =
        apiOk(resolveSource(source).structure(schema, table))

    @GetMapping("/api/siblings")
    fun siblings(): ResponseEntity<SiblingsResponse> {
        val checks: List<CompletableFuture<SiblingStatus>> = properties.siblings.map { sibling ->
            checkHealth(sibling)
        }
        val statuses = CompletableFuture.allOf(*checks.toTypedArray())
            .thenApply { checks.map { it.join() } }
            .join()
        return apiOk(SiblingsResponse(properties.instance, statuses))
    }

    private fun checkHealth(sibling: Sibling): CompletableFuture<SiblingStatus> {
        if (properties.isInstance(sibling)) {
            return CompletableFuture.completedFuture(SiblingStatus(sibling.name, sibling.label, sibling.baseUrl, true))
        }
        val healthUrl = healthUrl(sibling.baseUrl, sibling.healthPath)
            ?: return CompletableFuture.completedFuture(SiblingStatus(sibling.name, sibling.label, sibling.baseUrl, false))
        val request = try {
            HttpRequest.newBuilder(URI(healthUrl)).timeout(Duration.ofSeconds(3)).GET().build()
        } catch (e: Exception) {
            return CompletableFuture.completedFuture(SiblingStatus(sibling.name, sibling.label, sibling.baseUrl, false))
        }
        return httpClient.sendAsync(request, HttpResponse.BodyHandlers.discarding())
            .handle { response, _ -> SiblingStatus(sibling.name, sibling.label, sibling.baseUrl, response != null && response.statusCode() in 200..299) }
    }

    // ==================== plumbing ====================

    private fun <T : Any> apiOk(body: T): ResponseEntity<T> =
        ResponseEntity.ok()
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION)
            .header(NOSNIFF_HEADER, "nosniff")
            .body(body)

    /** RFC 9457 Problem Details (`spec/protocol.md` §2). */
    private fun problemResponse(status: HttpStatus, code: String, title: String): ResponseEntity<ProblemDetails> =
        ResponseEntity.status(status)
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION)
            .header(NOSNIFF_HEADER, "nosniff")
            .contentType(MediaType.valueOf("application/problem+json"))
            .body(ProblemDetails(title = title, status = status.value(), code = code))

    @ExceptionHandler(FilterException::class)
    fun handleFilterError(e: FilterException): ResponseEntity<ProblemDetails> =
        problemResponse(HttpStatus.BAD_REQUEST, "invalid_filter", e.message ?: "bad request")

    @ExceptionHandler(BadParameterException::class)
    fun handleBadParameter(e: BadParameterException): ResponseEntity<ProblemDetails> =
        problemResponse(HttpStatus.BAD_REQUEST, "invalid_parameter", e.message ?: "bad request")

    @ExceptionHandler(NotAllowedException::class)
    fun handleNotAllowedError(e: NotAllowedException): ResponseEntity<ProblemDetails> =
        problemResponse(HttpStatus.BAD_REQUEST, e.kind.code, e.message ?: "bad request")

    @ExceptionHandler(MissingServletRequestParameterException::class)
    fun handleMissingParam(e: MissingServletRequestParameterException): ResponseEntity<ProblemDetails> =
        problemResponse(HttpStatus.BAD_REQUEST, "invalid_parameter", e.message)

    @ExceptionHandler(MethodArgumentTypeMismatchException::class)
    fun handleTypeMismatch(e: MethodArgumentTypeMismatchException): ResponseEntity<ProblemDetails> =
        problemResponse(HttpStatus.BAD_REQUEST, "invalid_parameter", e.message)

    @ExceptionHandler(BadJoinException::class)
    fun handleBadJoin(e: BadJoinException): ResponseEntity<ProblemDetails> =
        problemResponse(HttpStatus.BAD_REQUEST, "invalid_join", e.message ?: "bad request")

    @ExceptionHandler(DataAccessException::class)
    fun handleDatabaseError(e: DataAccessException): ResponseEntity<ProblemDetails> =
        if (isQueryTimeout(e)) queryTimeoutResponse()
        else problemResponse(HttpStatus.INTERNAL_SERVER_ERROR, "database_error", "database error: ${e.message}")

    private fun queryTimeoutResponse(): ResponseEntity<ProblemDetails> =
        problemResponse(HttpStatus.INTERNAL_SERVER_ERROR, "query_timeout", "query timed out")

    // A query string the servlet container itself can't parse (e.g. a stray
    // `=value` with no parameter name) surfaces here as an IllegalStateException
    // thrown while Spring resolves @RequestParam, before any handler method
    // body runs — a malformed request from the client, not a server fault, so
    // it must not fall through to the 500 catch-all below.
    @ExceptionHandler(IllegalStateException::class)
    fun handleMalformedQueryString(e: IllegalStateException): ResponseEntity<ProblemDetails> =
        problemResponse(HttpStatus.BAD_REQUEST, "invalid_parameter", "malformed query string")

    @ExceptionHandler(Exception::class)
    fun handleUnexpectedError(e: Exception): ResponseEntity<ProblemDetails> =
        if (isQueryTimeout(e)) queryTimeoutResponse()
        else problemResponse(HttpStatus.INTERNAL_SERVER_ERROR, "database_error", e.message ?: "internal error")
}

/** RFC 9457 Problem Details body (`spec/protocol.md` §2). */
data class ProblemDetails(
    @JsonProperty("type") val type: String = "about:blank",
    val title: String,
    val status: Int,
    val code: String,
)

/** Saturates numeric values before clamping; only non-numeric text is rejected (`spec/protocol.md` §5.4). */
private fun parseSaturating(raw: String?): Long? {
    if (raw == null) return null
    val trimmed = raw.trim()
    val big = try {
        BigInteger(trimmed)
    } catch (e: NumberFormatException) {
        throw BadParameterException("invalid integer parameter: \"$raw\"")
    }
    return big.coerceIn(BigInteger.ZERO, BigInteger.valueOf(Long.MAX_VALUE)).toLong()
}

/** Resolves against the sibling's origin, not its path (spec/protocol.md §5.6). */
internal fun healthUrl(baseUrl: String, healthPath: String): String? {
    return try {
        val uri = URI(baseUrl)
        val scheme = uri.scheme ?: return null
        val host = uri.host ?: return null
        val portPart = if (uri.port != -1) ":${uri.port}" else ""
        "$scheme://$host$portPart$healthPath"
    } catch (e: Exception) {
        null
    }
}
