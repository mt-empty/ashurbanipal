"""`GET /api/tables/join` (`spec/protocol.md` §5.11): parsing, planning, SQL
building, and the route end to end against a temporary SQLite file.
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
from ashurbanipal.db import BadJoin, FilterParseError, NotAllowed, QueryTimeout, wrap_driver_errors
from ashurbanipal.db.postgres import type_class as pg_type_class
from ashurbanipal.db.sqlite import SqliteSource
from ashurbanipal.db.sqlite import type_class as sqlite_type_class
from ashurbanipal.filter import Condition, FilterError, parse, parse_for_join
from ashurbanipal.join import (
    NUMBER,
    TEXT,
    UUID,
    ColMeta,
    Dialect,
    JoinOpts,
    TableMeta,
    assign_labels,
    build_select,
    enum_class,
    parse_join,
    plan_join,
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

_PG = Dialect(
    quote=lambda n: '"' + n.replace('"', '""') + '"',
    cast_text=lambda e: f"{e}::text",
    placeholder="%s",
    ilike="native",
)


def _col(name: str, type_name: str, cls) -> ColMeta:
    return ColMeta(name=name, type_name=type_name, cls=cls)


def _orders() -> TableMeta:
    return TableMeta(
        "orders",
        [
            _col("id", "uuid", UUID),
            _col("user_id", "uuid", UUID),
            _col("status", "text", TEXT),
            _col("tags", "ARRAY", None),
        ],
    )


def _users() -> TableMeta:
    return TableMeta("users", [_col("id", "uuid", UUID), _col("email", "text", TEXT)])


def _opts(**kw) -> JoinOpts:
    return JoinOpts(limit=10, offset=0, timeout_secs=5, **kw)


def test_parse_join_accepts_a_valid_join() -> None:
    spec = parse_join(JOIN)
    assert spec.table_names() == ["orders", "users"]
    assert spec.joins[0].left is True


def test_parse_join_rejects_structural_violations() -> None:
    pair = {"left": {"join": 0, "column": "a"}, "right": "b"}
    entry = {"type": "left", "table": "u", "on": [pair]}

    def join(**over) -> str:
        return json.dumps({"table": "o", "joins": [entry], **over})

    cases = {
        "not json": "not json",
        "array": "[]",
        "no joins": json.dumps({"table": "o", "joins": []}),
        "right join": json.dumps({"table": "o", "joins": [{**entry, "type": "right"}]}),
        "uppercase type": json.dumps({"table": "o", "joins": [{**entry, "type": "LEFT"}]}),
        "no pairs": json.dumps({"table": "o", "joins": [{**entry, "on": []}]}),
        "four pairs": json.dumps({"table": "o", "joins": [{**entry, "on": [pair] * 4}]}),
        "forward position": json.dumps(
            {"table": "o", "joins": [{**entry, "on": [{"left": {"join": 1, "column": "a"}, "right": "b"}]}]}
        ),
        "negative position": json.dumps(
            {"table": "o", "joins": [{**entry, "on": [{"left": {"join": -1, "column": "a"}, "right": "b"}]}]}
        ),
        "boolean position": json.dumps(
            {"table": "o", "joins": [{**entry, "on": [{"left": {"join": True, "column": "a"}, "right": "b"}]}]}
        ),
        "operator key": json.dumps({"table": "o", "joins": [{**entry, "on": [{**pair, "op": ">"}]}]}),
        "empty columns": join(columns=[]),
        "duplicate columns": join(columns=[{"join": 0, "column": "a"}, {"join": 0, "column": "a"}]),
        "five tables": json.dumps({"table": "o", "joins": [entry] * 4}),
        "oversize": json.dumps({"table": "t" * 8192, "joins": [entry]}),
        "unknown key": join(x=1),
    }
    for name, raw in cases.items():
        with pytest.raises(BadJoin):
            parse_join(raw)
        print(name)
    parse_join(json.dumps({"table": "o", "joins": [entry] * 3}))  # 4 tables is the limit


def test_plan_join_rejects_unknown_names_hostile_names_and_incompatible_pairs() -> None:
    spec = parse_join(JOIN)
    plan_join(spec, [_orders(), _users()], _opts())

    hostile = parse_join(JOIN.replace('"right": "id"', '"right": "id\\"; drop table users; --"'))
    with pytest.raises(NotAllowed):
        plan_join(hostile, [_orders(), _users()], _opts())

    cross = parse_join(JOIN.replace('"column": "user_id"', '"column": "status"'))
    with pytest.raises(BadJoin, match=r"orders\.status \(text\).*users\.id \(uuid\)"):
        plan_join(cross, [_orders(), _users()], _opts())

    array = parse_join(JOIN.replace('"column": "user_id"', '"column": "tags"'))
    with pytest.raises(BadJoin):
        plan_join(array, [_orders(), _users()], _opts())

    floaty = parse_join(JOIN.replace('"column": "user_id"', '"column": "score"'))
    orders = _orders()
    orders.columns.append(_col("score", "double precision", None))
    with pytest.raises(
        BadJoin, match=r"orders\.score \(double precision\).*floating-point values are not compared exactly"
    ):
        plan_join(floaty, [orders, _users()], _opts())


def test_enums_pair_only_within_one_type_and_collations_must_match() -> None:
    spec = parse_join(
        json.dumps(
            {
                "table": "x",
                "joins": [
                    {"type": "inner", "table": "y", "on": [{"left": {"join": 0, "column": "e"}, "right": "e"}]}
                ],
            }
        )
    )

    def enum_table(name: str, identity: str) -> TableMeta:
        return TableMeta(name, [_col("e", "USER-DEFINED", enum_class(identity))])

    ok = plan_join(spec, [enum_table("x", "a"), enum_table("y", "a")], _opts())
    assert ok.labels == ["e_0", "e_1"]
    with pytest.raises(BadJoin):
        plan_join(spec, [enum_table("x", "a"), enum_table("y", "b")], _opts())

    def text_table(name: str, collation: str) -> TableMeta:
        return TableMeta(name, [ColMeta(name="e", type_name="varchar", cls=TEXT, collation=collation)])

    with pytest.raises(BadJoin, match="collation"):
        plan_join(spec, [text_table("x", "utf8mb4_bin"), text_table("y", "utf8mb4_general_ci")], _opts())


def test_filter_and_sort_positions_are_range_checked() -> None:
    spec = parse_join(JOIN)
    with pytest.raises(FilterParseError):
        plan_join(spec, [_orders(), _users()], _opts(filter=[Condition(column="id", op="IS NULL", join=2)]))
    with pytest.raises(BadJoin):
        plan_join(spec, [_orders(), _users()], _opts(sort_join=1))
    with pytest.raises(NotAllowed):
        plan_join(spec, [_orders(), _users()], _opts(sort="email"))


def test_labels_are_unique_and_stable() -> None:
    assert assign_labels(["id", "id", "email", "id_1"], [0, 1, 1, 0]) == ["id_0", "id_1_2", "email", "id_1"]
    assert assign_labels(["id", "id", "email"], [0, 1, 1]) == ["id_0", "id_1", "email"]


def test_build_select_uses_catalog_names_and_generated_aliases_only() -> None:
    plan = plan_join(
        parse_join(JOIN),
        [_orders(), _users()],
        _opts(
            sort="email",
            sort_join=1,
            filter=[
                Condition(column="email", op="=", value="a@b.c", join=1),
                Condition(column="status", op="IS NULL", logic="OR", not_=True),
            ],
        ),
    )
    body, values = build_select(plan, _PG, "public")
    assert body.startswith('t0."id"::text as c0, ')
    assert ' from "public"."orders" t0 left join "public"."users" t1 on t1."id" = t0."user_id"' in body
    assert ' where (t1."email"::text = %s) OR (NOT (t0."status"::text IS NULL))' in body
    assert body.endswith(' order by t1."email" asc limit %s offset %s')
    assert values == ["a@b.c"]


def test_join_key_in_a_filter_is_only_accepted_by_parse_for_join() -> None:
    raw = '[{"join": 1, "column": "email", "op": "IS NULL"}]'
    with pytest.raises(FilterError):
        parse(raw)
    assert parse_for_join(raw)[0].join == 1
    with pytest.raises(FilterError):
        parse_for_join('[{"join": -1, "column": "email", "op": "IS NULL"}]')


def test_type_classes() -> None:
    assert pg_type_class("integer", "", "", False) == NUMBER
    assert pg_type_class("USER-DEFINED", "public", "mood", True) == enum_class("public.mood")
    for t in ("ARRAY", "jsonb", "json", "double precision", "money"):
        assert pg_type_class(t, "", "", False) is None, t
    assert sqlite_type_class("DECIMAL(10,2)") == NUMBER
    assert sqlite_type_class("VARCHAR(20)") == TEXT
    assert sqlite_type_class("UUID") == UUID
    assert sqlite_type_class("") is not None
    for t in ("REAL", "DOUBLE PRECISION", "JSON"):
        assert sqlite_type_class(t) is None, t


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
    assert body["code"] == "invalid_parameter"
    title = body["title"].lower()
    assert "users.email (text)" in title and "orders.user_id (integer)" in title

    hostile = _get(client, _users_orders("left").replace('"users"', '"users\\"; drop table users; --"'))
    assert hostile.get_json()["code"] == "unknown_table"
    assert _get(client, _users_orders("left"), sort_join=1).status_code == 400
    assert _get(client, _users_orders("left"), sort="id", sort_join="x").status_code == 400
    assert _get(client, _users_orders("left"), schema="other").get_json()["code"] == "unknown_schema"
    assert client.get("/__ashurbanipal/api/tables/join").status_code == 400
    data_with_join = client.get(
        "/__ashurbanipal/api/tables/data?table=users&filter=" + quote('[{"join":0,"column":"id","op":"IS NULL"}]')
    )
    assert data_with_join.get_json()["code"] == "invalid_filter"
