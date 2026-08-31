"""MySQL/MariaDB DbSource; use fork-specific query timeouts (`spec/protocol.md` §6)."""

from __future__ import annotations

from urllib.parse import urlsplit

import pymysql

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
    wrap_driver_errors,
)

CATALOG_TIMEOUT_SECS = 5

_MYSQL = "mysql"
_MARIADB = "mariadb"


def connect_kwargs_from_url(url: str) -> dict:
    """Parses a `mysql://user:pass@host:port/dbname` URL (the same shape
    `MYSQL_TEST_URL`/`MARIADB_TEST_URL` use) into `pymysql.connect` kwargs
    — a small convenience for `demo/app.py` and the test suite, not part
    of the `DbSource` contract itself.
    """
    parts = urlsplit(url)
    return {
        "host": parts.hostname,
        "port": parts.port or 3306,
        "user": parts.username,
        "password": parts.password or "",
        "database": parts.path.lstrip("/") or None,
    }


def _quote_ident(ident: str) -> str:
    """Backtick-escape live-catalog identifiers for MySQL (`spec/protocol.md` §5)."""
    return "`" + ident.replace("`", "``") + "`"


def _timed_select(variant: str, timeout_secs: int, body: str) -> str:
    """MariaDB ignores MySQL timeout hints, so it needs a statement wrapper (`spec/protocol.md` §6)."""
    if variant == _MYSQL:
        return f"select /*+ MAX_EXECUTION_TIME({int(timeout_secs) * 1000}) */ {body}"
    return f"set statement max_statement_time={int(timeout_secs)} for select {body}"


def _decode_cell(value: bytes | None, encoding: str) -> str | None:
    """Decode per cell so invalid bytes do not abort results (`spec/protocol.md` §5.4.3)."""
    if value is None:
        return None
    try:
        return value.decode(encoding)
    except UnicodeDecodeError:
        return "<undecodable>"


def _build_where_clause(conditions: list[Condition], column_names: list[str]) -> tuple[str, list[str]]:
    """Map ILIKE through LOWER for collation independence (`spec/protocol.md` §5.4.2)."""
    if not conditions:
        return "", []

    values: list[str] = []
    clause_parts: list[str] = []
    for i, cond in enumerate(conditions):
        if cond.column not in column_names:
            raise NotAllowed(f"column {cond.column!r}")
        cast = f"CAST({_quote_ident(cond.column)} AS CHAR)"

        if cond.op == "ILIKE":
            values.append(cond.value)
            inner = f"LOWER({cast}) LIKE LOWER(%s)"
        elif cond.op in ("IS NULL", "IS NOT NULL"):
            inner = f"{cast} {cond.op}"
        else:
            values.append(cond.value)
            inner = f"{cast} {cond.op} %s"
        wrapped = f"(NOT ({inner}))" if cond.not_ else f"({inner})"

        if i > 0:
            if cond.logic not in ("AND", "OR"):
                raise FilterParseError(f"condition {i} is missing logic")
            clause_parts.append(" AND " if cond.logic == "AND" else " OR ")
        clause_parts.append(wrapped)

    return " where " + "".join(clause_parts), values


class MySqlSource(DbSource):
    def __init__(self, **connect_kwargs):
        self._connect_kwargs = connect_kwargs
        self._variant: str | None = None

    def _connect(self) -> pymysql.connections.Connection:
        return pymysql.connect(**self._connect_kwargs)

    def _variant_of(self, conn: pymysql.connections.Connection) -> str:
        """Cache whether SELECT VERSION() contains MariaDB (`spec/protocol.md` §6)."""
        if self._variant is not None:
            return self._variant
        with conn.cursor() as cur:
            cur.execute("select version()")
            (version,) = cur.fetchone()
        self._variant = _MARIADB if "mariadb" in version.lower() else _MYSQL
        return self._variant

    def _list_schemas(self, cur, variant: str, timeout_secs: int) -> list[str]:
        cur.execute(
            _timed_select(
                variant,
                timeout_secs,
                "schema_name from information_schema.schemata "
                "where schema_name not in ('mysql', 'information_schema', 'performance_schema', 'sys') "
                "order by schema_name",
            )
        )
        return [row[0] for row in cur.fetchall()]

    def _resolve_schema(self, cur, variant: str, requested: str | None, timeout_secs: int) -> str:
        schemas = self._list_schemas(cur, variant, timeout_secs)
        if requested is not None:
            resolved = requested
        else:
            cur.execute(_timed_select(variant, timeout_secs, "database()"))
            (resolved,) = cur.fetchone()
        if resolved not in schemas:
            raise NotAllowed(f"schema {resolved!r}")
        return resolved

    def _allowed_tables(self, cur, variant: str, schema: str, timeout_secs: int) -> list[str]:
        cur.execute(
            _timed_select(
                variant,
                timeout_secs,
                "table_name from information_schema.tables "
                "where table_schema = %s and table_type = 'BASE TABLE' "
                "order by table_name",
            ),
            (schema,),
        )
        return [row[0] for row in cur.fetchall()]

    def _allowed_columns(self, cur, variant: str, schema: str, table: str, timeout_secs: int) -> list[str]:
        cur.execute(
            _timed_select(
                variant,
                timeout_secs,
                "column_name from information_schema.columns "
                "where table_schema = %s and table_name = %s "
                "order by ordinal_position",
            ),
            (schema, table),
        )
        return [row[0] for row in cur.fetchall()]

    def _key_metadata(
        self, cur, variant: str, schema: str, table: str, timeout_secs: int
    ) -> tuple[set[str], dict[str, ColumnRef]]:
        """Join MySQL's repeating PRIMARY name on table name (`spec/protocol.md` §5.4.1)."""
        cur.execute(
            _timed_select(
                variant,
                timeout_secs,
                "tc.constraint_name, tc.constraint_type, kcu.column_name, "
                "       kcu.referenced_table_schema, kcu.referenced_table_name, "
                "       kcu.referenced_column_name "
                "from information_schema.table_constraints tc "
                "join information_schema.key_column_usage kcu "
                "  on kcu.constraint_name = tc.constraint_name "
                " and kcu.table_schema = tc.table_schema "
                " and kcu.table_name = tc.table_name "
                "where tc.table_schema = %s "
                "  and tc.table_name = %s "
                "  and tc.constraint_type in ('PRIMARY KEY', 'FOREIGN KEY')",
            ),
            (schema, table),
        )
        pk_columns: set[str] = set()
        fk_candidates: dict[str, list[tuple]] = {}
        for constraint_name, constraint_type, column_name, ref_schema, ref_table, ref_column in cur.fetchall():
            if constraint_type == "PRIMARY KEY":
                pk_columns.add(column_name)
            elif constraint_type == "FOREIGN KEY":
                fk_candidates.setdefault(constraint_name, []).append(
                    (column_name, ref_schema, ref_table, ref_column)
                )

        fk_columns: dict[str, ColumnRef] = {}
        for members in fk_candidates.values():
            distinct_columns = {m[0] for m in members}
            if len(distinct_columns) != 1:
                continue
            column_name, ref_schema, ref_table, ref_column = members[0]
            if ref_schema is None or ref_table is None or ref_column is None:
                continue
            fk_columns[column_name] = ColumnRef(
                table=ref_table, column=ref_column, schema=(ref_schema if ref_schema != schema else None)
            )
        return pk_columns, fk_columns

    @wrap_driver_errors(pymysql.Error)
    def list_schemas(self) -> list[str]:
        conn = self._connect()
        try:
            variant = self._variant_of(conn)
            with conn.cursor() as cur:
                schemas = self._list_schemas(cur, variant, CATALOG_TIMEOUT_SECS)
            conn.commit()
            return schemas
        finally:
            conn.close()

    @wrap_driver_errors(pymysql.Error)
    def list_tables(self, schema: str | None) -> list[TableInfo]:
        conn = self._connect()
        try:
            variant = self._variant_of(conn)
            with conn.cursor() as cur:
                resolved = self._resolve_schema(cur, variant, schema, CATALOG_TIMEOUT_SECS)
                cur.execute(
                    _timed_select(
                        variant,
                        CATALOG_TIMEOUT_SECS,
                        "table_name, table_comment from information_schema.tables "
                        "where table_schema = %s and table_type = 'BASE TABLE' "
                        "order by table_name",
                    ),
                    (resolved,),
                )
                rows = cur.fetchall()
            conn.commit()
            # Empty comments are omitted (`spec/protocol.md` §5.2).
            return [TableInfo(name=name, comment=(comment or None)) for name, comment in rows]
        finally:
            conn.close()

    @wrap_driver_errors(pymysql.Error)
    def table_counts(self, schema: str | None) -> list[tuple[str, int]]:
        conn = self._connect()
        try:
            variant = self._variant_of(conn)
            with conn.cursor() as cur:
                resolved = self._resolve_schema(cur, variant, schema, CATALOG_TIMEOUT_SECS)
                # TABLE_ROWS is a potentially stale InnoDB estimate (`spec/protocol.md` §5.3).
                cur.execute(
                    _timed_select(
                        variant,
                        CATALOG_TIMEOUT_SECS,
                        "table_name, cast(table_rows as signed) from information_schema.tables "
                        "where table_schema = %s and table_type = 'BASE TABLE' "
                        "order by table_name",
                    ),
                    (resolved,),
                )
                rows = cur.fetchall()
            conn.commit()
            # NULL means no estimate yet: emit -1 (`spec/protocol.md` §5.3).
            return [(name, count if count is not None else -1) for name, count in rows]
        finally:
            conn.close()

    @wrap_driver_errors(pymysql.Error)
    def query_table(self, schema: str | None, table: str, opts: QueryOpts) -> TableData:
        conn = self._connect()
        try:
            variant = self._variant_of(conn)
            timeout = opts.timeout_secs
            with conn.cursor() as cur:
                resolved_schema = self._resolve_schema(cur, variant, schema, timeout)
                tables = self._allowed_tables(cur, variant, resolved_schema, timeout)
                if table not in tables:
                    raise NotAllowed(f"table {table!r}")

                column_names = self._allowed_columns(cur, variant, resolved_schema, table, timeout)
                sort = None
                if opts.sort is not None:
                    if opts.sort not in column_names:
                        raise NotAllowed(f"column {opts.sort!r}")
                    sort = opts.sort

                where_clause, filter_values = _build_where_clause(opts.filter or [], column_names)

                cur.execute(
                    _timed_select(
                        variant,
                        timeout,
                        "column_name, data_type, column_comment "
                        "from information_schema.columns "
                        "where table_schema = %s and table_name = %s "
                        "order by ordinal_position",
                    ),
                    (resolved_schema, table),
                )
                column_meta = cur.fetchall()

                pk_columns, fk_columns = self._key_metadata(cur, variant, resolved_schema, table, timeout)
                columns = [
                    ColumnInfo(
                        name=name,
                        type_name=type_name,
                        key=(KeyKind.PK if name in pk_columns else (KeyKind.FK if name in fk_columns else None)),
                        references=fk_columns.get(name),
                        comment=(comment or None),
                    )
                    for name, type_name, comment in column_meta
                ]

                select_list = ", ".join(f"CAST({_quote_ident(c.name)} AS CHAR)" for c in columns)
                order_clause = ""
                if sort is not None:
                    order_clause = (
                        f" order by {_quote_ident(table)}.{_quote_ident(sort)} "
                        f"{'desc' if opts.descending else 'asc'}"
                    )
                sql = _timed_select(
                    variant,
                    timeout,
                    f"{select_list} from {_quote_ident(resolved_schema)}.{_quote_ident(table)}"
                    f"{where_clause}{order_clause} limit %s offset %s",
                )
                conn.use_unicode = False
                try:
                    cur.execute(sql, (*filter_values, opts.limit, opts.offset))
                    mysql_rows = cur.fetchall()
                except pymysql.Error as exc:
                    # MySQL has no SELECT privilege gate; map residual 1142 to NotAllowed.
                    if exc.args and exc.args[0] == 1142:
                        raise NotAllowed(f"table {table!r}") from exc
                    raise
                finally:
                    conn.use_unicode = True
                rows = [
                    {col.name: _decode_cell(value, conn.encoding) for col, value in zip(columns, row, strict=True)}
                    for row in mysql_rows
                ]

                cur.execute(
                    _timed_select(
                        variant,
                        timeout,
                        "cast(table_rows as signed) from information_schema.tables "
                        "where table_schema = %s and table_name = %s",
                    ),
                    (resolved_schema, table),
                )
                (count,) = cur.fetchone()
                total_approx = count if count is not None else -1
            conn.commit()
            return TableData(columns=columns, rows=rows, total_approx=total_approx)
        finally:
            conn.close()

    @wrap_driver_errors(pymysql.Error)
    def common_values(self, schema: str | None, table: str, column: str) -> list[tuple[str, float]]:
        conn = self._connect()
        try:
            variant = self._variant_of(conn)
            with conn.cursor() as cur:
                resolved_schema = self._resolve_schema(cur, variant, schema, CATALOG_TIMEOUT_SECS)
                tables = self._allowed_tables(cur, variant, resolved_schema, CATALOG_TIMEOUT_SECS)
                if table not in tables:
                    raise NotAllowed(f"table {table!r}")
                columns = self._allowed_columns(cur, variant, resolved_schema, table, CATALOG_TIMEOUT_SECS)
                if column not in columns:
                    raise NotAllowed(f"column {column!r}")
            conn.commit()
            # MySQL has no portable common-value statistics (`spec/protocol.md` §5.5).
            return []
        finally:
            conn.close()
