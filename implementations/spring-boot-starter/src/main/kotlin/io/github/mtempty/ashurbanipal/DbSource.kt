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
 * is not itself a validation step (`spec/protocol.md` §6). MySQL's default
 * quote character is the backtick, not `"` — [MySqlSource] has its own
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

/** One `{from, to}` column pairing of an incoming FK (`spec/protocol.md` §5.9): `from` is the referencing column, `to` the referenced column; a composite FK has more than one. */
data class ColumnPair(val from: String, val to: String)

/** One FK constraint elsewhere in the source whose target is the requested table (`spec/protocol.md` §5.9 — the reverse of [ColumnRef]). */
data class ReferencedByEntry(
    val table: String,
    // Set only when the referencing table's schema differs from the resolved
    // one — the opposite end of the relationship from ColumnRef.schema.
    @JsonInclude(JsonInclude.Include.NON_NULL) val schema: String? = null,
    val constraint: String,
    val columns: List<ColumnPair>,
)

/**
 * Merges single-pair [ReferencedByEntry] rows into one entry per
 * (schema, table, constraint). Relies on the caller's catalog ORDER BY
 * putting a constraint's columns adjacent — a run-length merge, not a full
 * group-by. Each source maps its own row shape (and applies any allow-list
 * filter) before calling this.
 */
internal fun groupReferencedBy(rows: List<ReferencedByEntry>): List<ReferencedByEntry> {
    val out = ArrayList<ReferencedByEntry>()
    for (row in rows) {
        val last = out.lastOrNull()
        if (last != null && last.table == row.table && last.schema == row.schema && last.constraint == row.constraint) {
            out[out.lastIndex] = last.copy(columns = last.columns + row.columns)
        } else {
            out.add(row)
        }
    }
    return out
}

data class QueryOpts(
    val limit: Long,
    val offset: Long,
    val sort: String?,
    val descending: Boolean,
    val filter: List<Condition>?,
)

/** Backend-selection seam; route handlers never access a concrete driver. */
interface DbSource {
    fun listSchemas(): List<String>
    fun listTables(schema: String?): List<TableInfo>
    fun tableCounts(schema: String?): List<CountEntry>
    fun queryTable(schema: String?, table: String, opts: QueryOpts): TableData
    fun commonValues(schema: String?, table: String, column: String): List<CommonValueEntry>

    /** Incoming FK references: every FK constraint elsewhere in the source whose target is `table` (`spec/protocol.md` §5.9). */
    fun referencedBy(schema: String?, table: String): List<ReferencedByEntry>
}
