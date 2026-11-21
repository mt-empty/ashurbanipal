# Golden-SQL fixtures for the join builder

> **Status:** DONE · **Area:** ports, conformance · **Ref:** `spec/fixtures/join-builder-tests.json`, run per engine in all five ports; per-engine `filter-builder-tests.json` is [60](60-per-engine-filter-builder-fixtures.md)

**Ask:** add `spec/fixtures/join-builder-tests.json`, the join counterpart
of `filter-builder-tests.json`. Each case gives a join spec plus the
catalog metadata of its tables, and pins the exact SQL and bind values the
builder must emit. Every port runs it as a unit test, without a database.

**Why:** the join planner and SQL builder are the largest piece of logic
every port writes by hand (about 600–1,000 lines each), and today the only
thing pinning them across ports is HTTP conformance against a live seed.
A port can produce the right rows from different SQL (sort, tie-break,
cast or alias choices) and drift unnoticed until an engine-specific case
breaks. More ports in popular languages are planned, and each new one
should get a ready-made test table instead of re-deriving the join rules
from `spec/join-dsl.md` prose. This is the low-cost alternative to
[11](11-wasm-core-for-multi-language-ports.md): it pins behaviour across
ports without a shared binary or a canonical implementation.

**Shape:** owned by `spec/fixtures/README.md`. SQL is pinned per engine
against engine-native catalogs, so a dialect bug like #283 fails a unit
test, not only HTTP conformance. Giving `filter-builder-tests.json`
per-engine expectations too is [60](60-per-engine-filter-builder-fixtures.md).

**Done when:** the fixture file and its `spec/fixtures/README.md` section
land with a runner in all five ports, and `PORTING.md` lists it among the
fixture sets a new port must pass.
