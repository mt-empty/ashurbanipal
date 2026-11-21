# Multi-column sort

> **Status:** OPEN · **Area:** frontend, spec, ports, conformance

**Where logged:** `docs/design.md` §2 (non-goal), §9 (deferred).

**What it is:** sort by more than one column. Today `sort` names one
column (`spec/protocol.md` §5.4; joins add `sort_join`, §5.11), and one
`order` applies to it and to the tie-break key after it.

**Tidbits:**
- **Spec.** `sort`/`order` (and `sort_join`) become ordered lists, or a
  new parameter carries the list. Decide each column's direction, and
  which direction the tie-break key takes (today: the `order` direction).
  A new optional parameter keeps v1; changing `sort` itself needs §7's
  alpha exception, with every port in one release.
- **Ports.** `QueryOpts.sort` (`implementations/rust/core/src/db/mod.rs`)
  and `order_by_clause()` (`implementations/rust/core/src/join.rs`, mirrored
  in each port's join module) take one column and one direction. New cases
  go in `spec/fixtures/join-builder-tests.json` and the conformance suite.
- **Keyset paging.** [[33-spec-hardening-review-findings]] B2's cursor must
  carry every sort column's value.
- **Frontend.** The store's `sort`/`order` and the per-table remembered
  sort (`sortByTable`, `core/store.ts`; `docs/ui-guidelines.md` R11), the
  header click, and three places that show the sort: the dimmed `↑`/`↓`
  on every header (`styles.css`), the sort note (`#sort-note`) and the
  columns list's "sorted" tag (`features/grid.ts`). Each must show position
  as well as direction (`↑1`, `↑2`). A stored sort in the old shape is
  dropped, not migrated.
- **Open:** how the user adds a second column. A modifier click meets the
  same heuristic #4/#7 concerns as [[01-click-to-filter-compose-vs-replace]]
  approach B.
