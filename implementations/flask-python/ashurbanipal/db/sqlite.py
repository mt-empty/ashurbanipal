"""SQLite `DbSource`; see `docs/adapter-decisions.md` for protocol differences.

`Connection.set_progress_handler` interrupts running queries.
"""

from __future__ import annotations

import re
import sqlite3
import time

from ..filter import Condition
from ..join import (
    BINARY,
    BOOLEAN,
    NUMBER,
    TEMPORAL,
    TEXT,
    TIME,
    UNTYPED,
    UUID,
    ColMeta,
    Dialect,
    JoinData,
    JoinOpts,
    JoinSpec,
    TableMeta,
    TypeClass,
    build_select,
    plan_join,
)
from . import (
    BadJoin,
    ColumnInfo,
    ColumnPair,
    ColumnRef,
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
    Structure,
    TableData,
    TableInfo,
    group_referenced_by,
    quote_ident,
    wrap_driver_errors,
)

CATALOG_TIMEOUT_SECS = 5

_WHERE = re.compile(r"where[\s(]", re.IGNORECASE)


def partial_index_predicate(sql: str) -> str | None:
    """The text after a CREATE INDEX statement's top-level WHERE, ignoring
    quoted text and anything inside parentheses (the column list and
    expression key parts). Only called for indexes `pragma_index_list`
    flags as partial.
    """
    quote = ""
    depth = 0
    for i, ch in enumerate(sql):
        if quote:
            if ch == quote:
                quote = ""
        elif ch in "'\"`":
            quote = ch
        elif ch == "[":
            quote = "]"
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif depth == 0 and ch.isspace():
            rest = sql[i + 1 :]
            if _WHERE.match(rest):
                return rest[5:].strip()
    return None


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
    (spec/protocol.md §5.4.3).
    """
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return "<undecodable>"


def _check_schema(schema: str | None) -> None:
    if schema is not None and schema != ONLY_SCHEMA:
        raise NotAllowed(f"schema {schema!r}", kind=NotAllowedKind.SCHEMA)


def _build_where_clause(conditions: list[Condition], column_names: list[str]) -> tuple[str, list[str]]:
    if not conditions:
        return "", []

    values: list[str] = []
    clause_parts: list[str] = []
    for i, cond in enumerate(conditions):
        if cond.column not in column_names:
            raise NotAllowed(f"column {cond.column!r}", kind=NotAllowedKind.COLUMN)
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


_JOIN_DIALECT = Dialect(
    quote=quote_ident,
    cast_text=lambda expr: f"CAST({expr} AS TEXT)",
    placeholder="?",
    ilike="like",
)


def type_class(declared: str) -> TypeClass | None:
    """Recognised names first, then SQLite's own affinity rules
    (`docs/adapter-decisions.md` §5.11).
    """
    upper = declared.strip().upper()
    if not upper:
        return UNTYPED
    base = upper.split("(")[0].strip()
    if base == "UUID":
        return UUID
    if base in ("BOOLEAN", "BOOL"):
        return BOOLEAN
    if base in ("DATE", "DATETIME") or base.startswith("TIMESTAMP"):
        return TEMPORAL
    if base == "TIME":
        return TIME
    if base in ("JSON", "JSONB"):
        return None
    if "INT" in upper:
        return NUMBER
    if "CHAR" in upper or "CLOB" in upper or "TEXT" in upper:
        return TEXT
    if "BLOB" in upper:
        return BINARY
    if "REAL" in upper or "FLOA" in upper or "DOUB" in upper:
        return None
    return NUMBER


class SqliteSource(DbSource):
    def __init__(self, path: str):
        self._path = path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._path)
        conn.text_factory = _lenient_text_factory
        return conn

    def _bounded(self, conn: sqlite3.Connection, timeout_secs: int) -> None:
        """Installs the per-query timeout interrupt."""
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
        # PRAGMA cannot bind table names; callers supply an allow-listed table.
        cur.execute(f"select cid, name from pragma_table_info({quote_ident(table)}) order by cid")
        return [row[1] for row in cur.fetchall()]

    def _key_metadata(self, cur: sqlite3.Cursor, table: str) -> tuple[list[str], dict[str, ColumnRef]]:
        quoted = quote_ident(table)
        cur.execute(f"select cid, name, pk from pragma_table_info({quoted}) order by cid")
        pk_columns = [name for _, name, pk in cur.fetchall() if pk > 0]

        # (id, seq, table, from, to) — id groups columns belonging to the
        # same constraint (composite FKs share an id).
        #
        # "REFERENCES parent" shorthand leaves "to" NULL; ppk resolves it by
        # position against the parent's PK, correlated per FK row since each
        # can reference a different parent — unlike referenced_by's single
        # bound parent (docs/adapter-decisions.md §5.4.1).
        cur.execute(
            f'select fkl.id, fkl.seq, fkl."table", fkl."from", coalesce(fkl."to", ppk.name, \'rowid\') '
            f"from pragma_foreign_key_list({quoted}) fkl "
            f'left join pragma_table_info(fkl."table") ppk on ppk.pk = fkl.seq + 1'
        )
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

    @wrap_driver_errors(sqlite3.Error)
    def list_tables(self, schema: str | None) -> list[TableInfo]:
        _check_schema(schema)
        conn = self._connect()
        try:
            self._bounded(conn, CATALOG_TIMEOUT_SECS)
            try:
                names = self._allowed_tables(conn.cursor())
            finally:
                self._clear_bound(conn)
        finally:
            conn.close()
        # No obj_description equivalent in SQLite — comments unsupported.
        return [TableInfo(name=name, comment=None) for name in names]

    @wrap_driver_errors(sqlite3.Error)
    def table_counts(self, schema: str | None) -> list[tuple[str, int]]:
        _check_schema(schema)
        conn = self._connect()
        try:
            self._bounded(conn, CATALOG_TIMEOUT_SECS)
            try:
                names = self._allowed_tables(conn.cursor())
            finally:
                self._clear_bound(conn)
        finally:
            conn.close()
        # No reltuples-equivalent catalog estimate; -1 is the documented
        # "no estimate" sentinel (spec/protocol.md §5.3), not a per-table
        # COUNT(*) scan. See docs/adapter-decisions.md.
        return [(name, -1) for name in names]

    @wrap_driver_errors(sqlite3.Error)
    def query_table(self, schema: str | None, table: str, opts: QueryOpts) -> TableData:
        _check_schema(schema)
        conn = self._connect()
        try:
            cur = conn.cursor()
            self._bounded(conn, CATALOG_TIMEOUT_SECS)
            try:
                tables = self._allowed_tables(cur)
                if table not in tables:
                    raise NotAllowed(f"table {table!r}", kind=NotAllowedKind.TABLE)

                column_names = self._allowed_columns(cur, table)
                sort = None
                if opts.sort is not None:
                    if opts.sort not in column_names:
                        raise NotAllowed(f"column {opts.sort!r}", kind=NotAllowedKind.COLUMN)
                    sort = opts.sort

                where_clause, filter_values = _build_where_clause(opts.filter or [], column_names)

                pk_columns, fk_columns = self._key_metadata(cur, table)
                quoted_table = quote_ident(table)
                cur.execute(f"select cid, name, type from pragma_table_info({quoted_table}) order by cid")
                columns = []
                for _, name, type_name in cur.fetchall():
                    if name in pk_columns:
                        key = KeyKind.PK
                    elif name in fk_columns:
                        key = KeyKind.FK
                    else:
                        key = None
                    columns.append(
                        ColumnInfo(
                            name=name,
                            # SQLite's declared column types can be empty (""),
                            # fall back to a stable label rather than emitting "".
                            type_name=type_name or "unknown",
                            key=key,
                            references=fk_columns.get(name),
                            comment=None,
                        )
                    )
            finally:
                self._clear_bound(conn)

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
                {
                    col.name: (None if value is None else str(value))
                    for col, value in zip(columns, row, strict=True)
                }
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

    @wrap_driver_errors(sqlite3.Error)
    def query_join(self, schema: str | None, spec: JoinSpec, opts: JoinOpts) -> JoinData:
        _check_schema(schema)
        conn = self._connect()
        try:
            cur = conn.cursor()
            # One connection and one deadline for the catalog lookups and the
            # select (spec/protocol.md §5.11.5).
            self._bounded(conn, opts.timeout_secs)
            try:
                allowed = self._allowed_tables(cur)
                names = spec.table_names()
                metas: dict[str, TableMeta] = {}
                for name in names:
                    if name in metas:
                        continue
                    if name not in allowed:
                        raise BadJoin(f"unknown table {name!r}")
                    pk_columns, fk_columns = self._key_metadata(cur, name)
                    cur.execute(f"select cid, name, type from pragma_table_info({quote_ident(name)}) order by cid")
                    metas[name] = TableMeta(
                        name=name,
                        columns=[
                            ColMeta(
                                name=col,
                                type_name=declared or "unknown",
                                cls=type_class(declared or ""),
                                key=(
                                    KeyKind.PK
                                    if col in pk_columns
                                    else (KeyKind.FK if col in fk_columns else None)
                                ),
                                references=fk_columns.get(col),
                            )
                            for _, col, declared in cur.fetchall()
                        ],
                    )
                plan = plan_join(spec, [metas[n] for n in names], opts)

                # The statement is built from catalog names and generated
                # aliases only; every value is a bound parameter.
                body, values = build_select(plan, _JOIN_DIALECT, None)
                cur.execute(f"select {body}", (*values, opts.limit + 1, opts.offset))
                rows, has_more = plan.rows_from(
                    cur.fetchall(), opts.limit, lambda v: None if v is None else str(v)
                )
            finally:
                self._clear_bound(conn)
            return JoinData(columns=plan.column_infos(), rows=rows, has_more=has_more)
        finally:
            conn.close()

    @wrap_driver_errors(sqlite3.Error)
    def common_values(self, schema: str | None, table: str, column: str) -> list[tuple[str, float]]:
        _check_schema(schema)
        conn = self._connect()
        try:
            cur = conn.cursor()
            self._bounded(conn, CATALOG_TIMEOUT_SECS)
            try:
                tables = self._allowed_tables(cur)
                if table not in tables:
                    raise NotAllowed(f"table {table!r}", kind=NotAllowedKind.TABLE)
                columns = self._allowed_columns(cur, table)
                if column not in columns:
                    raise NotAllowed(f"column {column!r}", kind=NotAllowedKind.COLUMN)
            finally:
                self._clear_bound(conn)
        finally:
            conn.close()
        # No pg_stats equivalent to read; an empty list is the documented
        # "no statistics available" answer (spec/protocol.md §5.5), not a
        # live GROUP BY scan. See docs/adapter-decisions.md.
        return []

    @wrap_driver_errors(sqlite3.Error)
    def referenced_by(self, schema: str | None, table: str) -> list[ReferencedBy]:
        _check_schema(schema)
        conn = self._connect()
        try:
            cur = conn.cursor()
            self._bounded(conn, CATALOG_TIMEOUT_SECS)
            try:
                if table not in self._allowed_tables(cur):
                    raise NotAllowed(f"table {table!r}", kind=NotAllowedKind.TABLE)

                # No reverse-FK index and no information_schema: walk every
                # table's pragma_foreign_key_list (the schema is parsed in
                # memory on open). The TVF argument m.name is a column
                # reference — not spliced; fkl."table" is bound. COLLATE
                # NOCASE because the pragma returns the referenced name as
                # written in the DDL, which SQLite resolves
                # case-insensitively. The sqlite_master predicate here
                # matches _allowed_tables, so every referrer is already
                # allow-listed.
                #
                # "REFERENCES parent" with no parenthesised column list is
                # valid DDL meaning "parent's own primary key", and for that
                # form the pragma reports "to" as NULL rather than filling
                # in the PK name. ppk resolves it: pragma_table_info(table)'s
                # pk column is the 1-indexed position of a column within the
                # parent's primary key, matching fkl.seq's 0-indexed
                # position within the FK's column list — SQLite requires an
                # omitted column list to align position-for-position with
                # the parent PK, so this pairing holds for composite keys
                # too. The 'rowid' fallback covers a parent with no declared
                # primary key, where SQLite's parent key is the implicit
                # rowid.
                cur.execute(
                    'select m.name, fkl.id, fkl."from", coalesce(fkl."to", ppk.name, \'rowid\') '
                    "from sqlite_master m "
                    "join pragma_foreign_key_list(m.name) fkl "
                    "left join pragma_table_info(?) ppk on ppk.pk = fkl.seq + 1 "
                    "where m.type = 'table' "
                    "  and m.name not like 'sqlite\\_%' escape '\\' "
                    '  and fkl."table" = ? collate nocase '
                    "order by m.name, fkl.id, fkl.seq",
                    (table, table),
                )
                rows = cur.fetchall()
            finally:
                self._clear_bound(conn)
        finally:
            conn.close()

        # SQLite FKs are unnamed; fk_<id> is a per-table-stable synthetic
        # label (spec/protocol.md §5.9 permits this).
        return group_referenced_by(
            [
                ReferencedBy(
                    table=ref_table,
                    constraint=f"fk_{fk_id}",
                    columns=[ColumnPair(from_=from_col, to=to_col)],
                    schema=None,
                )
                for ref_table, fk_id, from_col, to_col in rows
            ]
        )

    @wrap_driver_errors(sqlite3.Error)
    def structure(self, schema: str | None, table: str) -> Structure:
        _check_schema(schema)
        out = Structure()
        conn = self._connect()
        try:
            cur = conn.cursor()
            self._bounded(conn, CATALOG_TIMEOUT_SECS)
            try:
                if table not in self._allowed_tables(cur):
                    raise NotAllowed(f"table {table!r}", kind=NotAllowedKind.TABLE)
                # The validated name is quoted into the pragma's
                # table-valued-function argument, never bound (pragma
                # functions cannot bind it).
                quoted = quote_ident(table)

                # key = 1 drops trailing rowid/auxiliary entries. An
                # expression key part has a NULL name and no recoverable text.
                cur.execute(
                    'select il.name, il."unique", il.origin, il.partial, ix.name '
                    f"from pragma_index_list({quoted}) il "
                    "join pragma_index_xinfo(il.name) ix "
                    "where ix.key = 1 "
                    "order by il.name, ix.seqno"
                )
                partial: set[str] = set()
                unique_origin: list[str] = []
                for name, unique, origin, is_partial, column in cur.fetchall():
                    column = column if column is not None else "<expression>"
                    if out.indexes and out.indexes[-1].name == name:
                        out.indexes[-1].columns.append(column)
                        continue
                    if origin == "u":
                        unique_origin.append(name)
                    if is_partial:
                        partial.add(name)
                    out.indexes.append(IndexInfo(name=name, columns=[column], unique=bool(unique), method="btree"))

                cur.execute("select name, sql from sqlite_master where type = 'index' and tbl_name = ?", (table,))
                sql_of = {name: text for name, text in cur.fetchall() if text is not None}
                for idx in out.indexes:
                    if idx.name in partial and idx.name in sql_of:
                        idx.predicate = partial_index_predicate(sql_of[idx.name])
                for name in unique_origin:
                    idx = next(i for i in out.indexes if i.name == name)
                    out.constraints.unique.append(ConstraintUnique(name=name, columns=list(idx.columns)))

                cur.execute(f"select name from pragma_table_info({quoted}) where pk > 0 order by pk")
                pk = [row[0] for row in cur.fetchall()]
                if pk:
                    out.constraints.primary_key = ConstraintPk(columns=pk)

                # "to" is NULL for REFERENCES parent shorthand; ppk resolves
                # it from the parent's primary key
                # (docs/adapter-decisions.md §5.4.1).
                cur.execute(
                    'select fkl.id, fkl."table", fkl."from", coalesce(fkl."to", ppk.name, \'rowid\'), '
                    "       fkl.on_delete, fkl.on_update "
                    f"from pragma_foreign_key_list({quoted}) fkl "
                    'left join pragma_table_info(fkl."table") ppk on ppk.pk = fkl.seq + 1 '
                    "order by fkl.id, fkl.seq"
                )
                last_id = None
                for fk_id, ref_table, from_col, to_col, on_delete, on_update in cur.fetchall():
                    pair = ColumnPair(from_=from_col, to=to_col)
                    fks = out.constraints.foreign_keys
                    if fks and last_id == fk_id:
                        fks[-1].columns.append(pair)
                        continue
                    last_id = fk_id
                    fks.append(
                        ConstraintFk(
                            name=f"fk_{fk_id}",
                            table=ref_table,
                            columns=[pair],
                            on_delete=on_delete.upper(),
                            on_update=on_update.upper(),
                        )
                    )
            finally:
                self._clear_bound(conn)
        finally:
            conn.close()
        return out
