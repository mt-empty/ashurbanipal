"""Postgres DbSource implementation (`spec/protocol.md` §5)."""

from __future__ import annotations

import psycopg
from psycopg.types.string import TextLoader

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
    wrap_driver_errors,
)

# Bounds catalog queries (`spec/protocol.md` §6).
CATALOG_TIMEOUT_SECS = 5


class _LenientTextLoader(TextLoader):
    """Use the protocol sentinel when psycopg cannot decode text."""

    def load(self, data):
        try:
            return super().load(data)
        except UnicodeDecodeError:
            return "<undecodable>"


def _build_where_clause(conditions: list[Condition], column_names: list[str]) -> tuple[str, list[str]]:
    """Validate filter columns before SQL interpolation (`spec/protocol.md` §5.4.2)."""
    if not conditions:
        return "", []

    values: list[str] = []
    clause_parts: list[str] = []
    for i, cond in enumerate(conditions):
        if cond.column not in column_names:
            raise NotAllowed(f"column {cond.column!r}")
        quoted = quote_ident(cond.column)
        if cond.op in ("IS NULL", "IS NOT NULL"):
            inner = f"{quoted}::text {cond.op}"
        else:
            inner = f"{quoted}::text {cond.op} %s"
            values.append(cond.value)
        wrapped = f"(NOT ({inner}))" if cond.not_ else f"({inner})"

        if i > 0:
            if cond.logic not in ("AND", "OR"):
                raise FilterParseError(f"condition {i} is missing logic")
            clause_parts.append(" AND " if cond.logic == "AND" else " OR ")
        clause_parts.append(wrapped)

    return " where " + "".join(clause_parts), values


class PgSource(DbSource):
    def __init__(self, dsn: str):
        self._dsn = dsn

    def _connect(self) -> psycopg.Connection:
        return psycopg.connect(self._dsn)

    def _list_schemas(self, cur: psycopg.Cursor) -> list[str]:
        cur.execute(
            "select nspname from pg_namespace "
            "where nspname not in ('pg_catalog', 'information_schema') "
            "and nspname not like 'pg_toast%%' "
            "and nspname not like 'pg_temp\\_%%' escape '\\' "
            "and has_schema_privilege(nspname, 'USAGE') "
            "order by nspname"
        )
        return [row[0] for row in cur.fetchall()]

    def _resolve_schema(self, cur: psycopg.Cursor, requested: str | None) -> str:
        schemas = self._list_schemas(cur)
        if requested is not None:
            resolved = requested
        else:
            cur.execute("select current_schema()")
            resolved = cur.fetchone()[0]
        if resolved not in schemas:
            raise NotAllowed(f"schema {resolved!r}")
        return resolved

    def _allowed_tables(self, cur: psycopg.Cursor, schema: str) -> list[str]:
        # Keep the allow-list aligned with tables the role can SELECT (spec/protocol.md §5).
        cur.execute(
            "select table_name from information_schema.tables "
            "where table_schema = %s and table_type = 'BASE TABLE' "
            "  and has_table_privilege(format('%%I.%%I', table_schema, table_name), 'SELECT') "
            "order by table_name",
            (schema,),
        )
        return [row[0] for row in cur.fetchall()]

    def _allowed_columns(self, cur: psycopg.Cursor, schema: str, table: str) -> list[str]:
        cur.execute(
            "select column_name from information_schema.columns "
            "where table_schema = %s and table_name = %s "
            "order by ordinal_position",
            (schema, table),
        )
        return [row[0] for row in cur.fetchall()]

    def _key_metadata(self, cur: psycopg.Cursor, schema: str, table: str) -> tuple[set[str], dict[str, ColumnRef]]:
        """Use constraint_schema for cross-schema FKs; omit composites (`spec/protocol.md` §5.4.1)."""
        cur.execute(
            "select tc.constraint_name, tc.constraint_type, kcu.column_name, "
            "       ccu.table_schema as ref_schema, ccu.table_name as ref_table, "
            "       ccu.column_name as ref_column "
            "from information_schema.table_constraints tc "
            "join information_schema.key_column_usage kcu "
            "  on kcu.constraint_name = tc.constraint_name "
            " and kcu.table_schema = tc.table_schema "
            "left join information_schema.constraint_column_usage ccu "
            "  on ccu.constraint_name = tc.constraint_name "
            " and ccu.constraint_schema = tc.table_schema "
            " and tc.constraint_type = 'FOREIGN KEY' "
            "where tc.table_schema = %s "
            "  and tc.table_name = %s "
            "  and tc.constraint_type in ('PRIMARY KEY', 'FOREIGN KEY')",
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
                table=ref_table,
                column=ref_column,
                schema=ref_schema if ref_schema != schema else None,
            )
        return pk_columns, fk_columns

    @wrap_driver_errors(psycopg.Error)
    def list_schemas(self) -> list[str]:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(f"SET LOCAL statement_timeout = '{CATALOG_TIMEOUT_SECS}s'")
            return self._list_schemas(cur)

    @wrap_driver_errors(psycopg.Error)
    def list_tables(self, schema: str | None) -> list[TableInfo]:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(f"SET LOCAL statement_timeout = '{CATALOG_TIMEOUT_SECS}s'")
            resolved = self._resolve_schema(cur, schema)
            cur.execute(
                "select c.relname::text, obj_description(c.oid, 'pg_class') "
                "from pg_class c "
                "join pg_namespace n on n.oid = c.relnamespace "
                "where n.nspname = %s and c.relkind = 'r' "
                "  and has_table_privilege(c.oid, 'SELECT') "
                "order by c.relname",
                (resolved,),
            )
            return [TableInfo(name=name, comment=comment) for name, comment in cur.fetchall()]

    @wrap_driver_errors(psycopg.Error)
    def table_counts(self, schema: str | None) -> list[tuple[str, int]]:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(f"SET LOCAL statement_timeout = '{CATALOG_TIMEOUT_SECS}s'")
            resolved = self._resolve_schema(cur, schema)
            cur.execute(
                "select c.relname::text, c.reltuples::bigint "
                "from pg_class c "
                "join pg_namespace n on n.oid = c.relnamespace "
                "where n.nspname = %s and c.relkind = 'r' "
                "  and has_table_privilege(c.oid, 'SELECT') "
                "order by c.relname",
                (resolved,),
            )
            return list(cur.fetchall())

    @wrap_driver_errors(psycopg.Error)
    def query_table(self, schema: str | None, table: str, opts: QueryOpts) -> TableData:
        with self._connect() as conn:
            # psycopg snapshots adapters when the cursor is created.
            conn.adapters.register_loader("text", _LenientTextLoader)
            with conn.cursor() as cur:
                cur.execute(f"SET LOCAL statement_timeout = '{int(opts.timeout_secs)}s'")

                resolved_schema = self._resolve_schema(cur, schema)
                tables = self._allowed_tables(cur, resolved_schema)
                if table not in tables:
                    raise NotAllowed(f"table {table!r}")

                column_names = self._allowed_columns(cur, resolved_schema, table)
                sort = None
                if opts.sort is not None:
                    if opts.sort not in column_names:
                        raise NotAllowed(f"column {opts.sort!r}")
                    sort = opts.sort

                where_clause, filter_values = _build_where_clause(opts.filter or [], column_names)

                cur.execute(
                    "select column_name, data_type from information_schema.columns "
                    "where table_schema = %s and table_name = %s "
                    "order by ordinal_position",
                    (resolved_schema, table),
                )
                column_types = list(cur.fetchall())

                # attnum survives dropped columns; ordinal_position does not.
                cur.execute(
                    "select a.attname::text, col_description(a.attrelid, a.attnum::int) "
                    "from pg_attribute a "
                    "join pg_class c on c.oid = a.attrelid "
                    "join pg_namespace n on n.oid = c.relnamespace "
                    "where n.nspname = %s and c.relname = %s "
                    "  and a.attnum > 0 and not a.attisdropped",
                    (resolved_schema, table),
                )
                column_comments = {name: comment for name, comment in cur.fetchall() if comment is not None}

                pk_columns, fk_columns = self._key_metadata(cur, resolved_schema, table)
                columns = [
                    ColumnInfo(
                        name=name,
                        type_name=type_name,
                        key=(KeyKind.PK if name in pk_columns else (KeyKind.FK if name in fk_columns else None)),
                        references=fk_columns.get(name),
                        comment=column_comments.get(name),
                    )
                    for name, type_name in column_types
                ]

                select_list = ", ".join(f"{quote_ident(c.name)}::text" for c in columns)
                order_clause = ""
                if sort is not None:
                    # Qualify the source column to avoid ordering the text-cast output.
                    direction = "desc" if opts.descending else "asc"
                    order_clause = f" order by {quote_ident(table)}.{quote_ident(sort)} {direction}"
                query = (
                    f"select {select_list} from {quote_ident(resolved_schema)}.{quote_ident(table)}"
                    f"{where_clause}{order_clause} limit %s offset %s"
                )
                try:
                    cur.execute(query, (*filter_values, opts.limit, opts.offset))
                except psycopg.errors.InsufficientPrivilege as exc:
                    # The allow-list already rejects tables the role can't
                    # SELECT, so a permission denied here is a residual edge;
                    # report it as NotAllowed (400), not a driver 500.
                    raise NotAllowed(f"table {table!r}") from exc
                pg_rows = cur.fetchall()
                rows = [
                    {
                        col.name: (None if value is None else str(value))
                        for col, value in zip(columns, row, strict=True)
                    }
                    for row in pg_rows
                ]

                cur.execute(
                    "select reltuples::bigint from pg_class c "
                    "join pg_namespace n on n.oid = c.relnamespace "
                    "where n.nspname = %s and c.relname = %s",
                    (resolved_schema, table),
                )
                total_approx = cur.fetchone()[0]

                return TableData(columns=columns, rows=rows, total_approx=total_approx)

    @wrap_driver_errors(psycopg.Error)
    def common_values(self, schema: str | None, table: str, column: str) -> list[tuple[str, float]]:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(f"SET LOCAL statement_timeout = '{CATALOG_TIMEOUT_SECS}s'")
            resolved_schema = self._resolve_schema(cur, schema)
            tables = self._allowed_tables(cur, resolved_schema)
            if table not in tables:
                raise NotAllowed(f"table {table!r}")
            columns = self._allowed_columns(cur, resolved_schema, table)
            if column not in columns:
                raise NotAllowed(f"column {column!r}")

            # most_common_vals is anyarray; ::text::text[] reads it
            # uniformly. NULL (no ANALYZE stats yet) unnests to zero rows,
            # not an error.
            cur.execute(
                "select t.val, t.freq "
                "from pg_stats, "
                "     lateral unnest(most_common_vals::text::text[], most_common_freqs) as t(val, freq) "
                "where schemaname = %s and tablename = %s and attname = %s "
                "order by t.freq desc",
                (resolved_schema, table, column),
            )
            rows = list(cur.fetchall())

            cur.execute(
                "select data_type from information_schema.columns "
                "where table_schema = %s and table_name = %s and column_name = %s",
                (resolved_schema, table, column),
            )
            data_type_row = cur.fetchone()
            data_type = data_type_row[0] if data_type_row else None

        # boolean's array-literal text form is "t"/"f", not "true"/"false" —
        # normalize to match query_table's rendering.
        if data_type == "boolean":
            rows = [({"t": "true", "f": "false"}.get(val, val), freq) for val, freq in rows]
        return [(val, float(freq)) for val, freq in rows]
