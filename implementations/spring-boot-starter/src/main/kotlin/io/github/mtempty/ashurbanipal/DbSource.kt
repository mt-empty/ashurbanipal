package io.github.mtempty.ashurbanipal

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.annotation.JsonProperty

/** Table/column/schema not in the live allow-list; the controller maps this to 400 (`spec/protocol.md` §6 — no unvalidated identifier ever reaches SQL text). */
class NotAllowedException(message: String) : RuntimeException(message)

/**
 * Escapes an identifier for splicing into SQL text by doubling embedded `"`
 * (the standard Postgres/SQLite quoted-identifier escape) — every name
 * reaching this must already be allow-list-validated against a live catalog
 * lookup; this only makes a validated name syntactically safe to splice, it
 * is not itself a validation step (`spec/protocol.md` §6, mirrors
 * `implementations/rust/core/src/db/mod.rs::quote_ident`). MySQL's default quote
 * character is the backtick, not `"` — [MySqlSource] has its own
 * `quoteIdentMysql` rather than reusing this.
 */
internal fun quoteIdent(ident: String): String = "\"" + ident.replace("\"", "\"\"") + "\""

// `@JsonInclude(NON_NULL)` per optional field, not mapper-wide: a mapper-wide
// NON_NULL setting would also strip null *row cell* values (Map<String,
// String?> entries) elsewhere, which spec/protocol.md §5.4.3 requires to stay
// present as JSON null — optional metadata fields and row nulls need opposite
// treatment, so the mapper's default (include nulls) stays the baseline.
data class TableInfo(val name: String, @JsonInclude(JsonInclude.Include.NON_NULL) val comment: String? = null)
data class CountEntry(val table: String, @JsonProperty("approx_rows") val approxRows: Long)
data class ColumnRef(
    val table: String,
    val column: String,
    // Only set when the referenced table lives in a schema other than the
    // referencing column's own — same-schema FKs (the common case) omit it,
    // so the wire payload is unchanged from before this field existed
    // (additive, spec/protocol.md §7 versioning policy).
    @JsonInclude(JsonInclude.Include.NON_NULL) val schema: String? = null,
)
data class ColumnInfo(
    val name: String,
    val type: String,
    @JsonInclude(JsonInclude.Include.NON_NULL) val key: String? = null,
    @JsonInclude(JsonInclude.Include.NON_NULL) val references: ColumnRef? = null,
    @JsonInclude(JsonInclude.Include.NON_NULL) val comment: String? = null,
)
data class TableData(val columns: List<ColumnInfo>, val rows: List<LinkedHashMap<String, String?>>, val totalApprox: Long)
data class CommonValueEntry(val value: String, val freq: Float)

data class QueryOpts(
    val limit: Long,
    val offset: Long,
    val sort: String?,
    val descending: Boolean,
    val filter: List<Condition>?,
)

/**
 * Backend-selection seam: one implementation per supported database engine —
 * [PostgresSource] (default), [MySqlSource] (MySQL/MariaDB, opt-in via
 * `ashurbanipal.backend=mysql`), [SqliteSource] (opt-in via
 * `ashurbanipal.backend=sqlite`). Route handlers ([AshurbanipalController]) only
 * ever see this interface, never a concrete implementation or a raw
 * `DataSource`/JDBC type. Mirrors `implementations/rust/core/src/db/mod.rs`'s
 * `DbSource` trait; which implementation gets constructed is chosen by
 * [AshurbanipalAutoConfiguration] from explicit config, never by
 * classpath/driver detection (`PORTING.md`'s hardening checklist item 2 —
 * "found on the classpath -> sensible defaults -> turned on" is backwards
 * for this crate).
 */
interface DbSource {
    fun listSchemas(): List<String>
    fun listTables(schema: String?): List<TableInfo>
    fun tableCounts(schema: String?): List<CountEntry>
    fun queryTable(schema: String?, table: String, opts: QueryOpts): TableData
    fun commonValues(schema: String?, table: String, column: String): List<CommonValueEntry>
}
