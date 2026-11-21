"""`GET /api/tables/join` (`spec/protocol.md` §5.11): what the shared join fixture
cannot see, and the route end to end against a temporary SQLite file.
"""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from pathlib import Path
from urllib.parse import quote

import pytest
from flask import Flask

from ashurbanipal.config import Config
from ashurbanipal.db import BadJoin, QueryTimeout, wrap_driver_errors
from ashurbanipal.db.postgres import _JOIN_DIALECT as pg_join_dialect
from ashurbanipal.db.postgres import column_class as pg_column_class
from ashurbanipal.db.sqlite import SqliteSource
from ashurbanipal.db.sqlite import column_class as sqlite_column_class
from ashurbanipal.filter import (
    Comparison,
    FilterError,
    ListComparison,
    form_accepts,
    parse,
    parse_for_join,
)
from ashurbanipal.join import (
    ARRAY,
    FLOAT,
    JSON,
    NUMBER,
    OTHER,
    TEMPORAL,
    TEXT,
    TIME,
    UNTYPED,
    UUID,
    ColMeta,
    JoinOpts,
    TableMeta,
    TypedCompare,
    UniqueKey,
    enum_class,
    group_unique_keys,
    parse_join,
    plan_join,
    table_where_clause,
)
from ashurbanipal.routes import router

JOIN = json.dumps(
    {
        "table": "orders",
        "joins": [
            {"type": "left", "table": "users", "on": [{"left": {"join": 0, "column": "user_id"}, "right": "id"}]}
        ],
    }
)


def _col(name: str, type_name: str, column_class) -> ColMeta:
    return ColMeta(name=name, type_name=type_name, column_class=column_class)


def _orders() -> TableMeta:
    return TableMeta(
        "orders",
        [
            _col("id", "uuid", UUID),
            _col("user_id", "uuid", UUID),
        ],
        schema="public",
        order_keys=[0],
    )


def _users() -> TableMeta:
    return TableMeta(
        "users", [_col("id", "uuid", UUID), _col("email", "text", TEXT)], schema="public", order_keys=[0]
    )


def _opts(**kw) -> JoinOpts:
    return JoinOpts(limit=10, offset=0, timeout_secs=5, **kw)


# Planning and SQL building are covered per engine by spec/fixtures/join-builder-tests.json
# (test_join_fixtures.py).


def test_parse_join_rejects_a_lone_surrogate() -> None:
    entry = {"type": "left", "table": "u", "on": [{"left": {"join": 0, "column": "a"}, "right": "b"}]}
    with pytest.raises(BadJoin):
        parse_join(f'{{"table":"\\ud800","joins":[{json.dumps(entry)}]}}')


def test_filter_rejects_a_lone_surrogate_but_not_a_pair() -> None:
    with pytest.raises(FilterError):
        parse('[{"column":"a","op":"=","value":"\\ud800"}]')
    assert parse('[{"column":"a","op":"=","value":"\\ud83d\\ude00"}]')[0].value == "\U0001f600"


def test_a_float_key_says_why_it_cannot_join() -> None:
    spec = parse_join(JOIN.replace('"column": "user_id"', '"column": "score"'))
    orders = _orders()
    orders.columns.append(_col("score", "double precision", FLOAT))
    with pytest.raises(
        BadJoin, match=r"orders\.score \(double precision\).*floating-point values are not compared exactly"
    ):
        plan_join(spec, [orders, _users()], _opts())


def test_only_a_text_column_reports_its_collation() -> None:
    text = ColMeta(name="name", type_name="varchar(20)", column_class=TEXT, collation="utf8mb4_bin")
    doc = ColMeta(name="doc", type_name="json", column_class=JSON, collation="utf8mb4_bin")
    assert text.column_info().collation == "utf8mb4_bin"
    assert doc.column_info().collation is None


@pytest.mark.parametrize(
    ("form", "value", "ok"),
    [
        ("mysql-decimal", "-12", True),
        ("mysql-decimal", "+3.25", True),
        ("mysql-decimal", "0.5", True),
        ("mysql-decimal", ".5", False),
        ("mysql-decimal", "5.", False),
        ("mysql-decimal", "1e3", False),
        ("mysql-decimal", "abc", False),
        ("mysql-decimal", "", False),
        ("mysql-decimal", "NaN", False),
        ("mysql-decimal", "9" * 35, True),
        ("mysql-decimal", "9" * 36, False),
        ("mysql-float", "1.5e-3", True),
        ("mysql-float", "2E10", True),
        ("mysql-float", "1e", False),
        ("mysql-float", "NaN", False),
        ("mysql-date", "2016-02-29", True),
        ("mysql-date", "2015-02-29", False),
        ("mysql-date", "2016-02-30", False),
        ("mysql-date", "0000-00-00", True),
        ("mysql-date", "0000-01-01", False),
        ("mysql-date", "12000-01-01", False),
        ("mysql-date", "2016-01-01 10:00", False),
        ("mysql-datetime", "2016-01-01", True),
        ("mysql-datetime", "2016-01-01 10:30", True),
        ("mysql-datetime", "2016-01-01T10:30:00.123456", True),
        ("mysql-datetime", "0000-00-00 00:00:00", True),
        ("mysql-datetime", "2016-01-01T10:30:00.1234567", False),
        ("mysql-datetime", "2016-01-01T10:30:00Z", False),
        ("mysql-datetime", "2016-01-01 ", False),
        ("mysql-datetime", "2016-01-01 24:00", False),
        ("mysql-time", "23:59:59", True),
        ("mysql-time", "-01:00:00", True),
        ("mysql-time", "100:00:00.5", True),
        ("mysql-time", "838:59:59", True),
        ("mysql-time", "839:00:00", False),
        ("mysql-time", "9:30", False),
        ("mysql-time", "10:60", False),
        ("pg-numeric", "-12", True),
        ("pg-numeric", "9" * 40, True),
        ("pg-numeric", "NaN", True),
        ("pg-numeric", "-Infinity", True),
        ("pg-numeric", "1e3", False),
        ("pg-numeric", "abc", False),
        ("pg-float", "1e+300", True),
        ("pg-float", "infinity", True),
        ("pg-float", "1e", False),
        ("pg-date", "2016-02-29", True),
        ("pg-date", "2016-02-30", False),
        ("pg-date", "12000-01-01", True),
        ("pg-date", "0044-03-15 BC", True),
        ("pg-date", "0001-02-29 BC", True),
        ("pg-date", "0002-02-29 BC", False),
        ("pg-date", "infinity", True),
        ("pg-date", "-infinity", True),
        ("pg-date", "0000-01-01", False),
        ("pg-date", "0000-00-00", False),
        ("pg-timestamp", "2016-01-01 10:30", True),
        ("pg-timestamp", "0044-03-15 10:00:00 BC", True),
        ("pg-timestamp", "12000-01-01 10:00:00", True),
        ("pg-timestamp", "2016-01-01 24:00:00", True),
        ("pg-timestamp", "infinity", True),
        ("pg-timestamp", "2016-01-01T10:30:00Z", False),
        ("pg-time", "23:59:59", True),
        ("pg-time", "24:00", True),
        ("pg-time", "24:00:00.000", True),
        ("pg-time", "24:00:01", False),
        ("pg-time", "10:60", False),
        ("pg-time", "9:30", False),
        ("pg-time", "10:00+02", False),
        ("pg-timestamptz", "2016-01-01 10:00:00+00", True),
        ("pg-timestamptz", "2016-01-01T10:00:00.5+05:30", True),
        ("pg-timestamptz", "1890-01-01 00:00:00+00:53:28", True),
        ("pg-timestamptz", "0044-03-15 10:00:00+00:53:28 BC", True),
        ("pg-timestamptz", "2016-01-01 10:00-0300", True),
        ("pg-timestamptz", "2016-01-01 10:00Z", True),
        ("pg-timestamptz", "2016-01-01", True),
        ("pg-timestamptz", "-infinity", True),
        ("pg-timestamptz", "2016-01-01Z", False),
        ("pg-timestamptz", "2016-01-01 10:00+5", False),
        ("pg-timestamptz", "2016-01-01 10:00+05:3", False),
        ("pg-timetz", "10:00:00+02", True),
        ("pg-timetz", "24:00:00+00", True),
        ("pg-timetz", "10:00", True),
        ("pg-timetz", "10:00+", False),
    ],
)
def test_value_forms(form, value: str, ok: bool) -> None:
    assert form_accepts(form, value) is ok


def test_join_key_in_a_filter_is_only_accepted_by_parse_for_join() -> None:
    raw = '[{"join": 1, "column": "email", "op": "IS NULL"}]'
    with pytest.raises(FilterError):
        parse(raw)
    assert parse_for_join(raw)[0].join == 1
    with pytest.raises(FilterError):
        parse_for_join('[{"join": -1, "column": "email", "op": "IS NULL"}]')


def test_column_classes() -> None:
    assert pg_column_class("integer", "", "", False) == NUMBER
    assert pg_column_class("USER-DEFINED", "public", "mood", True) == enum_class("public.mood")
    for t, expected in (
        ("ARRAY", ARRAY),
        ("jsonb", JSON),
        ("json", JSON),
        ("double precision", FLOAT),
        ("real", FLOAT),
        ("smallint", NUMBER),
        ("date", TEMPORAL),
        ("timestamp without time zone", TEMPORAL),
        ("timestamp with time zone", TEMPORAL),
        ("time without time zone", TIME),
        ("time with time zone", TIME),
        ("money", OTHER),
    ):
        assert pg_column_class(t, "", "", False) == expected, t
    assert pg_column_class("USER-DEFINED", "public", "geometry", False) == OTHER
    assert sqlite_column_class("DECIMAL(10,2)") == NUMBER
    assert sqlite_column_class("VARCHAR(20)") == TEXT
    assert sqlite_column_class("UUID") == UUID
    assert sqlite_column_class("") == UNTYPED
    assert sqlite_column_class("REAL") == FLOAT
    assert sqlite_column_class("DOUBLE PRECISION") == FLOAT
    assert sqlite_column_class("JSON") == JSON


class _Timeout(Exception):
    sqlite_errorcode = 9


class _MysqlTimeout(Exception):
    pass


def test_driver_timeouts_are_named_query_timeout() -> None:
    class _Pg(Exception):
        sqlstate = "57014"

    for exc in (
        _Pg("canceled"),
        _MysqlTimeout(3024, "timeout"),
        _MysqlTimeout(1969, "timeout"),
        _Timeout("interrupted"),
    ):

        @wrap_driver_errors(Exception)
        def boom(e=exc):
            raise e

        with pytest.raises(QueryTimeout):
            boom()


# ----------------------------------------------------------- the route, on SQLite


@pytest.fixture
def client():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        create table users (id integer primary key, email text not null, age integer);
        create table orders (id integer primary key, user_id integer references users(id), status text not null);
        create table order_extra (order_id integer primary key references orders(id), gift_message text);
        """
    )
    for email, age in [("a@x.com", 30), ("b@x.com", 30), ("c@x.com", 40)]:
        conn.execute("insert into users (email, age) values (?, ?)", (email, age))
    conn.execute("insert into orders (user_id, status) values (1, 'open')")
    conn.execute("insert into order_extra (order_id, gift_message) values (1, 'enjoy!')")
    conn.commit()
    conn.close()
    app = Flask(__name__)
    app.register_blueprint(router(Config(enabled=True), [("primary", SqliteSource(path))]))
    yield app.test_client()
    Path(path).unlink()


def _users_orders(kind: str) -> str:
    return json.dumps(
        {
            "table": "users",
            "joins": [
                {
                    "type": kind,
                    "table": "orders",
                    "on": [{"left": {"join": 0, "column": "id"}, "right": "user_id"}],
                }
            ],
        }
    )


def _get(client, join: str, **params):
    query = "&".join([f"join={quote(join)}", *(f"{k}={quote(str(v))}" for k, v in params.items())])
    return client.get(f"/__ashurbanipal/api/tables/join?{query}")


def test_left_join_keeps_unmatched_rows_and_inner_drops_them(client) -> None:
    left = _get(client, _users_orders("left")).get_json()
    assert len(left["rows"]) == 3 and left["has_more"] is False
    assert "total_approx" not in left
    assert sum(1 for r in left["rows"] if r["status"] is None) == 2
    assert len(_get(client, _users_orders("inner")).get_json()["rows"]) == 1


def test_self_join_has_more_and_distinct_labels(client) -> None:
    self_join = json.dumps(
        {
            "table": "users",
            "joins": [
                {"type": "inner", "table": "users", "on": [{"left": {"join": 0, "column": "age"}, "right": "age"}]}
            ],
            "columns": [{"join": 0, "column": "id"}, {"join": 1, "column": "id"}],
        }
    )
    body = _get(client, self_join, limit=2).get_json()
    assert len(body["rows"]) == 2 and body["has_more"] is True
    assert [c["name"] for c in body["columns"]] == ["id_0", "id_1"]


def test_filter_and_sort_on_a_joined_table(client) -> None:
    three = json.dumps(
        {
            "table": "orders",
            "joins": [
                {
                    "type": "left",
                    "table": "users",
                    "on": [{"left": {"join": 0, "column": "user_id"}, "right": "id"}],
                },
                {
                    "type": "left",
                    "table": "order_extra",
                    "on": [{"left": {"join": 0, "column": "id"}, "right": "order_id"}],
                },
            ],
            "columns": [
                {"join": 0, "column": "id"},
                {"join": 1, "column": "email"},
                {"join": 2, "column": "gift_message"},
            ],
        }
    )
    flt = json.dumps([{"join": 1, "column": "email", "op": "LIKE", "value": "a@%"}])
    body = _get(client, three, filter=flt, sort="email", sort_join=1).get_json()
    assert body["rows"] == [{"id": "1", "email": "a@x.com", "gift_message": "enjoy!"}]


def test_errors_use_problem_json_with_informative_titles(client) -> None:
    bad = json.dumps(
        {
            "table": "users",
            "joins": [
                {
                    "type": "left",
                    "table": "orders",
                    "on": [{"left": {"join": 0, "column": "email"}, "right": "user_id"}],
                }
            ],
        }
    )
    resp = _get(client, bad)
    assert resp.status_code == 400
    assert resp.content_type == "application/problem+json"
    body = resp.get_json()
    assert body["code"] == "invalid_join"
    title = body["title"].lower()
    assert "users.email (text)" in title and "orders.user_id (integer)" in title

    hostile = _get(client, _users_orders("left").replace('"users"', '"users\\"; drop table users; --"'))
    assert hostile.get_json()["code"] == "invalid_join"
    assert _get(client, _users_orders("left"), sort_join=1).get_json()["code"] == "invalid_parameter"
    assert _get(client, _users_orders("left"), sort="id", sort_join="x").status_code == 400
    assert _get(client, _users_orders("left"), schema="other").get_json()["code"] == "unknown_schema"
    assert client.get("/__ashurbanipal/api/tables/join").status_code == 400
    data_with_join = client.get(
        "/__ashurbanipal/api/tables/data?table=users&filter=" + quote('[{"join":0,"column":"id","op":"IS NULL"}]')
    )
    assert data_with_join.get_json()["code"] == "invalid_filter"


def test_a_table_in_another_schema_is_reported_under_it() -> None:
    users = _users()
    users.schema = "warehouse"
    plan = plan_join(parse_join(JOIN), [_orders(), users], _opts())
    for c in plan.column_infos("public"):
        assert c.schema == ("warehouse" if c.table == "users" else None), (c.table, c.column)


def test_a_key_with_an_unusable_part_is_dropped() -> None:
    parts = [("a", False, "x", True), ("a", False, "y", False), ("b", False, "x", True)]
    assert group_unique_keys(parts) == [UniqueKey("b", False, ["x"])]


def test_a_mysql_zero_date_compares_the_columns_text_on_the_table_route() -> None:
    col = ColMeta(name="d", type_name="date", column_class=TEMPORAL, compare=TypedCompare("mysql-date"))
    table = TableMeta("t", [col])
    for cond, want in (
        (Comparison(column="d", op="=", value="2016-02-29"), ' where ("d" = %s)'),
        (Comparison(column="d", op="=", value="0000-00-00"), ' where ("d"::text = %s)'),
        (
            ListComparison(column="d", op="IN", value=("2016-02-29", "0000-00-00")),
            ' where ("d"::text IN (%s, %s))',
        ),
    ):
        assert table_where_clause([cond], table, pg_join_dialect)[0] == want
