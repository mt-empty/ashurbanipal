"""The one seam to a database. Route handlers (`routes.py`) only ever call
through the `DbSource` interface below, never a driver directly — mirrors
`implementations/rust/core/src/db/mod.rs`'s `DbSource` trait.

One implementation per backend: `postgres.PgSource`, `sqlite.SqliteSource`,
`mysql.MySqlSource`. Each opens one fresh physical connection per operation
(no pool) and closes it at the end — this trivially satisfies
`spec/protocol.md` §1's "resolve the schema once, reuse for every query in
the operation" invariant, since there is no pooled session to drift out
from under a multi-query operation. See each module's docstring for its
backend-specific catalog/timeout/cast mechanism
(`docs/adapter-decisions.md` has the registry).
"""

from __future__ import annotations

import abc
import functools
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import TypeVar

_F = TypeVar("_F", bound=Callable)


class KeyKind(StrEnum):
    PK = "pk"
    FK = "fk"


@dataclass
class ColumnRef:
    table: str
    column: str
    # Only set when the referenced table lives in a schema other than the
    # referencing column's own — omitted (not null) for the common
    # same-schema case (spec/protocol.md §5.4.1, additive field).
    schema: str | None = None


@dataclass
class ColumnInfo:
    name: str
    type_name: str
    key: KeyKind | None = None
    references: ColumnRef | None = None
    comment: str | None = None


@dataclass
class TableInfo:
    name: str
    comment: str | None = None


@dataclass
class TableData:
    columns: list[ColumnInfo]
    rows: list[dict[str, str | None]]
    total_approx: int


@dataclass
class QueryOpts:
    limit: int
    offset: int
    timeout_secs: int
    sort: str | None = None
    descending: bool = False
    filter: list | None = None  # list[filter.Condition]; typed loosely to avoid a circular import


class DbError(Exception):
    """Base class every DbSource raises; routes.py maps subclasses to HTTP status."""


class NotAllowed(DbError):
    """A table/column/schema name failed the live allow-list check."""


class FilterParseError(DbError):
    """A filter AST condition was structurally invalid at the query-building stage."""


class DatabaseError(DbError):
    """The underlying driver raised (connection failure, timeout, syntax error, ...)."""


def wrap_driver_errors(driver_error_cls: type[BaseException]) -> Callable[[_F], _F]:
    """Decorator: re-raises `driver_error_cls` (a backend driver's own
    exception hierarchy — psycopg.Error, sqlite3.Error, pymysql.err.Error)
    as DatabaseError, so routes.py's `@bp.errorhandler(DbError)` actually
    fires for a real driver failure instead of falling through to Flask's
    default HTML error page. Mirrors mod.rs's `impl From<sqlx::Error> for
    DbError`, which sqlx's `?` applies automatically; Python has no
    equivalent auto-conversion, hence the explicit wrap on every DbSource
    method.
    """

    def decorator(fn: _F) -> _F:
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except driver_error_cls as exc:
                raise DatabaseError(str(exc)) from exc

        return wrapper  # type: ignore[return-value]

    return decorator


class DbSource(abc.ABC):
    """One implementation per backend. No method may run a query the caller
    hasn't first validated an identifier for against a live catalog lookup
    (spec/protocol.md §6) — never accept a `table`/`column`/`schema`
    argument and trust it without that check first.
    """

    @abc.abstractmethod
    def list_schemas(self) -> list[str]: ...

    @abc.abstractmethod
    def list_tables(self, schema: str | None) -> list[TableInfo]: ...

    @abc.abstractmethod
    def table_counts(self, schema: str | None) -> list[tuple[str, int]]: ...

    @abc.abstractmethod
    def query_table(self, schema: str | None, table: str, opts: QueryOpts) -> TableData: ...

    @abc.abstractmethod
    def common_values(self, schema: str | None, table: str, column: str) -> list[tuple[str, float]]: ...


# The hardcoded wire-operator -> SQL-keyword table (spec/protocol.md
# §5.4.2) shared by every backend that maps a wire op straight to a
# keyword; ILIKE has no entry here since no backend maps it that simply —
# see each backend's own build_where_clause (mirrors
# implementations/rust/core/src/db/mod.rs::op_sql).
OP_SQL: dict[str, str] = {
    "=": "=",
    "!=": "!=",
    ">": ">",
    "<": "<",
    ">=": ">=",
    "<=": "<=",
    "LIKE": "LIKE",
    "IS NULL": "IS NULL",
    "IS NOT NULL": "IS NOT NULL",
}


def quote_ident(ident: str) -> str:
    """Doubles embedded `"` — the Postgres/SQLite quoted-identifier escape.
    Every name reaching this must already be allow-list-validated against a
    live catalog lookup; this only makes a validated name syntactically
    safe to splice, it is not itself a validation step. MySQL's default
    quote is the backtick, not `"` — see `mysql.quote_ident_mysql`.
    """
    return '"' + ident.replace('"', '""') + '"'
