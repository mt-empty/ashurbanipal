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
from ashurbanipal.db import BadJoin, BadParam, FilterParseError, NotAllowed, QueryTimeout, wrap_driver_errors
from ashurbanipal.db.postgres import column_class as pg_column_class
from ashurbanipal.db.sqlite import SqliteSource
from ashurbanipal.db.sqlite import column_class as sqlite_column_class
from ashurbanipal.filter import (
    Comparison,
    FilterError,
    ListComparison,
    NullCheck,
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
    TEXT,
    UNTYPED,
    UUID,
    ColMeta,
    Dialect,
    JoinOpts,
    TableMeta,
    TypedCompare,
    UniqueKey,
    assign_labels,
    build_select,
    enum_class,
    group_unique_keys,
    join_order_keys,
    order_by_clause,
    parse_join,
    plan_join,
    table_schemas,
    tie_break_keys,
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
    cast_param=lambda ph, t: f"{ph}::{t}",
    placeholder="%s",
    ilike="native",
)


def _col(name: str, type_name: str, column_class) -> ColMeta:
    return ColMeta(name=name, type_name=type_name, column_class=column_class)


def _orders() -> TableMeta:
    return TableMeta(
        "orders",
        [
            _col("id", "uuid", UUID),
            _col("user_id", "uuid", UUID),
            _col("status", "text", TEXT),
            _col("tags", "ARRAY", ARRAY),
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


def test_parse_join_accepts_a_valid_join() -> None:
    spec = parse_join(JOIN)
    assert spec.table_refs() == [(None, "orders"), (None, "users")]
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
        "lone surrogate": f'{{"table":"\\ud800","joins":[{json.dumps(entry)}]}}',
    }
    for name, raw in cases.items():
        with pytest.raises(BadJoin):
            parse_join(raw)
        print(name)
    parse_join(json.dumps({"table": "o", "joins": [entry] * 3}))  # 4 tables is the limit


def test_filter_rejects_a_lone_surrogate_but_not_a_pair() -> None:
    with pytest.raises(FilterError):
        parse('[{"column":"a","op":"=","value":"\\ud800"}]')
    assert parse('[{"column":"a","op":"=","value":"\\ud83d\\ude00"}]')[0].value == "\U0001f600"


def test_plan_join_rejects_unknown_names_hostile_names_and_incompatible_pairs() -> None:
    spec = parse_join(JOIN)
    plan_join(spec, [_orders(), _users()], _opts())

    hostile = parse_join(JOIN.replace('"right": "id"', '"right": "id\\"; drop table users; --"'))
    with pytest.raises(BadJoin):
        plan_join(hostile, [_orders(), _users()], _opts())

    cross = parse_join(JOIN.replace('"column": "user_id"', '"column": "status"'))
    with pytest.raises(BadJoin, match=r"orders\.status \(text\).*users\.id \(uuid\)"):
        plan_join(cross, [_orders(), _users()], _opts())

    array = parse_join(JOIN.replace('"column": "user_id"', '"column": "tags"'))
    with pytest.raises(BadJoin):
        plan_join(array, [_orders(), _users()], _opts())

    floaty = parse_join(JOIN.replace('"column": "user_id"', '"column": "score"'))
    orders = _orders()
    orders.columns.append(_col("score", "double precision", FLOAT))
    with pytest.raises(
        BadJoin, match=r"orders\.score \(double precision\).*floating-point values are not compared exactly"
    ):
        plan_join(floaty, [orders, _users()], _opts())


def test_only_a_text_column_reports_its_collation() -> None:
    text = ColMeta(name="name", type_name="varchar(20)", column_class=TEXT, collation="utf8mb4_bin")
    doc = ColMeta(name="doc", type_name="json", column_class=JSON, collation="utf8mb4_bin")
    assert text.column_info().collation == "utf8mb4_bin"
    assert doc.column_info().collation is None


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
        return TableMeta(name, [ColMeta(name="e", type_name="varchar", column_class=TEXT, collation=collation)])

    with pytest.raises(BadJoin, match="collation"):
        plan_join(spec, [text_table("x", "utf8mb4_bin"), text_table("y", "utf8mb4_general_ci")], _opts())


def test_filter_and_sort_positions_are_range_checked() -> None:
    spec = parse_join(JOIN)
    with pytest.raises(FilterParseError):
        plan_join(spec, [_orders(), _users()], _opts(filter=[NullCheck(column="id", op="IS NULL", join=2)]))
    with pytest.raises(BadParam):
        plan_join(spec, [_orders(), _users()], _opts(sort_join=1))
    with pytest.raises(NotAllowed):
        plan_join(spec, [_orders(), _users()], _opts(sort="email"))


def test_labels_are_unique_and_stable() -> None:
    assert assign_labels(["id", "id", "email", "id_1"], [0, 1, 1, 0]) == ["id_0", "id_1_2", "email", "id_1"]
    assert assign_labels(["id", "id", "email"], [0, 1, 1]) == ["id_0", "id_1", "email"]


def test_typed_columns_compare_in_their_own_type() -> None:
    orders = _orders()
    orders.columns.append(
        ColMeta(
            name="total",
            type_name="integer",
            column_class=NUMBER,
            compare=TypedCompare("number", "numeric", "int8"),
        )
    )
    plan = plan_join(
        parse_join(JOIN),
        [orders, _users()],
        _opts(
            filter=[
                ListComparison(column="total", op="BETWEEN", value=("1", "9.5")),
                ListComparison(column="status", op="IN", value=("a", "b"), logic="AND", not_=True),
                Comparison(column="total", op="LIKE", value="1%", logic="OR"),
            ]
        ),
    )
    body, values = build_select(plan, _PG)
    assert (
        ' where (t0."total" BETWEEN %s::int8 AND %s::numeric) AND (NOT (t0."status"::text IN (%s, %s)))'
        ' OR (t0."total"::text LIKE %s)'
    ) in body
    assert values == ["1", "9.5", "a", "b", "1%"]
    with pytest.raises(FilterParseError, match="'x' for column 'total'"):
        plan_join(
            parse_join(JOIN),
            [orders, _users()],
            _opts(filter=[ListComparison(column="total", op="IN", value=("1", "x"))]),
        )


@pytest.mark.parametrize(
    ("form", "value", "ok"),
    [
        ("number", "-12", True),
        ("number", "+3.25", True),
        ("number", ".5", False),
        ("number", "5.", False),
        ("number", "1e3", False),
        ("number", "9" * 35, True),
        ("number", "9" * 36, False),
        ("float", "1.5e-3", True),
        ("float", "NaN", False),
        ("date", "2016-02-29", True),
        ("date", "2015-02-29", False),
        ("date", "0000-01-01", False),
        ("date", "2016-01-01 10:00", False),
        ("timestamp", "2016-01-01T10:30:00.123456", True),
        ("timestamp", "2016-01-01T10:30:00Z", False),
        ("timestamp", "2016-01-01 ", False),
        ("time", "23:59:59", True),
        ("time", "24:00", False),
        ("time", "9:30", False),
        ("time", "10:00+02", False),
        ("timestamptz", "2016-01-01 10:00:00+00", True),
        ("timestamptz", "2016-01-01T10:00:00.5+05:30", True),
        ("timestamptz", "1890-01-01 00:00:00+00:53:28", True),
        ("timestamptz", "2016-01-01 10:00-0300", True),
        ("timestamptz", "2016-01-01 10:00Z", True),
        ("timestamptz", "2016-01-01", True),
        ("timestamptz", "2016-01-01Z", False),
        ("timestamptz", "2016-01-01 10:00+5", False),
        ("timestamptz", "2016-01-01 10:00+05:3", False),
        ("timetz", "10:00:00+02", True),
        ("timetz", "10:00", True),
        ("timetz", "10:00+", False),
    ],
)
def test_value_forms(form, value: str, ok: bool) -> None:
    assert form_accepts(form, value) is ok


def test_build_select_uses_catalog_names_and_generated_aliases_only() -> None:
    plan = plan_join(
        parse_join(JOIN),
        [_orders(), _users()],
        _opts(
            sort="email",
            sort_join=1,
            filter=[
                Comparison(column="email", op="=", value="a@b.c", join=1),
                NullCheck(column="status", op="IS NULL", logic="OR", not_=True),
            ],
        ),
    )
    body, values = build_select(plan, _PG)
    assert body.startswith('t0."id"::text as c0, ')
    assert ' from "public"."orders" t0 left join "public"."users" t1 on t1."id" = t0."user_id"' in body
    assert ' where (t1."email"::text = %s) OR (NOT (t0."status" IS NULL))' in body
    assert body.endswith(' order by t1."email" asc, t0."id" asc limit %s offset %s')
    assert values == ["a@b.c"]


def _keyed(name: str, cols: list[tuple[str, str]], *key: int) -> TableMeta:
    return TableMeta(name, [_col(n, t, NUMBER) for n, t in cols], order_keys=list(key))


def test_join_order_keys_leave_out_a_key_bound_to_a_fixed_table() -> None:
    i = "int4"
    a = _keyed("a", [("id", i), ("b_id", i)], 0)
    assert join_order_keys([a, _keyed("b", [("id", i)], 0)], [[(0, 1, 0)]]) == [(0, 0)]
    # Composite, bound column by column.
    a3 = _keyed("a", [("id", i), ("x", i), ("y", i)], 0)
    assert join_order_keys([a3, _keyed("b", [("x", i), ("y", i)], 0, 1)], [[(0, 2, 1), (0, 1, 0)]]) == [(0, 0)]
    # Partly bound.
    ax = _keyed("a", [("id", i), ("x", i)], 0)
    assert join_order_keys([ax, _keyed("b", [("x", i), ("y", i)], 0, 1)], [[(0, 1, 0)]]) == [
        (0, 0),
        (1, 0),
        (1, 1),
    ]
    # Across types or collations.
    wide = _keyed("a", [("id", i), ("b_id", "int8")], 0)
    assert join_order_keys([wide, _keyed("b", [("id", i)], 0)], [[(0, 1, 0)]]) == [(0, 0), (1, 0)]
    collated = _keyed("a", [("id", i), ("b_code", "text")], 0)
    collated.columns[1].collation = "C"
    assert join_order_keys([collated, _keyed("b", [("code", "text")], 0)], [[(0, 1, 0)]]) == [(0, 0), (1, 0)]
    # Bound to a keyless table.
    keyless = _keyed("v", [("b_id", i)])
    assert join_order_keys([keyless, _keyed("b", [("id", i)], 0)], [[(0, 0, 0)]]) == [(1, 0)]
    # A left-out table still fixes its row for later joins.
    chain = [
        _keyed("a", [("id", i), ("b_id", i)], 0),
        _keyed("b", [("id", i), ("c_id", i)], 0),
        _keyed("c", [("id", i)], 0),
    ]
    assert join_order_keys(chain, [[(0, 1, 0)], [(1, 1, 0)]]) == [(0, 0)]
    # One binding from a fixed table is enough.
    mixed = [keyless, _keyed("a", [("id", i), ("b_id", i)], 0), _keyed("b", [("id", i)], 0)]
    assert join_order_keys(mixed, [[(0, 0, 1)], [(0, 0, 0), (1, 1, 0)]]) == [(1, 0)]


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


def test_each_table_may_name_its_own_schema() -> None:
    spec = parse_join(
        '{"table":"shipments","schema":"warehouse","joins":[{"type":"left","table":"orders",'
        '"schema":"public","on":[{"left":{"join":0,"column":"order_id"},"right":"id"}]}]}'
    )
    assert spec.table_refs() == [("warehouse", "shipments"), ("public", "orders")]
    on = '"on":[{"left":{"join":0,"column":"user_id"},"right":"id"}]'
    for bad in (
        f'{{"table":"orders","schema":1,"joins":[{{"type":"left","table":"users",{on}}}]}}',
        f'{{"table":"orders","schema":null,"joins":[{{"type":"left","table":"users",{on}}}]}}',
        f'{{"table":"orders","joins":[{{"type":"left","table":"users","schema":["public"],{on}}}]}}',
    ):
        with pytest.raises(BadJoin):
            parse_join(bad)
    with pytest.raises(BadJoin):
        table_schemas(spec.table_refs(), "public", ["public"])


def test_a_table_in_another_schema_is_spliced_and_reported_under_it() -> None:
    users = _users()
    users.schema = "warehouse"
    plan = plan_join(parse_join(JOIN), [_orders(), users], _opts())
    body, _ = build_select(plan, _PG)
    assert ' from "public"."orders" t0 left join "warehouse"."users" t1 ' in body
    for c in plan.column_infos("public"):
        assert c.schema == ("warehouse" if c.table == "users" else None), (c.table, c.column)


def test_tie_break_prefers_the_primary_key_then_the_shortest_unique_key() -> None:
    cols = _orders().columns
    pk = UniqueKey("z_pkey", True, ["status", "id"])
    short = UniqueKey("b", False, ["user_id"])
    tied = UniqueKey("a", False, ["status"])
    hidden = UniqueKey("0", False, ["hidden"])
    assert tie_break_keys(cols, [short, pk]) == [2, 0]
    assert tie_break_keys(cols, [short, tied, hidden]) == [2]
    assert tie_break_keys(cols, []) == []


def test_a_key_with_an_unusable_part_is_dropped() -> None:
    parts = [("a", False, "x", True), ("a", False, "y", False), ("b", False, "x", True)]
    assert group_unique_keys(parts) == [UniqueKey("b", False, ["x"])]


def test_order_by_leaves_out_a_key_already_used_as_sort() -> None:
    def render(i: int) -> str:
        return f"c{i}"

    assert order_by_clause(1, [1, 0], True, render) == " order by c1 desc, c0 desc"
    # `order` applies only with a sort.
    assert order_by_clause(None, [0], True, render) == " order by c0 asc"
    assert order_by_clause(None, [], False, render) == ""
