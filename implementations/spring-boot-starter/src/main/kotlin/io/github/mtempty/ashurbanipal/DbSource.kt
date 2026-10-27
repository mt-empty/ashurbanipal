package io.github.mtempty.ashurbanipal

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.annotation.JsonProperty

/**
 * Which allow-list (or privilege check) rejected a request — maps 1:1 onto
 * `spec/protocol.md` §2's `unknown_source`/`unknown_schema`/`unknown_table`/
 * `unknown_column`/`not_readable` error codes. Mirrors the Rust reference's
 * `NotAllowedKind` (`implementations/rust/core/src/db/mod.rs`).
 */
enum class NotAllowedKind(val code: String) {
    SOURCE("unknown_source"),
    SCHEMA("unknown_schema"),
    TABLE("unknown_table"),
    COLUMN("unknown_column"),

    /** Cleared the allow-list but the connected role can't actually `SELECT` it (Postgres 42501, MySQL/MariaDB residual 1142). */
    NOT_READABLE("not_readable"),
}

/** Table/column/schema not in the live allow-list; the controller maps this to 400 (`spec/protocol.md` §6 — no unvalidated identifier ever reaches SQL text). */
class NotAllowedException(message: String, val kind: NotAllowedKind) : RuntimeException(message)

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

/**
 * A source's browsable schemas plus the one an absent `schema` param resolves
 * to: null when the connection has no default schema, or its default is not
 * listed (`spec/protocol.md` §5.7).
 */
data class SchemaListing(val schemas: List<String>, val default: String?) {
    companion object {
        fun of(schemas: List<String>, default: String?) = SchemaListing(schemas, default?.takeIf { it in schemas })
    }
}
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
    // Accumulates into one mutable buffer per run instead of `copy`ing the
    // whole immutable columns list on every additional pair (O(k) per
    // constraint instead of O(k^2) for a k-column composite FK).
    var pendingEntry: ReferencedByEntry? = null
    var pendingColumns: MutableList<ColumnPair>? = null

    fun flush() {
        val entry = pendingEntry ?: return
        out.add(entry.copy(columns = pendingColumns!!))
    }

    for (row in rows) {
        val pending = pendingEntry
        if (pending != null && pending.table == row.table && pending.schema == row.schema && pending.constraint == row.constraint) {
            pendingColumns!!.addAll(row.columns)
        } else {
            flush()
            pendingEntry = row
            pendingColumns = row.columns.toMutableList()
        }
    }
    flush()
    return out
}

/** One index of a table (`spec/protocol.md` §5.10); `columns` are the key columns in index order, an expression entry being its expression text. */
data class IndexInfo(
    val name: String,
    val columns: List<String>,
    val unique: Boolean,
    val method: String,
    // Partial-index WHERE text; omitted for a non-partial index.
    @JsonInclude(JsonInclude.Include.NON_NULL) val predicate: String? = null,
)

data class ConstraintPk(
    @JsonInclude(JsonInclude.Include.NON_NULL) val name: String? = null,
    val columns: List<String>,
)

data class ConstraintUnique(val name: String, val columns: List<String>)

/**
 * An outgoing foreign key, single-column or composite. [table]/[schema] name
 * the referenced table; [schema] is set only when it differs from the
 * resolved one. [onDelete]/[onUpdate] are one of CASCADE, RESTRICT,
 * SET NULL, SET DEFAULT, NO ACTION.
 */
data class ConstraintFk(
    val name: String,
    val table: String,
    @JsonInclude(JsonInclude.Include.NON_NULL) val schema: String? = null,
    val columns: List<ColumnPair>,
    @JsonProperty("on_delete") val onDelete: String,
    @JsonProperty("on_update") val onUpdate: String,
)

data class ConstraintCheck(
    val name: String,
    // SQL text where the engine can supply it.
    @JsonInclude(JsonInclude.Include.NON_NULL) val expression: String? = null,
)

data class Constraints(
    @JsonProperty("primary_key") @JsonInclude(JsonInclude.Include.NON_NULL) val primaryKey: ConstraintPk? = null,
    val unique: List<ConstraintUnique> = emptyList(),
    @JsonProperty("foreign_keys") val foreignKeys: List<ConstraintFk> = emptyList(),
    val check: List<ConstraintCheck> = emptyList(),
)

/** A table's indexes and constraints (`spec/protocol.md` §5.10). */
data class Structure(val indexes: List<IndexInfo> = emptyList(), val constraints: Constraints = Constraints())

data class QueryOpts(
    val limit: Long,
    val offset: Long,
    val sort: String?,
    val descending: Boolean,
    val filter: List<Condition>?,
)

/** Backend-selection seam; route handlers never access a concrete driver. */
interface DbSource {
    fun listSchemas(): SchemaListing
    fun listTables(schema: String?): List<TableInfo>
    fun tableCounts(schema: String?): List<CountEntry>
    fun queryTable(schema: String?, table: String, opts: QueryOpts): TableData
    fun commonValues(schema: String?, table: String, column: String): List<CommonValueEntry>

    /** Incoming FK references: every FK constraint elsewhere in the source whose target is `table` (`spec/protocol.md` §5.9). */
    fun referencedBy(schema: String?, table: String): List<ReferencedByEntry>

    /** Indexes and constraints of `table` (`spec/protocol.md` §5.10). */
    fun structure(schema: String?, table: String): Structure

    /** Rows from the tables a join names (`spec/protocol.md` §5.11). */
    fun queryJoin(schema: String?, spec: JoinSpec, opts: JoinOpts): JoinData
}
