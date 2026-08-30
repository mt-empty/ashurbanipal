"""The Flask `Blueprint` + the API handlers + the HTML route
(`spec/protocol.md` §5). Mirrors `implementations/rust/axum/src/routes.rs`.

Kill switch: `router()` mirrors the Rust reference's `router()` — a
disabled `Config` yields a `Blueprint` with zero routes registered on it,
so merging it into a host `Flask` app via `app.register_blueprint(...)`
contributes nothing, and every mount path 404s exactly as if the crate
were never merged in at all (`spec/protocol.md` §4).
"""

from __future__ import annotations

import urllib.error
import urllib.request
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit, urlunsplit

from flask import Blueprint, Response, jsonify, request

from . import filter as filter_module
from .config import Config
from .db import DbError, DbSource, FilterParseError, NotAllowed, QueryOpts
from .embed import DBVIEWER_HTML

PROTOCOL_HEADER = "x-ashurbanipal-protocol"
# Bumped only for non-additive wire changes; additive optional fields keep
# the same version.
PROTOCOL_VERSION = "1"

_SIBLING_HEALTH_TIMEOUT_SECS = 3
_MAX_I64 = 2**63 - 1


def router(config: Config, sources: Sequence[tuple[str, DbSource]], mount: str = "/__ashurbanipal") -> Blueprint:
    assert sources, "router() requires at least one source"

    bp = Blueprint("ashurbanipal", __name__, url_prefix=mount)
    if not config.is_enabled():
        return bp  # zero routes registered — 404 on every path under `mount`

    api_prefix = f"{mount}/api/"

    @bp.after_request
    def _stamp_protocol_version(response: Response) -> Response:
        # Every API response carries the version header (§7); the HTML
        # route (registered at exactly `mount`, no trailing segment) must
        # not — gated on path rather than a second blueprint so one
        # Blueprint stays the single object router() returns, mirroring
        # the Rust reference's one merged Router.
        if request.path.startswith(api_prefix):
            response.headers[PROTOCOL_HEADER] = PROTOCOL_VERSION
        return response

    def resolve_source(name: str | None) -> DbSource:
        # Absent -> first-registered default; present -> exact match or
        # rejection, never a fallback guess (spec/protocol.md §1).
        if name is None:
            return sources[0][1]
        for n, s in sources:
            if n == name:
                return s
        raise NotAllowed(f'source "{name}"')

    def _error_response(err: DbError) -> Response:
        if isinstance(err, NotAllowed):
            return Response(f"not allowed: {err}", status=400, mimetype="text/plain")
        if isinstance(err, FilterParseError):
            return Response(f"invalid filter: {err}", status=400, mimetype="text/plain")
        return Response(f"database error: {err}", status=500, mimetype="text/plain")

    @bp.errorhandler(DbError)
    def _handle_db_error(err: DbError) -> Response:
        return _error_response(err)

    @bp.get("")
    def serve_html() -> Response:
        return Response(DBVIEWER_HTML, mimetype="text/html")

    @bp.get("/api/sources")
    def list_sources() -> Response:
        return jsonify({"sources": [{"name": n} for n, _ in sources]})

    @bp.get("/api/schemas")
    def list_schemas() -> Response:
        source = resolve_source(request.args.get("source"))
        return jsonify({"schemas": source.list_schemas()})

    @bp.get("/api/tables")
    def list_tables() -> Response:
        source = resolve_source(request.args.get("source"))
        schema = request.args.get("schema")
        tables = source.list_tables(schema)
        return jsonify({"tables": [_table_to_dict(t) for t in tables]})

    @bp.get("/api/table-counts")
    def table_counts() -> Response:
        source = resolve_source(request.args.get("source"))
        schema = request.args.get("schema")
        counts = source.table_counts(schema)
        return jsonify({"counts": [{"table": table, "approx_rows": count} for table, count in counts]})

    @bp.get("/api/tables/data")
    def table_data() -> Response:
        source = resolve_source(request.args.get("source"))
        schema = request.args.get("schema")
        table = request.args.get("table")
        if table is None:
            return Response('missing required "table" parameter', status=400, mimetype="text/plain")

        raw_filter = request.args.get("filter")
        parsed_filter = None
        if raw_filter is not None and raw_filter.strip():
            try:
                conditions = filter_module.parse(raw_filter)
            except filter_module.FilterError as e:
                return _error_response(FilterParseError(str(e)))
            parsed_filter = conditions or None

        limits = config.limits
        limit = _clamp_int(
            request.args.get("limit"), default=limits.default_page_size, lo=1, hi=limits.max_page_size
        )
        if limit is None:
            return Response('"limit" must be a number', status=400, mimetype="text/plain")
        offset = _clamp_int(request.args.get("offset"), default=0, lo=0, hi=_MAX_I64)
        if offset is None:
            return Response('"offset" must be a number', status=400, mimetype="text/plain")

        order = request.args.get("order")
        if order is None or order == "asc":
            descending = False
        elif order == "desc":
            descending = True
        else:
            msg = f'invalid order {order!r} (expected "asc" or "desc")'
            return Response(msg, status=400, mimetype="text/plain")

        opts = QueryOpts(
            limit=limit,
            offset=offset,
            timeout_secs=limits.query_timeout_secs,
            sort=request.args.get("sort"),
            descending=descending,
            filter=parsed_filter,
        )
        data = source.query_table(schema, table, opts)
        return jsonify(
            {
                "columns": [_column_to_dict(c) for c in data.columns],
                "rows": data.rows,
                "total_approx": data.total_approx,
            }
        )

    @bp.get("/api/tables/common-values")
    def common_values() -> Response:
        source = resolve_source(request.args.get("source"))
        schema = request.args.get("schema")
        table = request.args.get("table")
        column = request.args.get("column")
        if table is None or column is None:
            return Response('missing required "table"/"column" parameter', status=400, mimetype="text/plain")
        values = source.common_values(schema, table, column)
        return jsonify({"values": [{"value": value, "freq": freq} for value, freq in values]})

    @bp.get("/api/siblings")
    def siblings() -> Response:
        results = _check_siblings(config.siblings)
        return jsonify({"siblings": results})

    return bp


def _table_to_dict(t) -> dict:
    d = {"name": t.name}
    if t.comment is not None:
        d["comment"] = t.comment
    return d


def _column_to_dict(c) -> dict:
    d = {"name": c.name, "type": c.type_name}
    if c.key is not None:
        d["key"] = c.key.value
    if c.references is not None:
        ref = {"table": c.references.table, "column": c.references.column}
        if c.references.schema is not None:
            ref["schema"] = c.references.schema
        d["references"] = ref
    if c.comment is not None:
        d["comment"] = c.comment
    return d


def _clamp_int(raw, *, default: int, lo: int, hi: int):
    """§5.4 requires both `limit` and `offset` to be clamped, never
    rejected, for any numerically valid out-of-range value; only genuinely
    non-numeric input (`"abc"`, `"1.5"`) 400s. Returns None on the latter.
    """
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return None
    return max(lo, min(hi, value))


def _health_url(base_url: str, health_path: str):
    """Resolves against the sibling's origin (scheme + host + port), not
    the base_url's own path.
    """
    parts = urlsplit(base_url)
    if not parts.scheme or not parts.netloc:
        return None
    return urlunsplit((parts.scheme, parts.netloc, health_path, "", ""))


def _check_one_sibling(sibling) -> dict:
    url = _health_url(sibling.base_url, sibling.health_path)
    healthy = False
    if url is not None:
        try:
            with urllib.request.urlopen(url, timeout=_SIBLING_HEALTH_TIMEOUT_SECS) as resp:
                healthy = 200 <= resp.status < 300
        except (urllib.error.URLError, OSError, ValueError):
            healthy = False
    return {"name": sibling.name, "base_url": sibling.base_url, "healthy": healthy}


def _check_siblings(siblings: list) -> list[dict]:
    """Checks SHOULD run in parallel and MUST be individually bounded by a
    timeout, so one dead sibling can't stall the response (§5.6).
    """
    if not siblings:
        return []
    with ThreadPoolExecutor(max_workers=len(siblings)) as pool:
        return list(pool.map(_check_one_sibling, siblings))
