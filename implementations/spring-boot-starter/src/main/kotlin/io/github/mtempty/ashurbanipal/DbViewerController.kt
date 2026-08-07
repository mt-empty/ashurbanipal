package io.github.mtempty.ashurbanipal

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

private const val PROTOCOL_HEADER = "x-ashurbanipal-protocol"

/** Bumped only for non-additive wire changes; additive optional fields keep the same version (spec/protocol.md §7). Value must track implementations/rust/src/routes.rs's PROTOCOL_VERSION constant. */
private const val PROTOCOL_VERSION = "1"

data class SchemasResponse(val schemas: List<String>)
data class TablesResponse(val tables: List<TableInfo>)
data class CountsResponse(val counts: List<CountEntry>)
data class TableDataResponse(
    val columns: List<ColumnInfo>,
    val rows: List<LinkedHashMap<String, String?>>,
    @JsonProperty("total_approx") val totalApprox: Long,
)
data class CommonValuesResponse(val values: List<CommonValueEntry>)
data class SiblingStatus(val name: String, @JsonProperty("dbviewer_url") val dbviewerUrl: String, val healthy: Boolean)
data class SiblingsResponse(val siblings: List<SiblingStatus>)

/**
 * `@RestController` on `${ashurbanipal.base-path:/__ashurbanipal}`: the HTML
 * route (classpath resource, `text/html`, no protocol header — spec/protocol.md
 * §5.1/§7 only require the header on the five API routes) plus the five API
 * routes, response shapes from `spec/openapi.yaml`. The
 * `":/__ashurbanipal"` default here intentionally duplicates
 * [AshurbanipalProperties]'s own default of the same value — a `@Bean`-built
 * controller's `@RequestMapping` can only use a property placeholder that
 * resolves even when the host never sets `ashurbanipal.base-path` at all, so
 * it can't just reference the properties object's own default.
 */
@RestController
@RequestMapping("\${ashurbanipal.base-path:/__ashurbanipal}")
class DbViewerController(
    private val properties: AshurbanipalProperties,
    private val catalog: DbSource,
    private val filterValidator: FilterValidator,
    private val httpClient: HttpClient,
) {
    private val dbviewerHtml: ByteArray by lazy {
        ClassPathResource("ashurbanipal/dbviewer.html").inputStream.use { it.readBytes() }
    }

    @GetMapping(produces = [MediaType.TEXT_HTML_VALUE])
    fun serveHtml(): ResponseEntity<ByteArray> =
        ResponseEntity.ok().contentType(MediaType.TEXT_HTML).body(dbviewerHtml)

    @GetMapping("/api/schemas")
    fun listSchemas(): ResponseEntity<SchemasResponse> =
        apiOk(SchemasResponse(catalog.listSchemas()))

    @GetMapping("/api/tables")
    fun listTables(@RequestParam(required = false) schema: String?): ResponseEntity<TablesResponse> =
        apiOk(TablesResponse(catalog.listTables(schema)))

    @GetMapping("/api/table-counts")
    fun tableCounts(@RequestParam(required = false) schema: String?): ResponseEntity<CountsResponse> =
        apiOk(CountsResponse(catalog.tableCounts(schema)))

    @GetMapping("/api/tables/data")
    fun tableData(
        @RequestParam(required = false) schema: String?,
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
            else -> throw FilterException("invalid order \"$order\" (expected \"asc\" or \"desc\")")
        }

        val data = catalog.queryTable(
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

    @GetMapping("/api/tables/common-values")
    fun commonValues(
        @RequestParam(required = false) schema: String?,
        @RequestParam table: String,
        @RequestParam column: String,
    ): ResponseEntity<CommonValuesResponse> =
        apiOk(CommonValuesResponse(catalog.commonValues(schema, table, column)))

    @GetMapping("/api/siblings")
    fun siblings(): ResponseEntity<SiblingsResponse> {
        val checks: List<CompletableFuture<SiblingStatus>> = properties.siblings.map { sibling ->
            checkHealth(sibling)
        }
        val statuses = CompletableFuture.allOf(*checks.toTypedArray())
            .thenApply { checks.map { it.join() } }
            .join()
        return apiOk(SiblingsResponse(statuses))
    }

    private fun checkHealth(sibling: Sibling): CompletableFuture<SiblingStatus> {
        val healthUrl = healthUrl(sibling.dbviewerUrl, sibling.healthPath)
            ?: return CompletableFuture.completedFuture(SiblingStatus(sibling.name, sibling.dbviewerUrl, false))
        val request = try {
            HttpRequest.newBuilder(URI(healthUrl)).timeout(Duration.ofSeconds(3)).GET().build()
        } catch (e: Exception) {
            return CompletableFuture.completedFuture(SiblingStatus(sibling.name, sibling.dbviewerUrl, false))
        }
        return httpClient.sendAsync(request, HttpResponse.BodyHandlers.discarding())
            .handle { response, _ -> SiblingStatus(sibling.name, sibling.dbviewerUrl, response != null && response.statusCode() in 200..299) }
    }

    // ==================== plumbing ====================

    private fun <T : Any> apiOk(body: T): ResponseEntity<T> =
        ResponseEntity.ok().header(PROTOCOL_HEADER, PROTOCOL_VERSION).body(body)

    private fun errorResponse(status: HttpStatus, message: String): ResponseEntity<String> =
        ResponseEntity.status(status)
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION)
            .contentType(MediaType.TEXT_PLAIN)
            .body(message)

    @ExceptionHandler(FilterException::class)
    fun handleFilterError(e: FilterException): ResponseEntity<String> =
        errorResponse(HttpStatus.BAD_REQUEST, e.message ?: "bad request")

    @ExceptionHandler(NotAllowedException::class)
    fun handleNotAllowedError(e: NotAllowedException): ResponseEntity<String> =
        errorResponse(HttpStatus.BAD_REQUEST, e.message ?: "bad request")

    @ExceptionHandler(MissingServletRequestParameterException::class)
    fun handleMissingParam(e: MissingServletRequestParameterException): ResponseEntity<String> =
        errorResponse(HttpStatus.BAD_REQUEST, e.message)

    @ExceptionHandler(MethodArgumentTypeMismatchException::class)
    fun handleTypeMismatch(e: MethodArgumentTypeMismatchException): ResponseEntity<String> =
        errorResponse(HttpStatus.BAD_REQUEST, e.message)

    @ExceptionHandler(DataAccessException::class)
    fun handleDatabaseError(e: DataAccessException): ResponseEntity<String> =
        errorResponse(HttpStatus.INTERNAL_SERVER_ERROR, "database error: ${e.message}")

    // A query string the servlet container itself can't parse (e.g. a stray
    // `=value` with no parameter name) surfaces here as an IllegalStateException
    // thrown while Spring resolves @RequestParam, before any handler method
    // body runs — a malformed request from the client, not a server fault, so
    // it must not fall through to the 500 catch-all below.
    @ExceptionHandler(IllegalStateException::class)
    fun handleMalformedQueryString(e: IllegalStateException): ResponseEntity<String> =
        errorResponse(HttpStatus.BAD_REQUEST, "malformed query string")

    @ExceptionHandler(Exception::class)
    fun handleUnexpectedError(e: Exception): ResponseEntity<String> =
        errorResponse(HttpStatus.INTERNAL_SERVER_ERROR, e.message ?: "internal error")
}

/**
 * `spec/protocol.md` §5.4 requires `limit`/`offset` to be clamped, never
 * rejected, for any out-of-range value. Binding them as `Int?`/`Long?`
 * `@RequestParam`s would let Spring's own type conversion reject an
 * out-of-Int/Long-range value with 400 before this code ever runs — the same
 * trap `implementations/rust/src/routes.rs`'s `deserialize_saturating_u32`
 * exists to avoid on the Rust side, just tripped by Spring's eager argument
 * binding instead of axum's `Query` extractor. Binding both as raw `String?`
 * and parsing with `BigInteger` here sidesteps it: only genuinely
 * non-numeric text (`"abc"`, `"1.5"`, `""`) 400s; anything else saturates
 * into `[0, Long.MAX_VALUE]` and gets clamped by the caller.
 */
private fun parseSaturating(raw: String?): Long? {
    if (raw == null) return null
    val trimmed = raw.trim()
    val big = try {
        BigInteger(trimmed)
    } catch (e: NumberFormatException) {
        throw FilterException("invalid integer parameter: \"$raw\"")
    }
    return big.coerceIn(BigInteger.ZERO, BigInteger.valueOf(Long.MAX_VALUE)).toLong()
}

/** Resolves against the sibling's origin, not the dbviewer path (spec/protocol.md §5.6). */
internal fun healthUrl(dbviewerUrl: String, healthPath: String): String? {
    return try {
        val uri = URI(dbviewerUrl)
        val scheme = uri.scheme ?: return null
        val host = uri.host ?: return null
        val portPart = if (uri.port != -1) ":${uri.port}" else ""
        "$scheme://$host$portPart$healthPath"
    } catch (e: Exception) {
        null
    }
}
