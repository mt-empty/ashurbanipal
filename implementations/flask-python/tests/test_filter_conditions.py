"""The condition classes a host's own DbSource receives in QueryOpts.filter."""

from __future__ import annotations

import pytest

from ashurbanipal.filter import Comparison, Condition, NullCheck, parse


def test_parse_builds_the_class_the_op_takes() -> None:
    conditions = parse(
        '[{"column": "a", "op": "IS NULL"}, {"logic": "AND", "column": "b", "op": "=", "value": "1"}]'
    )
    assert conditions == [
        NullCheck(column="a", op="IS NULL"),
        Comparison(column="b", op="=", value="1", logic="AND"),
    ]
    assert all(isinstance(c, Condition) for c in conditions)


def test_a_null_check_still_reads_as_having_no_value() -> None:
    assert NullCheck(column="a", op="IS NOT NULL").value is None


@pytest.mark.parametrize(
    "build",
    [
        lambda: NullCheck(column="a", op="="),
        lambda: NullCheck(column="a", op="IS NULL", value="x"),
        lambda: Comparison(column="a", op="IS NULL", value="x"),
        lambda: Comparison(column="a", op="=", value=None),
    ],
)
def test_an_op_the_class_does_not_take_is_refused(build) -> None:
    with pytest.raises(ValueError):
        build()
