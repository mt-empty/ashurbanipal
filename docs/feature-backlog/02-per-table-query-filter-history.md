# Per-table query/filter history

**Ask:** remember previous filters/queries per table.

**Impact / constraints:**
- Collides directly with an existing, deliberate rule: `ui-guidelines.md` R6
  and `frontend-style-guide.md` §6 both bar persisting filter values in
  `localStorage` or the URL, specifically *because* filters can carry data
  values (unlike table/sort/limit, which are just UI shape). "Filter/query
  history" is exactly the case that rule was written to block.
- Two ways to reconcile, not yet decided between:
  - **Session-only, in-memory** (a JS array, cleared on reload) — stays
    fully compliant with R6 since nothing touches persistent storage, but
    "history" disappears on every page refresh, which may or may not satisfy
    the actual ask.
  - **Consciously carve out an exception to R6** for this one feature (e.g.
    persist filter history but flag it clearly as a data-carrying exception,
    maybe with an explicit clear/opt-out) — bigger conversation, since R6 is
    phrased as a blanket rule "so each future feature doesn't re-litigate it
    case by case."
- Either way, this is a scope/policy decision before it's an implementation
  one.
