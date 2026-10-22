# Multi-column sort

> **Status:** OPEN · **Area:** frontend, spec

**Where logged:** `design.md` §2 (non-goal), §9 (deferred).

**What it is:** v1 sorts by exactly one column (`sort` in
`frontend/src/core/store.ts` and `QueryOpts.sort` in
`implementations/rust/core/src/db/mod.rs` are singular); multi-column sort is explicitly named as "a future addition,"
not built.

**Tidbits:** touches both layers — backend (`QueryOpts.sort: Option<String>`
would need to become an ordered list, and the SQL `order by` clause built in each
`core/src/db/*.rs` backend would need multiple columns; join views add
`sort_join`, §5.11) and frontend (the store's `sort`/`order`, the
header click handler, and the ▲/▼ rendering). Every `<th>` currently always
renders a dimmed ▲/▼ (full opacity on the active column) so sortability is
visible before the first click and header widths never shift — a
multi-column design needs to extend that to show ordinal position per
header too (`▲1`, `▲2`), not just direction.
