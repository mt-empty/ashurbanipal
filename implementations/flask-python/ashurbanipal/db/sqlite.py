"""SQLite `DbSource`. Ported against `implementations/rust/src/db/sqlite.rs`
— see `docs/adapter-decisions.md` for the per-clause relaxations this makes
(always-`-1` row counts, always-empty common-values, no comments, `ILIKE`
folded to plain `LIKE`).

Uses stdlib `sqlite3`, not an ORM. One fresh connection per operation
(`sqlite3.connect(...)`, closed at the end) — see `db/__init__.py`'s
docstring for why this trivially satisfies the "pin one connection per
operation" invariant.

Timeout mechanism: unlike the task brief's assumption, Python's stdlib
`sqlite3` *does* expose a real per-query interrupt hook —
`Connection.set_progress_handler(handler, n)` mirrors the C-level
`sqlite3_progress_handler` the Rust reference uses (`sqlite.rs::bounded`)
almost exactly: `handler` is invoked every `n` VM opcodes, and a truthy
return value aborts the currently executing statement immediately, on the
same thread. Verified empirically in
`tests/test_sqlite_timeout.py::test_slow_query_is_aborted_by_progress_handler`
with a real `WITH RECURSIVE` query, not just from documentation.
"""

from __future__ import annotations

import sqlite3
import time
from typing import Optional

from ..filter import Condition
from . import (
    ColumnInfo,
    ColumnRef,
    DbSource,
    FilterParseError,
    KeyKind,
    NotAllowed,
    QueryOpts,
    TableData,
    TableInfo,
    quote_ident,
)

CATALOG_TIMEOUT_SECS = 5

# SQLite has no schema namespace above a single database file (ignoring
# ATTACH, which this backend doesn't use) — this is the only name
# list_schemas ever returns.
ONLY_SCHEMA = "main"

# SQLite's plain LIKE is already ASCII case-insensitive by default, so
# ILIKE and LIKE compile to the same fragment here — only the mechanism
# collapses, the case-insensitive *behavior* ILIKE promises still holds.
_KEYWORD = {"ILIKE": "LIKE"}


def _lenient_text_factory(data: bytes) -> str:
    """stdlib sqlite3's default text_factory raises UnicodeDecodeError on
    invalid UTF-8; substitute the protocol's sentinel instead
    (spec/protocol.md §5.4.3), mirroring sqlite.rs's per-cell
    `Err(_) => "<undecodable>"`.
    """
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return "<undecodable>"


def _check_schema(schema: Optional[str]) -> None:
    if schema is not None and schema != ONLY_SCHEMA:
        raise NotAllowed(f"schema {schema!r}")


def _build_where_clause(conditions: list[Condition], column_names: list[str]) -> tuple[str, list[str]]:
    if not conditions:
        return "", []

    values: list[str] = []
    clause_parts: list[str] = []
    for i, cond in enumerate(conditions):
        if cond.column not in column_names:
            raise NotAllowed(f"column {cond.column!r}")
        keyword = _KEYWORD.get(cond.op, cond.op)
        quoted_column = quote_ident(cond.column)
        if cond.op in ("IS NULL", "IS NOT NULL"):
            inner = f"CAST({quoted_column} AS TEXT) {keyword}"
        else:
            inner = f"CAST({quoted_column} AS TEXT) {keyword} ?"
            values.append(cond.value)
        wrapped = f"(NOT ({inner}))" if cond.not_ else f"({inner})"

        if i > 0:
            if cond.logic not in ("AND", "OR"):
                raise FilterParseError(f"condition {i} is missing logic")
            clause_parts.append(" AND " if cond.logic == "AND" else " OR ")
        clause_parts.append(wrapped)

    return " where " + "".join(clause_parts), values


class SqliteSource(DbSource):
    def __init__(self, path: str):
        self._path = path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._path)
        conn.text_factory = _lenient_text_factory
        return conn

    def _bounded(self, conn: sqlite3.Connection, timeout_secs: int) -> None:
        """Must be cleared (see callers) before the connection is discarded
        — harmless here since each connection is closed right after its one
        operation, but kept explicit to mirror `sqlite.rs::bounded`'s
        contract in case a future caller starts reusing connections.
        """
        deadline = time.monotonic() + timeout_secs

        def handler() -> int:
            return 0 if time.monotonic() < deadline else 1

        conn.set_progress_handler(handler, 1000)

    def _clear_bound(self, conn: sqlite3.Connection) -> None:
        conn.set_progress_handler(None, 0)

    def _allowed_tables(self, cur: sqlite3.Cursor) -> list[str]:
        cur.execute(
            "select name from sqlite_master "
            "where type = 'table' and name not like 'sqlite\\_%' escape '\\' "
            "order by name"
        )
        return [row[0] for row in cur.fetchall()]

    def _allowed_columns(self, cur: sqlite3.Cursor, table: str) -> list[str]:
        # `table` is validated against _allowed_tables by every caller
        # first — PRAGMA table-valued functions don't take a bound
        # parameter for the table name, so this is the one identifier
        # spliced rather than bound (mirrors sqlite.rs::allowed_columns).
        cur.execute(f"select cid, name from pragma_table_info({quote_ident(table)}) order by cid")
        return [row[1] for row in cur.fetchall()]

    def _key_metadata(self, cur: sqlite3.Cursor, table: str) -> tuple[list[str], dict[str, ColumnRef]]:
        quoted = quote_ident(table)
        cur.execute(f"select cid, name, pk from pragma_table_info({quoted}) order by cid")
        pk_columns = [name for _, name, pk in cur.fetchall() if pk > 0]

        # (id, seq, table, from, to) — id groups columns belonging to the
        # same constraint (composite FKs share an id).
        cur.execute(f'select id, seq, "table", "from", "to" from pragma_foreign_key_list({quoted})')
        by_constraint: dict[int, list[tuple[str, str, str]]] = {}
        for constraint_id, _seq, ref_table, from_col, to_col in cur.fetchall():
            by_constraint.setdefault(constraint_id, []).append((from_col, ref_table, to_col))

        fk_columns: dict[str, ColumnRef] = {}
        for members in by_constraint.values():
            if len(members) != 1:
                continue
            from_col, ref_table, to_col = members[0]
            fk_columns[from_col] = ColumnRef(table=ref_table, column=to_col, schema=None)
        return pk_columns, fk_columns

    def list_schemas(self) -> list[str]:
        return [ONLY_SCHEMA]

    def list_tables(self, schema: Optional[str]) -> list[TableInfo]:
        _check_schema(schema)
        conn = self._connect()
        try:
            names = self._allowed_tables(conn.cursor())
        finally:
            conn.close()
        # No obj_description equivalent in SQLite — comments unsupported.
        return [TableInfo(name=name, comment=None) for name in names]

    def table_counts(self, schema: Optional[str]) -> list[tuple[str, int]]:
        _check_schema(schema)
        conn = self._connect()
        try:
            names = self._allowed_tables(conn.cursor())
        finally:
            conn.close()
        # No reltuples-equivalent catalog estimate; -1 is the documented
        # "no estimate" sentinel (spec/protocol.md §5.3), not a per-table
        # COUNT(*) scan. See docs/adapter-decisions.md.
        return [(name, -1) for name in names]

    def query_table(self, schema: Optional[str], table: str, opts: QueryOpts) -> TableData:
        _check_schema(schema)
        conn = self._connect()
        try:
            cur = conn.cursor()
            tables = self._allowed_tables(cur)
            if table not in tables:
                raise NotAllowed(f"table {table!r}")

            column_names = self._allowed_columns(cur, table)
            sort = None
            if opts.sort is not None:
                if opts.sort not in column_names:
                    raise NotAllowed(f"column {opts.sort!r}")
                sort = opts.sort

            where_clause, filter_values = _build_where_clause(opts.filter or [], column_names)

            pk_columns, fk_columns = self._key_metadata(cur, table)
            quoted_table = quote_ident(table)
            cur.execute(f"select cid, name, type from pragma_table_info({quoted_table}) order by cid")
            columns = []
            for _, name, type_name in cur.fetchall():
                columns.append(
                    ColumnInfo(
                        name=name,
                        # SQLite's declared column types can be empty (""),
                        # fall back to a stable label rather than emitting "".
                        type_name=type_name or "unknown",
                        key=(KeyKind.PK if name in pk_columns else (KeyKind.FK if name in fk_columns else None)),
                        references=fk_columns.get(name),
                        comment=None,
                    )
                )

            select_list = ", ".join(f"CAST({quote_ident(c.name)} AS TEXT)" for c in columns)
            order_clause = ""
            if sort is not None:
                direction = "desc" if opts.descending else "asc"
                order_clause = f" order by {quoted_table}.{quote_ident(sort)} {direction}"
            sql = f"select {select_list} from {quoted_table}{where_clause}{order_clause} limit ? offset ?"

            self._bounded(conn, opts.timeout_secs)
            try:
                cur.execute(sql, (*filter_values, opts.limit, opts.offset))
                sqlite_rows = cur.fetchall()
            finally:
                self._clear_bound(conn)

            rows = [
                {col.name: (None if value is None else str(value)) for col, value in zip(columns, row)}
                for row in sqlite_rows
            ]
            return TableData(
                columns=columns,
                rows=rows,
                # No reltuples-equivalent estimate to read; -1 is the
                # documented "no estimate" sentinel (spec/protocol.md
                # §5.4.4), not a second COUNT(*) scan on every page load.
                total_approx=-1,
            )
        finally:
            conn.close()

    def common_values(self, schema: Optional[str], table: str, column: str) -> list[tuple[str, float]]:
        _check_schema(schema)
        conn = self._connect()
        try:
            cur = conn.cursor()
            tables = self._allowed_tables(cur)
            if table not in tables:
                raise NotAllowed(f"table {table!r}")
            columns = self._allowed_columns(cur, table)
            if column not in columns:
                raise NotAllowed(f"column {column!r}")
        finally:
            conn.close()
        # No pg_stats equivalent to read; an empty list is the documented
        # "no statistics available" answer (spec/protocol.md §5.5), not a
        # live GROUP BY scan. See docs/adapter-decisions.md.
        return []
