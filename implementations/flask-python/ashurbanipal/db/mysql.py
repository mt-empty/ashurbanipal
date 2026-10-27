"""MySQL/MariaDB DbSource; use fork-specific query timeouts (`spec/protocol.md` §6)."""

from __future__ import annotations

from urllib.parse import urlsplit

import pymysql

from ..filter import Condition
from ..join import (
    BINARY,
    NUMBER,
    TEMPORAL,
    TEXT,
    TIME,
    UUID,
    ColMeta,
    Dialect,
    JoinData,
    JoinOpts,
    JoinSpec,
    TableMeta,
    TypeClass,
    build_select,
    enum_class,
    plan_join,
)
from . import (
    BadJoin,
    ColumnInfo,
    ColumnPair,
    ColumnRef,
    ConstraintCheck,
    ConstraintFk,
    ConstraintPk,
    ConstraintUnique,
    DbSource,
    FilterParseError,
    IndexInfo,
    KeyKind,
    NotAllowed,
    NotAllowedKind,
    QueryOpts,
    ReferencedBy,
    SchemaListing,
    Structure,
    TableData,
    TableInfo,
    group_referenced_by,
    no_default_schema,
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
            raise NotAllowed(f"column {cond.column!r}", kind=NotAllowedKind.COLUMN)
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


_JOIN_DIALECT = Dialect(
    quote=_quote_ident,
    cast_text=lambda expr: f"CAST({expr} AS CHAR)",
    placeholder="%s",
    ilike="lowered-like",
)


def type_class(data_type: str, column_type: str) -> TypeClass | None:
    """`spec/protocol.md` §5.11.2; the mapping is in `docs/adapter-decisions.md` §5.11."""
    t = data_type.lower()
    if t in ("tinyint", "smallint", "mediumint", "int", "integer", "bigint", "decimal", "numeric"):
        return NUMBER
    if t in ("char", "varchar", "tinytext", "text", "mediumtext", "longtext"):
        return TEXT
    if t in ("date", "datetime", "timestamp"):
        return TEMPORAL
    if t == "time":
        return TIME
    if t in ("binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob"):
        return BINARY
    if t == "uuid":
        return UUID
    if t == "enum":
        return enum_class(column_type)
    return None


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

    def _default_schema(self, cur, variant: str, timeout_secs: int) -> str | None:
        # None when the connection names no database.
        cur.execute(_timed_select(variant, timeout_secs, "database()"))
        (name,) = cur.fetchone()
        return name

    def _resolve_schema(self, cur, variant: str, requested: str | None, timeout_secs: int) -> str:
        schemas = self._list_schemas(cur, variant, timeout_secs)
        if requested is not None:
            resolved = requested
        else:
            resolved = self._default_schema(cur, variant, timeout_secs)
            if resolved is None:
                raise no_default_schema()
        if resolved not in schemas:
            raise NotAllowed(f"schema {resolved!r}", kind=NotAllowedKind.SCHEMA)
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
    def list_schemas(self) -> SchemaListing:
        conn = self._connect()
        try:
            variant = self._variant_of(conn)
            with conn.cursor() as cur:
                listing = SchemaListing(
                    self._list_schemas(cur, variant, CATALOG_TIMEOUT_SECS),
                    self._default_schema(cur, variant, CATALOG_TIMEOUT_SECS),
                )
            conn.commit()
            return listing
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
                    raise NotAllowed(f"table {table!r}", kind=NotAllowedKind.TABLE)

                column_names = self._allowed_columns(cur, variant, resolved_schema, table, timeout)
                sort = None
                if opts.sort is not None:
                    if opts.sort not in column_names:
                        raise NotAllowed(f"column {opts.sort!r}", kind=NotAllowedKind.COLUMN)
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
                    # MySQL has no SELECT privilege gate; map residual 1142
                    # to NotAllowed(NOT_READABLE).
                    if exc.args and exc.args[0] == 1142:
                        raise NotAllowed(f"table {table!r}", kind=NotAllowedKind.NOT_READABLE) from exc
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

    def _join_table_meta(self, cur, variant: str, schema: str, table: str, timeout_secs: int) -> TableMeta:
        cur.execute(
            _timed_select(
                variant,
                timeout_secs,
                "column_name, data_type, column_comment, collation_name, column_type "
                "from information_schema.columns "
                "where table_schema = %s and table_name = %s "
                "order by ordinal_position",
            ),
            (schema, table),
        )
        column_rows = cur.fetchall()
        pk_columns, fk_columns = self._key_metadata(cur, variant, schema, table, timeout_secs)
        return TableMeta(
            name=table,
            columns=[
                ColMeta(
                    name=name,
                    type_name=data_type,
                    cls=type_class(data_type, column_type),
                    collation=collation or None,
                    key=(KeyKind.PK if name in pk_columns else (KeyKind.FK if name in fk_columns else None)),
                    references=fk_columns.get(name),
                    comment=(comment or None),
                )
                for name, data_type, comment, collation, column_type in column_rows
            ],
        )

    @wrap_driver_errors(pymysql.Error)
    def query_join(self, schema: str | None, spec: JoinSpec, opts: JoinOpts) -> JoinData:
        conn = self._connect()
        try:
            variant = self._variant_of(conn)
            timeout = opts.timeout_secs
            with conn.cursor() as cur:
                resolved_schema = self._resolve_schema(cur, variant, schema, timeout)
                allowed = self._allowed_tables(cur, variant, resolved_schema, timeout)
                names = spec.table_names()
                metas: dict[str, TableMeta] = {}
                for name in names:
                    if name in metas:
                        continue
                    if name not in allowed:
                        raise BadJoin(f"unknown table {name!r}")
                    metas[name] = self._join_table_meta(cur, variant, resolved_schema, name, timeout)
                plan = plan_join(spec, [metas[n] for n in names], opts)

                # The statement is built from catalog names and generated
                # aliases only; every value is a bound parameter.
                body, values = build_select(plan, _JOIN_DIALECT, resolved_schema)
                conn.use_unicode = False
                try:
                    cur.execute(_timed_select(variant, timeout, body), (*values, opts.limit + 1, opts.offset))
                    mysql_rows = cur.fetchall()
                except pymysql.Error as exc:
                    if exc.args and exc.args[0] == 1142:
                        raise NotAllowed(f"table {spec.table!r}", kind=NotAllowedKind.NOT_READABLE) from exc
                    raise
                finally:
                    conn.use_unicode = True
                rows, has_more = plan.rows_from(mysql_rows, opts.limit, lambda v: _decode_cell(v, conn.encoding))
            conn.commit()
            return JoinData(columns=plan.column_infos(), rows=rows, has_more=has_more)
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
                    raise NotAllowed(f"table {table!r}", kind=NotAllowedKind.TABLE)
                columns = self._allowed_columns(cur, variant, resolved_schema, table, CATALOG_TIMEOUT_SECS)
                if column not in columns:
                    raise NotAllowed(f"column {column!r}", kind=NotAllowedKind.COLUMN)
            conn.commit()
            # MySQL has no portable common-value statistics (`spec/protocol.md` §5.5).
            return []
        finally:
            conn.close()

    @wrap_driver_errors(pymysql.Error)
    def referenced_by(self, schema: str | None, table: str) -> list[ReferencedBy]:
        conn = self._connect()
        try:
            variant = self._variant_of(conn)
            with conn.cursor() as cur:
                resolved_schema = self._resolve_schema(cur, variant, schema, CATALOG_TIMEOUT_SECS)
                # One allow-list read, shared by the target-table check and
                # the referrer post-filter — MySQL/MariaDB have no
                # cross-schema has_table_privilege gate
                # (docs/adapter-decisions.md §5.9).
                allowed = set(self._allowed_tables(cur, variant, resolved_schema, CATALOG_TIMEOUT_SECS))
                if table not in allowed:
                    raise NotAllowed(f"table {table!r}", kind=NotAllowedKind.TABLE)

                # Read key_column_usage, not referential_constraints, whose
                # referenced-name column MariaDB nulls for a role lacking
                # privilege on the referenced table. table_schema = %s keeps
                # referrers to the resolved database.
                cur.execute(
                    _timed_select(
                        variant,
                        CATALOG_TIMEOUT_SECS,
                        "kcu.table_name, kcu.constraint_name, kcu.column_name, kcu.referenced_column_name "
                        "from information_schema.key_column_usage kcu "
                        "where kcu.referenced_table_schema = %s and kcu.referenced_table_name = %s "
                        "  and kcu.table_schema = %s "
                        "order by kcu.table_name, kcu.constraint_name, kcu.ordinal_position",
                    ),
                    (resolved_schema, table, resolved_schema),
                )
                rows = cur.fetchall()
            conn.commit()
        finally:
            conn.close()

        # Keep the referrer set inside the same allow-list every other
        # route on this backend serves from.
        return group_referenced_by(
            [
                ReferencedBy(
                    table=ref_table,
                    constraint=constraint,
                    columns=[ColumnPair(from_=from_col, to=to_col)],
                    schema=None,
                )
                for ref_table, constraint, from_col, to_col in rows
                if ref_table in allowed
            ]
        )

    @wrap_driver_errors(pymysql.Error)
    def structure(self, schema: str | None, table: str) -> Structure:
        out = Structure()
        conn = self._connect()
        try:
            variant = self._variant_of(conn)
            with conn.cursor() as cur:
                resolved_schema = self._resolve_schema(cur, variant, schema, CATALOG_TIMEOUT_SECS)
                allowed = set(self._allowed_tables(cur, variant, resolved_schema, CATALOG_TIMEOUT_SECS))
                if table not in allowed:
                    raise NotAllowed(f"table {table!r}", kind=NotAllowedKind.TABLE)

                # MariaDB's statistics view has no expression column; MySQL
                # 8.0.13+ reports a functional key part there with a NULL
                # column_name.
                key_part = "s.column_name" if variant == _MARIADB else "coalesce(s.column_name, s.expression)"
                cur.execute(
                    _timed_select(
                        variant,
                        CATALOG_TIMEOUT_SECS,
                        "s.index_name, cast(s.non_unique as signed), s.index_type, "
                        + key_part
                        + " from information_schema.statistics s "
                        "where s.table_schema = %s and s.table_name = %s "
                        "order by s.index_name, s.seq_in_index",
                    ),
                    (resolved_schema, table),
                )
                for name, non_unique, method, column in cur.fetchall():
                    column = column or ""
                    if out.indexes and out.indexes[-1].name == name:
                        out.indexes[-1].columns.append(column)
                    else:
                        out.indexes.append(
                            IndexInfo(
                                name=name, columns=[column], unique=int(non_unique) == 0, method=method.lower()
                            )
                        )

                cur.execute(
                    _timed_select(
                        variant,
                        CATALOG_TIMEOUT_SECS,
                        "tc.constraint_type, tc.constraint_name, kcu.column_name "
                        "from information_schema.table_constraints tc "
                        "join information_schema.key_column_usage kcu "
                        "  on kcu.constraint_schema = tc.constraint_schema "
                        " and kcu.constraint_name = tc.constraint_name "
                        " and kcu.table_schema = tc.table_schema "
                        " and kcu.table_name = tc.table_name "
                        "where tc.table_schema = %s and tc.table_name = %s "
                        "  and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE') "
                        "order by tc.constraint_type desc, tc.constraint_name, kcu.ordinal_position",
                    ),
                    (resolved_schema, table),
                )
                for kind, name, column in cur.fetchall():
                    if kind == "PRIMARY KEY":
                        if out.constraints.primary_key is None:
                            out.constraints.primary_key = ConstraintPk(name=name, columns=[])
                        out.constraints.primary_key.columns.append(column)
                    elif out.constraints.unique and out.constraints.unique[-1].name == name:
                        out.constraints.unique[-1].columns.append(column)
                    else:
                        out.constraints.unique.append(ConstraintUnique(name=name, columns=[column]))

                # Read key_column_usage for the referenced table, not
                # referential_constraints, which MariaDB nulls for a role
                # lacking privilege on it (same reason as referenced_by).
                cur.execute(
                    _timed_select(
                        variant,
                        CATALOG_TIMEOUT_SECS,
                        "kcu.constraint_name, kcu.referenced_table_schema, kcu.referenced_table_name, "
                        "       kcu.column_name, kcu.referenced_column_name, rc.delete_rule, rc.update_rule "
                        "from information_schema.key_column_usage kcu "
                        "join information_schema.referential_constraints rc "
                        "  on rc.constraint_schema = kcu.constraint_schema "
                        " and rc.constraint_name = kcu.constraint_name "
                        " and rc.table_name = kcu.table_name "
                        "where kcu.table_schema = %s and kcu.table_name = %s "
                        "  and kcu.referenced_table_name is not null "
                        "order by kcu.constraint_name, kcu.ordinal_position",
                    ),
                    (resolved_schema, table),
                )
                for name, ref_schema, ref_table, from_col, to_col, delete_rule, update_rule in cur.fetchall():
                    pair = ColumnPair(from_=from_col, to=to_col)
                    fks = out.constraints.foreign_keys
                    if fks and fks[-1].name == name:
                        fks[-1].columns.append(pair)
                    else:
                        fks.append(
                            ConstraintFk(
                                name=name,
                                table=ref_table,
                                schema=ref_schema if ref_schema != resolved_schema else None,
                                columns=[pair],
                                on_delete=delete_rule.upper(),
                                on_update=update_rule.upper(),
                            )
                        )

                # MySQL before 8.0.16 has no check_constraints view: report [].
                cur.execute(
                    _timed_select(
                        variant,
                        CATALOG_TIMEOUT_SECS,
                        "count(*) from information_schema.tables "
                        "where table_schema = 'information_schema' and table_name = 'CHECK_CONSTRAINTS'",
                    )
                )
                if cur.fetchone()[0] > 0:
                    # MariaDB names unnamed table-level checks per table, so
                    # its view carries table_name for the join; MySQL's has none.
                    cc_table = "and cc.table_name = tc.table_name " if variant == _MARIADB else ""
                    cur.execute(
                        _timed_select(
                            variant,
                            CATALOG_TIMEOUT_SECS,
                            "tc.constraint_name, cc.check_clause "
                            "from information_schema.table_constraints tc "
                            "join information_schema.check_constraints cc "
                            "  on cc.constraint_schema = tc.constraint_schema "
                            " and cc.constraint_name = tc.constraint_name "
                            + cc_table
                            + "where tc.table_schema = %s "
                            "  and tc.table_name = %s and tc.constraint_type = 'CHECK' "
                            "order by tc.constraint_name",
                        ),
                        (resolved_schema, table),
                    )
                    out.constraints.check = [ConstraintCheck(name=n, expression=c) for n, c in cur.fetchall()]
            conn.commit()
        finally:
            conn.close()
        return out
