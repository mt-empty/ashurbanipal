# Multi-column sort

**Where logged:** `design.md` §2 (non-goal), §9 (deferred).

**What it is:** v1 sorts by exactly one column (`state.sort`/`opts.sort` are
singular); multi-column sort is explicitly named as "a future addition,"
not built.

**Tidbits:** touches both layers — backend (`QueryOpts.sort: Option<String>`
would need to become an ordered list, and the SQL `order by` clause built in
`db.rs` would need multiple columns) and frontend (`state.sort`/`order`, the
header click handler, and the ▲/▼ rendering). Every `<th>` currently always
renders a dimmed ▲/▼ (full opacity on the active column) so sortability is
visible before the first click and header widths never shift — a
multi-column design needs to extend that to show ordinal position per
header too (`▲1`, `▲2`), not just direction.
