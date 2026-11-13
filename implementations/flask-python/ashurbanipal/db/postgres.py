"""Postgres DbSource implementation (`spec/protocol.md` §5)."""

from __future__ import annotations

import psycopg
from psycopg.abc import Buffer
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.types.string import TextLoader

from ..join import (
    ARRAY,
    BINARY,
    BOOLEAN,
    JSON,
    OTHER,
    TEXT,
    UUID,
    ColMeta,
    ColumnClass,
    Dialect,
    JoinData,
    JoinOpts,
    JoinSpec,
    TableMeta,
    TypedCompare,
    UniqueKey,
    build_select,
    enum_class,
    group_unique_keys,
    plan_join,
    table_order_clause,
    table_schemas,
    table_where_clause,
    tie_break_keys,
    typed_class,
    unknown_join_table,
)
from . import (
    BAD_VALUE_SQLSTATES,
    ColumnPair,
    ColumnRef,
    ConstraintCheck,
    ConstraintFk,
    ConstraintPk,
    ConstraintUnique,
    DbSource,
    Engine,
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
    Unsortable,
    group_referenced_by,
    no_default_schema,
    one_row,
    quote_ident,
    wrap_driver_errors,
)

# Bounds catalog queries (`spec/protocol.md` §6).
CATALOG_TIMEOUT_SECS = 5


class _LenientTextLoader(TextLoader):
    """Use the protocol sentinel when psycopg cannot decode text."""

    def load(self, data: Buffer) -> bytes | str:
        try:
            return super().load(data)
        except UnicodeDecodeError:
            return "<undecodable>"


_JOIN_DIALECT = Dialect(
    quote=quote_ident,
    cast_text=lambda expr: f"{expr}::text",
    cast_param=lambda ph, target: f"{ph}::{target}",
    placeholder="%s",
    ilike="native",
)


def typed_compare(data_type: str) -> TypedCompare | None:
    """The typed filter comparison for an `information_schema.columns.data_type`
    (`spec/protocol.md` §5.4.2); the cast target matches the column's own type
    so `real` compares as `real`."""
    return _PG_TYPED.get(data_type)


_PG_TYPED: dict[str, TypedCompare] = {
    "smallint": TypedCompare("pg-numeric", "numeric", "int8"),
    "integer": TypedCompare("pg-numeric", "numeric", "int8"),
    "bigint": TypedCompare("pg-numeric", "numeric", "int8"),
    "numeric": TypedCompare("pg-numeric", "numeric"),
    "real": TypedCompare("pg-float", "real"),
    "double precision": TypedCompare("pg-float", "float8"),
    "date": TypedCompare("pg-date", "date"),
    "timestamp without time zone": TypedCompare("pg-timestamp", "timestamp"),
    "timestamp with time zone": TypedCompare("pg-timestamptz", "timestamptz"),
    "time without time zone": TypedCompare("pg-time", "time"),
    "time with time zone": TypedCompare("pg-timetz", "timetz"),
}


def column_class(data_type: str, udt_schema: str, udt_name: str, is_enum: bool) -> ColumnClass:
    """`spec/protocol.md` §5.11.2; the mapping is in `docs/adapter-decisions.md` §5.11."""
    if (typed := typed_class(typed_compare(data_type))) is not None:
        return typed
    if data_type in ("character varying", "character", "text"):
        return TEXT
    if data_type == "uuid":
        return UUID
    if data_type == "boolean":
        return BOOLEAN
    if data_type == "bytea":
        return BINARY
    if data_type in ("json", "jsonb"):
        return JSON
    if data_type == "ARRAY":
        return ARRAY
    if data_type == "USER-DEFINED":
        if is_enum:
            return enum_class(f"{udt_schema}.{udt_name}")
        if udt_name == "citext":
            return TEXT
    return OTHER


class PgSource(DbSource):
    engine: Engine = "postgres"

    def __init__(self, dsn: str):
        # Typed filters read values in ISO form, and a cell's text must be
        # one; appended so a DSN's own `options` (a search_path) still apply.
        params = conninfo_to_dict(dsn)
        params["options"] = f"{params.get('options', '')} -c datestyle=ISO".strip()
        self._dsn = make_conninfo("", **params)

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

    def _default_schema(self, cur: psycopg.Cursor) -> str | None:
        # None when no schema on the session's search_path exists.
        cur.execute("select current_schema()")
        schema: str | None = one_row(cur)[0]
        return schema

    def _resolve_schema(self, cur: psycopg.Cursor, requested: str | None) -> str:
        return self._resolve_schema_among(cur, self._list_schemas(cur), requested)

    def _resolve_schema_among(self, cur: psycopg.Cursor, schemas: list[str], requested: str | None) -> str:
        """`_resolve_schema` against a schema list already fetched in this transaction."""
        resolved = requested if requested is not None else self._default_schema(cur)
        if resolved is None:
            raise no_default_schema()
        if resolved not in schemas:
            raise NotAllowed(f"schema {resolved!r}", kind=NotAllowedKind.SCHEMA)
        return resolved

    def _readable_table_oid(self, cur: psycopg.Cursor, schema: str, table: str) -> int:
        # Resolves table to its OID iff it's a readable base table in
        # schema — the single existence-and-privilege check every
        # table-scoped operation needs before touching request-supplied
        # SQL. Mirrors list_tables' own pg_class/relkind = 'r' predicate,
        # not information_schema.tables' broader BASE TABLE (which also
        # matches partitioned tables) — keeps this gate and list_tables in
        # lockstep (docs/adapter-decisions.md §5.2/§5.3). One targeted row
        # instead of fetching every table name in the schema to check
        # membership of one.
        #
        # Postgres text can never hold a NUL byte, so no real relname could
        # ever match one; short-circuit before it reaches the driver, which
        # otherwise throws its own encoding error ahead of fetchone() ever
        # getting a chance to just say "no match" (spec/protocol.md §5.2).
        if "\0" in table:
            raise NotAllowed(f"table {table!r}", kind=NotAllowedKind.TABLE)
        cur.execute(
            "select c.oid from pg_class c "
            "join pg_namespace n on n.oid = c.relnamespace "
            "where n.nspname = %s and c.relname = %s and c.relkind = 'r' "
            "  and has_table_privilege(c.oid, 'SELECT')",
            (schema, table),
        )
        row = cur.fetchone()
        if row is None:
            raise NotAllowed(f"table {table!r}", kind=NotAllowedKind.TABLE)
        oid: int = row[0]
        return oid

    def _allowed_columns(self, cur: psycopg.Cursor, schema: str, table: str) -> list[str]:
        cur.execute(
            "select column_name from information_schema.columns "
            "where table_schema = %s and table_name = %s "
            "order by ordinal_position",
            (schema, table),
        )
        return [row[0] for row in cur.fetchall()]

    def _key_metadata(self, cur: psycopg.Cursor, schema: str, oid: int) -> tuple[set[str], dict[str, ColumnRef]]:
        """Read pg_constraint, which has no privilege filter, so a role that
        doesn't own the table still sees its keys. Composite foreign keys, and
        ones whose target the role can't open, are left out (`spec/protocol.md` §5.4.1)."""
        cur.execute(
            "select con.contype = 'p', a.attname::text, rn.nspname::text, rc.relname::text, ra.attname::text "
            "from pg_constraint con "
            "cross join lateral unnest(con.conkey) k(attnum) "
            "join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum "
            "left join pg_class rc on con.contype = 'f' and rc.oid = con.confrelid "
            "left join pg_namespace rn on rn.oid = rc.relnamespace "
            "left join pg_attribute ra on ra.attrelid = rc.oid and ra.attnum = con.confkey[1] "
            "where con.conrelid = %s "
            "  and (con.contype = 'p' "
            "       or (con.contype = 'f' and cardinality(con.conkey) = 1 and rc.relkind = 'r' "
            "           and has_schema_privilege(rc.relnamespace, 'USAGE') "
            "           and has_table_privilege(rc.oid, 'SELECT')))",
            (oid,),
        )
        pk_columns: set[str] = set()
        fk_columns: dict[str, ColumnRef] = {}
        for primary, column, ref_schema, ref_table, ref_column in cur.fetchall():
            if primary:
                pk_columns.add(column)
            elif ref_schema is not None and ref_table is not None and ref_column is not None:
                fk_columns[column] = ColumnRef(
                    table=ref_table,
                    column=ref_column,
                    schema=ref_schema if ref_schema != schema else None,
                )
        return pk_columns, fk_columns

    @wrap_driver_errors(psycopg.Error)
    def list_schemas(self) -> SchemaListing:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(f"SET LOCAL statement_timeout = '{CATALOG_TIMEOUT_SECS}s'")
            return SchemaListing(self._list_schemas(cur), self._default_schema(cur))

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
                oid = self._readable_table_oid(cur, resolved_schema, table)

                # The join route's lookup, so both routes report the same columns; its
                # names are the live catalog's, so they also serve as the allow-list.
                meta = self._table_meta(cur, resolved_schema, table, oid)
                columns = [c.column_info() for c in meta.columns]
                column_names = [c.name for c in columns]
                sort = None
                if opts.sort is not None:
                    if opts.sort not in column_names:
                        raise NotAllowed(f"column {opts.sort!r}", kind=NotAllowedKind.COLUMN)
                    sort = opts.sort

                where_clause, filter_values = table_where_clause(opts.filter or [], meta, _JOIN_DIALECT)

                select_list = ", ".join(f"{quote_ident(c.name)}::text" for c in columns)
                order_clause = table_order_clause(meta, sort, opts.descending, quote_ident)
                query = (
                    f"select {select_list} from {quote_ident(resolved_schema)}.{quote_ident(table)}"
                    f"{where_clause}{order_clause} limit %s offset %s"
                )
                try:
                    cur.execute(query, (*filter_values, opts.limit, opts.offset))
                except psycopg.errors.InsufficientPrivilege as exc:
                    # The allow-list already rejects tables the role can't
                    # SELECT, so a permission denied here is a residual edge;
                    # report it as NotAllowed(NOT_READABLE) (400), not a
                    # driver 500.
                    raise NotAllowed(f"table {table!r}", kind=NotAllowedKind.NOT_READABLE) from exc
                except psycopg.errors.UndefinedFunction as exc:
                    # With a sort, an undefined function is the sort column's type
                    # having no ordering operator (json, xml, geometric types).
                    if sort is None:
                        raise
                    raise Unsortable(sort) from exc
                except psycopg.DataError as exc:
                    # psycopg's str dumper rejects a NUL byte client-side (no
                    # SQLSTATE, unlike other drivers' server-side rejection);
                    # mapped to FilterParseError, also 400, never a raw 500
                    # (docs/adapter-decisions.md §5.4.2).
                    if not filter_values or exc.sqlstate not in (None, *BAD_VALUE_SQLSTATES):
                        raise
                    raise FilterParseError(f"value invalid for this backend: {exc}") from exc
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
                total_approx = one_row(cur)[0]

                return TableData(columns=columns, rows=rows, total_approx=total_approx)

    def _table_meta(self, cur: psycopg.Cursor, schema: str, table: str, oid: int) -> TableMeta:
        """Column metadata of a table already cleared by `_readable_table_oid`, which supplies `oid`."""
        # information_schema.columns drives the list (column privileges, order);
        # pg_attribute adds the full type spelling, comment and collation, keyed
        # by attnum, which can diverge from ordinal_position after a drop. The
        # default collation (oid 100) is left out: it yields to an explicit one
        # in a comparison, so it never clashes.
        cur.execute(
            "select c.column_name, c.data_type, c.udt_schema, c.udt_name, "
            "       exists (select 1 from pg_type t "
            "               join pg_namespace n on n.oid = t.typnamespace "
            "               where n.nspname = c.udt_schema and t.typname = c.udt_name "
            "                 and t.typtype = 'e'), "
            "       format_type(a.atttypid, a.atttypmod), "
            "       col_description(a.attrelid, a.attnum::int), "
            "       (select case when n.nspname = 'pg_catalog' then co.collname "
            "                    else n.nspname || '.' || co.collname end "
            "          from pg_collation co "
            "          join pg_namespace n on n.oid = co.collnamespace "
            "         where co.oid = a.attcollation and a.attcollation not in (0, 100)) "
            "from information_schema.columns c "
            "join pg_attribute a on a.attrelid = %s and a.attname = c.column_name "
            "where c.table_schema = %s and c.table_name = %s "
            "order by c.ordinal_position",
            (oid, schema, table),
        )
        column_rows = list(cur.fetchall())
        pk_columns, fk_columns = self._key_metadata(cur, schema, oid)
        columns = [
            ColMeta(
                name=name,
                type_name=full_type,
                column_class=column_class(data_type, udt_schema, udt_name, is_enum),
                compare=typed_compare(data_type),
                key=(KeyKind.PK if name in pk_columns else (KeyKind.FK if name in fk_columns else None)),
                references=fk_columns.get(name),
                collation=collation,
                comment=comment,
            )
            for name, data_type, udt_schema, udt_name, is_enum, full_type, comment, collation in column_rows
        ]
        return TableMeta(
            schema=schema,
            name=table,
            columns=columns,
            order_keys=tie_break_keys(columns, self._unique_keys(cur, oid)),
        )

    def _unique_keys(self, cur: psycopg.Cursor, oid: int) -> list[UniqueKey]:
        """The primary key and every unique index that can break ties: plain key
        columns (INCLUDE columns left out), not partial, all NOT NULL, and each in
        its column's own collation, so the key is unique under the order by.
        pg_index has no privilege filter, unlike information_schema, so a role with
        only SELECT still sees the key."""
        cur.execute(
            "select c.relname, i.indisprimary, a.attname, "
            "a.attnotnull and i.indcollation[k.n::int - 1] = a.attcollation "
            "from pg_index i "
            "join pg_class c on c.oid = i.indexrelid "
            "cross join lateral unnest(i.indkey::int2[]) with ordinality k(attnum, n) "
            "join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum "
            "where i.indrelid = %s and i.indisunique and i.indisvalid "
            "  and i.indpred is null and i.indexprs is null and k.n <= i.indnkeyatts "
            "order by c.relname, k.n",
            (oid,),
        )
        return group_unique_keys(
            (index, primary, column, primary or usable) for index, primary, column, usable in cur.fetchall()
        )

    @wrap_driver_errors(psycopg.Error)
    def query_join(self, schema: str | None, spec: JoinSpec, opts: JoinOpts) -> JoinData:
        with self._connect() as conn:
            conn.adapters.register_loader("text", _LenientTextLoader)
            with conn.cursor() as cur:
                cur.execute(f"SET LOCAL statement_timeout = '{int(opts.timeout_secs)}s'")
                listed = self._list_schemas(cur)
                resolved_schema = self._resolve_schema_among(cur, listed, schema)
                refs = spec.table_refs()
                schemas = table_schemas(refs, resolved_schema, listed)
                metas: dict[tuple[str, str], TableMeta] = {}
                tables = []
                for key in zip(schemas, (name for _, name in refs), strict=True):
                    if key not in metas:
                        try:
                            oid = self._readable_table_oid(cur, *key)
                            metas[key] = self._table_meta(cur, *key, oid)
                        except NotAllowed as e:
                            raise unknown_join_table(e, key[1]) from None
                    tables.append(metas[key])
                plan = plan_join(spec, tables, opts)

                # The statement is built from catalog names and generated
                # aliases only; every value is a bound parameter.
                body, values = build_select(plan, _JOIN_DIALECT)
                try:
                    cur.execute(f"select {body}", (*values, opts.limit + 1, opts.offset))
                except psycopg.errors.InsufficientPrivilege as exc:
                    raise NotAllowed(f"table {spec.table!r}", kind=NotAllowedKind.NOT_READABLE) from exc
                except psycopg.errors.UndefinedFunction as exc:
                    if opts.sort is None:
                        raise
                    raise Unsortable(opts.sort) from exc
                except psycopg.DataError as exc:
                    if not values or exc.sqlstate not in (None, *BAD_VALUE_SQLSTATES):
                        raise
                    raise FilterParseError(f"value invalid for this backend: {exc}") from exc
                rows, has_more = plan.rows_from(
                    cur.fetchall(), opts.limit, lambda v: None if v is None else str(v)
                )
                return JoinData(columns=plan.column_infos(resolved_schema), rows=rows, has_more=has_more)

    @wrap_driver_errors(psycopg.Error)
    def common_values(self, schema: str | None, table: str, column: str) -> list[tuple[str, float]]:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(f"SET LOCAL statement_timeout = '{CATALOG_TIMEOUT_SECS}s'")
            resolved_schema = self._resolve_schema(cur, schema)
            self._readable_table_oid(cur, resolved_schema, table)
            columns = self._allowed_columns(cur, resolved_schema, table)
            if column not in columns:
                raise NotAllowed(f"column {column!r}", kind=NotAllowedKind.COLUMN)

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

    @wrap_driver_errors(psycopg.Error)
    def referenced_by(self, schema: str | None, table: str) -> list[ReferencedBy]:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(f"SET LOCAL statement_timeout = '{CATALOG_TIMEOUT_SECS}s'")
            resolved_schema = self._resolve_schema(cur, schema)
            target_oid = self._readable_table_oid(cur, resolved_schema, table)

            # pg_catalog, not information_schema: the reverse (confrelid)
            # filter over the standard-SQL views runs 20-40x slower on a
            # large catalog (docs/adapter-decisions.md §5.9).
            # has_table_privilege is the per-referrer read gate and works
            # across schemas, so cross-schema referrers are reported and
            # gated without a separate allow-list pass. conparentid = 0
            # excludes a partitioned referrer's per-partition constraint
            # copies (Postgres clones the parent's FK onto each partition)
            # — without it, one logical FK fans out into one entry per
            # partition plus the parent. relkind = 'r' gates the referrer
            # itself the same way target_oid above gates the target: a
            # partitioned table's own (non-inherited) FK constraint survives
            # conparentid = 0 and would otherwise be reported as a referrer
            # name that query_table/common_values/referenced_by-as-target
            # then all reject, since none accept relkind = 'p'.
            cur.execute(
                "select rn.nspname, rc.relname, con.conname, fa.attname, ta.attname "
                "from pg_constraint con "
                "join pg_class rc on rc.oid = con.conrelid "
                "join pg_namespace rn on rn.oid = rc.relnamespace "
                "join lateral unnest(con.conkey, con.confkey) with ordinality "
                "     as k(from_attnum, to_attnum, n) on true "
                "join pg_attribute fa on fa.attrelid = con.conrelid and fa.attnum = k.from_attnum "
                "join pg_attribute ta on ta.attrelid = con.confrelid and ta.attnum = k.to_attnum "
                "where con.contype = 'f' "
                "  and con.conparentid = 0 "
                "  and con.confrelid = %s "
                "  and rc.relkind = 'r' "
                "  and has_table_privilege(con.conrelid, 'SELECT') "
                "order by rn.nspname, rc.relname, con.conname, k.n",
                (target_oid,),
            )
            rows = list(cur.fetchall())

        return group_referenced_by(
            [
                ReferencedBy(
                    table=ref_table,
                    constraint=constraint,
                    columns=[ColumnPair(from_=from_col, to=to_col)],
                    schema=ref_schema if ref_schema != resolved_schema else None,
                )
                for ref_schema, ref_table, constraint, from_col, to_col in rows
            ]
        )

    @wrap_driver_errors(psycopg.Error)
    def structure(self, schema: str | None, table: str) -> Structure:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(f"SET LOCAL statement_timeout = '{CATALOG_TIMEOUT_SECS}s'")
            resolved_schema = self._resolve_schema(cur, schema)
            oid = self._readable_table_oid(cur, resolved_schema, table)
            out = Structure()

            # Key columns only (indnkeyatts): trailing indkey entries are
            # INCLUDE columns. An indkey entry of 0 is an expression with no
            # pg_attribute row, so the join is a left join and the entry
            # renders through pg_get_indexdef instead of vanishing.
            cur.execute(
                "select ic.relname::text, am.amname::text, ix.indisunique, "
                "       pg_get_expr(ix.indpred, ix.indrelid), "
                "       coalesce(a.attname::text, pg_get_indexdef(ix.indexrelid, k.n::int, true)) "
                "from pg_index ix "
                "join pg_class ic on ic.oid = ix.indexrelid "
                "join pg_am am on am.oid = ic.relam "
                "join lateral unnest(ix.indkey::int2[]) with ordinality as k(attnum, n) on true "
                "left join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = k.attnum "
                "where ix.indrelid = %s and k.n <= ix.indnkeyatts "
                "order by ic.relname, k.n",
                (oid,),
            )
            for name, method, unique, predicate, column in cur.fetchall():
                if out.indexes and out.indexes[-1].name == name:
                    out.indexes[-1].columns.append(column)
                else:
                    out.indexes.append(
                        IndexInfo(name=name, columns=[column], unique=unique, method=method, predicate=predicate)
                    )

            # PK and UNIQUE need only conkey.
            cur.execute(
                "select con.contype::text, con.conname::text, a.attname::text "
                "from pg_constraint con "
                "join lateral unnest(con.conkey) with ordinality as k(attnum, n) on true "
                "join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum "
                "where con.conrelid = %s and con.contype in ('p', 'u') "
                "order by con.contype desc, con.conname, k.n",
                (oid,),
            )
            for kind, name, column in cur.fetchall():
                if kind == "p":
                    if out.constraints.primary_key is None:
                        out.constraints.primary_key = ConstraintPk(name=name, columns=[])
                    out.constraints.primary_key.columns.append(column)
                elif out.constraints.unique and out.constraints.unique[-1].name == name:
                    out.constraints.unique[-1].columns.append(column)
                else:
                    out.constraints.unique.append(ConstraintUnique(name=name, columns=[column]))

            # FK pairs conkey with confkey; the referenced table is confrelid.
            cur.execute(
                "select con.conname::text, rn.nspname::text, rc.relname::text, "
                "       fa.attname::text, ta.attname::text, "
                "       con.confdeltype::text, con.confupdtype::text "
                "from pg_constraint con "
                "join pg_class rc on rc.oid = con.confrelid "
                "join pg_namespace rn on rn.oid = rc.relnamespace "
                "join lateral unnest(con.conkey, con.confkey) with ordinality "
                "     as k(from_attnum, to_attnum, n) on true "
                "join pg_attribute fa on fa.attrelid = con.conrelid and fa.attnum = k.from_attnum "
                "join pg_attribute ta on ta.attrelid = con.confrelid and ta.attnum = k.to_attnum "
                "where con.conrelid = %s and con.contype = 'f' "
                "and not exists (select 1 from pg_constraint par "
                "where par.oid = con.conparentid and par.conrelid = con.conrelid) "
                "order by con.conname, k.n",
                (oid,),
            )
            for name, ref_schema, ref_table, from_col, to_col, del_code, upd_code in cur.fetchall():
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
                            on_delete=_FK_ACTIONS.get(del_code, "NO ACTION"),
                            on_update=_FK_ACTIONS.get(upd_code, "NO ACTION"),
                        )
                    )

            cur.execute(
                "select con.conname::text, pg_get_expr(con.conbin, con.conrelid) "
                "from pg_constraint con "
                "where con.conrelid = %s and con.contype = 'c' "
                "order by con.conname",
                (oid,),
            )
            out.constraints.check = [ConstraintCheck(name=n, expression=d) for n, d in cur.fetchall()]
        return out


# Maps pg_constraint.confdeltype/confupdtype to the vocabulary of spec/protocol.md §5.10.
_FK_ACTIONS = {"c": "CASCADE", "r": "RESTRICT", "n": "SET NULL", "d": "SET DEFAULT", "a": "NO ACTION"}
