import { API } from "./api.js";
import { $, copyText } from "./dom.js";

// ---- API reference: static, hand-maintained description of every route,
// for copy-pasting to an AI agent. Not its own endpoint — the doc never
// changes per-request, so a route would just be a 7th thing to keep in
// sync for no benefit. ----
function buildApiReference() {
  const base = new URL(API, location.href).toString().replace(/\/$/, "");
  const exampleFilter = encodeURIComponent(JSON.stringify([{ column: "status", op: "=", value: "active" }]));
  return {
    description: "Read-only REST API for browsing this service's Postgres tables. Every endpoint is GET and returns JSON. Table/column names are data-dependent — call GET /tables first to discover real names before calling anything else.",
    base_url: base,
    endpoints: [
      {
        method: "GET",
        path: `${base}/schemas`,
        summary: "List selectable Postgres schema names for this connection (excludes catalog/toast/temp schemas and anything the connected role lacks USAGE on). Not every implementation/port has this route yet — treat its absence as \"single schema only\", not an error.",
        params: [],
        example_response: { schemas: ["public"] },
      },
      {
        method: "GET",
        path: `${base}/tables`,
        summary: "List table names in the resolved schema — also the allow-list for every other endpoint's `table` param.",
        params: [
          { name: "schema", required: false, notes: "must be a name returned by GET /schemas; omit to use the connection's default schema" },
        ],
        example_response: { tables: [{ name: "users", comment: "Registered accounts." }, { name: "sessions" }] },
      },
      {
        method: "GET",
        path: `${base}/table-counts`,
        summary: "Approximate row count per table (pg_class.reltuples, not COUNT(*)).",
        params: [
          { name: "schema", required: false, notes: "same as GET /tables" },
        ],
        example_response: { counts: [{ table: "users", approx_rows: 108234 }] },
      },
      {
        method: "GET",
        path: `${base}/tables/data`,
        summary: "Paginated, filtered, sorted rows for one table.",
        params: [
          { name: "schema", required: false, notes: "same as GET /tables" },
          { name: "table", required: true, notes: "must be a name returned by GET /tables" },
          { name: "filter", required: false, notes: "URL-encoded JSON array of condition objects — see the `filter` key below" },
          { name: "limit", required: false, notes: "default 50, max 100" },
          { name: "offset", required: false, notes: "default 0" },
          { name: "sort", required: false, notes: "single column name" },
          { name: "order", required: false, notes: '"asc" | "desc", default "asc"' },
        ],
        example_request: `${base}/tables/data?table=users&filter=${exampleFilter}&limit=20&sort=created_at&order=desc`,
        example_response: {
          columns: [{ name: "id", type: "uuid", key: "pk" }, { name: "status", type: "text" }],
          rows: [{ id: "...", status: "active" }],
          total_approx: 108234,
        },
      },
      {
        method: "GET",
        path: `${base}/tables/common-values`,
        summary: "Most frequent values for one column (pg_stats — approximate; empty if the column has no planner statistics yet).",
        params: [
          { name: "schema", required: false, notes: "same as GET /tables" },
          { name: "table", required: true },
          { name: "column", required: true },
        ],
        example_response: { values: [{ value: "active", freq: 0.62 }] },
      },
      {
        method: "GET",
        path: `${base}/siblings`,
        summary: "Other related services configured for this instance, with live health status.",
        params: [],
        example_response: { siblings: [{ name: "billing", dbviewer_url: "https://billing.internal.vpn/__ashurbanipal", healthy: true }] },
      },
    ],
    filter: {
      wire_format: "URL-encoded JSON array of condition objects: [{logic?, not?, column, op, value?}, ...]",
      operators: ["=", "!=", ">", ">=", "<", "<=", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL"],
      limits: { max_conditions: 10, max_json_bytes: 8192 },
      notes: [
        "`logic` (\"AND\" | \"OR\") must be absent on the first condition and present on every later one; AND binds tighter than OR (SQL precedence — no parentheses/nesting exist).",
        "`not: true` negates its single condition; optional, defaults to false.",
        "`value` is always a JSON string, required except for IS NULL / IS NOT NULL, which take none.",
        "columns are cast to text before comparison, so the same operators work across uuid/timestamptz/jsonb/etc.",
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
