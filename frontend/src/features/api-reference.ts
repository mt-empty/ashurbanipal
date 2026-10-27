import { API } from "../core/api.js";
import { $, copyText } from "../core/dom.js";

// ---- API reference: static, hand-maintained description of every route,
// for copy-pasting to an AI agent. Not its own endpoint — the doc never
// changes per-request, so a route would just be one more thing to keep
// in sync for no benefit. ----
function buildApiReference() {
  const base = new URL(API, location.href).toString().replace(/\/$/, "");
  const exampleFilter = encodeURIComponent(JSON.stringify([{ column: "status", op: "=", value: "active" }]));
  return {
    description:
      "Read-only REST API for browsing this service's database tables. Every endpoint is GET and returns JSON. Every cell value is a JSON string or null, regardless of the column's real type — never a JSON number or boolean. Source/schema/table names are data-dependent — call GET /sources, then GET /schemas, then GET /tables to discover real names before calling anything else.",
    base_url: base,
    endpoints: [
      {
        method: "GET",
        path: `${base}/sources`,
        summary:
          "Source names selectable as the `source` param on the routes below, for a host that has registered more than one. A single-source deployment still returns exactly one entry. `default` is the source used when `source` is omitted.",
        params: [],
        example_response: { sources: [{ name: "primary" }, { name: "reporting" }], default: "primary" },
      },
      {
        method: "GET",
        path: `${base}/schemas`,
        summary:
          "Schema names selectable as the `schema` param on the routes below (on Postgres: excludes catalog/toast/temp schemas and anything the connected role lacks USAGE on). An engine with no schema concept returns a single entry. `default` is the schema used when `schema` is omitted, or null when the connection has none.",
        params: [
          {
            name: "source",
            required: false,
            notes: "must be a name returned by GET /sources; omit to use the default source",
          },
        ],
        example_response: { schemas: [{ name: "public" }], default: "public" },
      },
      {
        method: "GET",
        path: `${base}/tables`,
        summary:
          "List table names in the resolved schema — also the allow-list for every other endpoint's `table` param.",
        params: [
          { name: "source", required: false, notes: "same as GET /schemas" },
          {
            name: "schema",
            required: false,
            notes: "must be a name returned by GET /schemas; omit to use the connection's default schema",
          },
        ],
        example_response: { tables: [{ name: "users", comment: "Registered accounts." }, { name: "sessions" }] },
      },
      {
        method: "GET",
        path: `${base}/table-counts`,
        summary:
          "Approximate row count per table — a cheap engine estimate, never a live COUNT(*); may be -1 when the engine exposes no estimate.",
        params: [
          { name: "source", required: false, notes: "same as GET /schemas" },
          { name: "schema", required: false, notes: "same as GET /tables" },
        ],
        example_response: { counts: [{ table: "users", approx_rows: 108234 }] },
      },
      {
        method: "GET",
        path: `${base}/tables/data`,
        summary:
          'Paginated, filtered, sorted rows for one table. `total_approx` may be -1, same caveat as GET /table-counts. A column that is both primary key and foreign key reports `key: "pk"` but still carries `references` (see the `order_id` example column); `references.schema` is present only when the referenced table lives in a different schema.',
        params: [
          { name: "source", required: false, notes: "same as GET /schemas" },
          { name: "schema", required: false, notes: "same as GET /tables" },
          { name: "table", required: true, notes: "must be a name returned by GET /tables" },
          {
            name: "filter",
            required: false,
            notes: "URL-encoded JSON array of condition objects — see the `filter` key below",
          },
          { name: "limit", required: false, notes: "default 50, max 100" },
          { name: "offset", required: false, notes: "default 0" },
          { name: "sort", required: false, notes: "single column name" },
          { name: "order", required: false, notes: '"asc" | "desc", default "asc"' },
        ],
        example_request: `${base}/tables/data?table=users&filter=${exampleFilter}&limit=20&sort=created_at&order=desc`,
        example_response: {
          columns: [
            { name: "id", type: "uuid", key: "pk" },
            { name: "user_id", type: "uuid", key: "fk", references: { table: "users", column: "id" } },
            {
              name: "order_id",
              type: "integer",
              key: "pk",
              references: { table: "orders", column: "id", schema: "public" },
            },
            { name: "status", type: "text" },
          ],
          rows: [{ id: "...", user_id: "...", order_id: "...", status: "active" }],
          total_approx: 108234,
        },
      },
      {
        method: "GET",
        path: `${base}/tables/common-values`,
        summary:
          "Most frequent values for one column — approximate, from engine statistics; empty when the engine keeps no such statistics for the column.",
        params: [
          { name: "source", required: false, notes: "same as GET /schemas" },
          { name: "schema", required: false, notes: "same as GET /tables" },
          { name: "table", required: true },
          { name: "column", required: true },
        ],
        example_response: { values: [{ value: "active", freq: 0.62 }] },
      },
      {
        method: "GET",
        path: `${base}/tables/referenced-by`,
        summary:
          "Incoming foreign keys — the FK constraints on other tables whose target is this one (the reverse of a column's `references`). One entry per constraint; a referrer with two FKs to the target appears twice. `columns` pairs `{from, to}` (referencing column → referenced column); a composite FK has more than one. `schema` is the referencing table's schema, present only when it differs from the resolved one. `constraint` may be engine-synthesized (SQLite). Returns `[]` — not a 404 — when nothing references the table.",
        params: [
          { name: "source", required: false, notes: "same as GET /schemas" },
          { name: "schema", required: false, notes: "same as GET /tables" },
          { name: "table", required: true, notes: "must be a name returned by GET /tables" },
        ],
        example_response: {
          referenced_by: [
            { table: "orders", constraint: "orders_user_id_fkey", columns: [{ from: "user_id", to: "id" }] },
          ],
        },
      },
      {
        method: "GET",
        path: `${base}/tables/structure`,
        summary:
          "Indexes and constraints of one table. `indexes` lists key columns in order (an expression entry is its text; INCLUDE columns are omitted), with `predicate` only for a partial index. `constraints` carries `primary_key` (omitted when none), and `unique`, `foreign_keys`, `check` (each `[]` when empty). A foreign key — single-column or composite — names the referenced `table` (and `schema` when it differs), pairs `{from, to}` columns, and has `on_delete`/`on_update` of CASCADE, RESTRICT, SET NULL, SET DEFAULT or NO ACTION. `check` is `[]` on SQLite. A table with no structure returns empty lists, not an error.",
        params: [
          { name: "source", required: false, notes: "same as GET /schemas" },
          { name: "schema", required: false, notes: "same as GET /tables" },
          { name: "table", required: true, notes: "must be a name returned by GET /tables" },
        ],
        example_response: {
          indexes: [{ name: "orders_pkey", columns: ["id"], unique: true, method: "btree" }],
          constraints: {
            primary_key: { name: "orders_pkey", columns: ["id"] },
            unique: [],
            foreign_keys: [
              {
                name: "orders_user_id_fkey",
                table: "users",
                columns: [{ from: "user_id", to: "id" }],
                on_delete: "CASCADE",
                on_update: "NO ACTION",
              },
            ],
            check: [],
          },
        },
      },
      {
        method: "GET",
        path: `${base}/tables/join`,
        summary:
          "Rows of up to 4 tables joined server-side (INNER or LEFT, equality on 1-3 column pairs per join), read-only. Every table and column name is checked against the live catalog; each pair must join columns of one type class (number, text, uuid, boolean, temporal, time, binary, enum), so floats, json and arrays cannot be joined. Positions: the start table is 0 and `joins[]` entries are 1..n; a `left` reference may only point at an earlier position. The response has `has_more` and never a total. A column carries `join`, `table` and `column` beside a unique `name` label (never parse the label); rows are keyed by label and a LEFT-join miss is null. Anything wrong with `join` itself (shape, an unknown table or column, an incompatible pair, the size limit) is a 400 with `code: invalid_join`; a bad `filter`, `sort` or `order` keeps its usual code. A join that runs over the query timeout is a 500 with `code: query_timeout`.",
        params: [
          { name: "source", required: false, notes: "same as GET /schemas" },
          { name: "schema", required: false, notes: "same as GET /tables; every table of the join is in it" },
          {
            name: "join",
            required: true,
            notes:
              'URL-encoded JSON object `{table, joins: [{type: "inner" | "left", table, on: [{left: {join, column}, right}]}], columns?: [{join, column}]}`, at most 8192 bytes',
          },
          {
            name: "filter",
            required: false,
            notes:
              "same as GET /tables/data, plus an optional integer `join` (table position, default 0) on each condition",
          },
          { name: "limit", required: false, notes: "default 50, max 100" },
          { name: "offset", required: false, notes: "default 0" },
          { name: "sort", required: false, notes: "a column name of the table at `sort_join`" },
          { name: "sort_join", required: false, notes: "table position of `sort`, default 0; 400 without `sort`" },
          { name: "order", required: false, notes: '"asc" | "desc", default "asc"' },
        ],
        example_response: {
          columns: [
            { name: "id", join: 0, table: "orders", column: "id", type: "uuid", key: "pk" },
            { name: "full_name", join: 1, table: "users", column: "full_name", type: "text" },
          ],
          rows: [{ id: "...", full_name: "Ada Lovelace" }],
          has_more: true,
        },
      },
      {
        method: "GET",
        path: `${base}/siblings`,
        summary: "Other related services configured for this instance, with live health status.",
        params: [],
        example_response: {
          siblings: [{ name: "billing", base_url: "https://billing.internal.vpn/__ashurbanipal", healthy: true }],
        },
      },
    ],
    filter: {
      wire_format: "URL-encoded JSON array of condition objects: [{logic?, not?, column, op, value?}, ...]",
      operators: ["=", "!=", ">", ">=", "<", "<=", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL"],
      limits: { max_conditions: 10, max_json_bytes: 8192 },
      notes: [
        '`logic` ("AND" | "OR") must be absent on the first condition and present on every later one; AND binds tighter than OR (SQL precedence — no parentheses/nesting exist).',
        "`not: true` negates its single condition; optional, defaults to false.",
        "`value` is always a JSON string, required except for IS NULL / IS NOT NULL, which take none.",
        "columns are cast to text before comparison, so the same operators work regardless of the column's real type (UUID, timestamp, JSON, etc.) — but '>'/'<'/'>='/'<=' then compare lexicographically as text, not numerically: a filter like age > 9 will incorrectly exclude age = 10.",
        "an empty condition array is treated identically to an absent `filter` param.",
        "on GET /tables/join a condition may carry `join` (the table position, default 0); on GET /tables/data any `join` is a 400.",
        "at most 10 conditions and 8192 bytes of URL-decoded JSON — exceeding either is a 400.",
        "this UI's filter box is a convenience that accepts `[NOT] column OP value [AND|OR ...]` text and compiles it to this AST client-side — DSL text sent as the `filter` param is a 400.",
      ],
      example: [
        { column: "status", op: "=", value: "completed" },
        { logic: "AND", not: true, column: "created_at", op: ">", value: "2016-01-01" },
        { logic: "OR", column: "deleted_at", op: "IS NULL" },
      ],
    },
  };
}

$("api-help-btn").onclick = () => {
  $("api-help-pre").textContent = JSON.stringify(buildApiReference(), null, 2);
  $<HTMLDialogElement>("api-help-dialog").showModal();
};
$("api-help-copy").onclick = () => copyText($("api-help-pre").textContent ?? "", $("api-help-copy"));
