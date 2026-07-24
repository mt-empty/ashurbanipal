# Structured filter builder UI (Airtable/Notion/Linear-style)

Status: discussed during the client-side-AST filter decision (2026-07-22);
not designed, not scheduled. Captured as the natural follow-on to that
decision so the option doesn't need to be reconstructed from scratch later.

## 1. The ask

`roadmap.md` §6's open question on client-side filter parsing was resolved
in discussion on 2026-07-22: the frontend will submit a JSON AST (a list of
`{logic?, not?, column, op, value?}` triples — the same shape `filter.rs`
already parses text *into*, per `spec/filter-dsl.md` §3) instead of a raw DSL
string, with no server-side text-parser fallback in the spec. The `#filter`
free-text input still exists to *produce* that AST client-side, but nothing
structural requires it to. This entry captures the option one step further
down that same road: replace (or offer alongside) the free-text input with
a row-based builder — column/operator/value dropdowns that compose the AST
directly, the way Airtable, Notion, and Linear build filters. No parsing
anywhere, client or server, because the UI state already *is* the AST.

## 2. Shape

```
Filters
┌────────────────────────────────────────────────────┐
│ [status      ▾] [=       ▾] [completed          ] ✕│
│  AND▾ [created_at ▾] [>     ▾] [2016-01-01       ] ✕│
│  OR ▾ [is_active  ▾] [=     ▾] [true             ] ✕│
│                                          + Add filter│
└────────────────────────────────────────────────────┘
                                            [Apply]
```

- Column dropdown ← the schema list the frontend already holds (needed
  today for sort/render/autocomplete — no new plumbing).
- Operator dropdown ← the fixed 8-item set (`spec/filter-dsl.md` §2) plus
  `IS NULL`/`IS NOT NULL`, which hide the value field when selected.
- `NOT` toggle per row.
- Leading `AND`/`OR` selector on every row after the first. A flat row list
  has no structural mismatch with the grammar's own "no parens, no nesting"
  restriction (`spec/filter-dsl.md` §1) — the UI can't express anything the
  grammar couldn't already represent.

## 3. What's gained over free-text (parsed client- or server-side)

- No grammar anywhere. `filter.rs`'s ~8-operator recursive-descent parser
  (and any JS port of it, had the AST-via-client-parsing route been taken
  instead) becomes unnecessary for the primary UI flow — it only survives
  as an optional convenience for `curl`/API users typing a filter by hand.
- Zero escaping/quoting edge cases (`spec/filter-dsl.md` §2's `''`-doubling,
  forced-quoting of literal `AND`/`OR`/`NOT` values) — a value typed into a
  builder's input box is never at risk of being misread as a keyword,
  because there's no tokenizing step to misread it.
- Discoverability: every valid operator is listed, not something the user
  has to already know to type.

## 4. What's lost

- **Typing speed for power users.** `status=completed AND
  created_at>2016-01-01` is one line; the same filter in a builder is 3
  dropdown selections + 2 value fields + 2 clicks. For a tool aimed at
  engineers doing repeated ad hoc queries, this is the real cost.
- **Compact, human-readable copy/paste.** A DSL string pastes cleanly into
  a bug report, Slack message, or `curl` command. A builder's output is
  still shareable via URL (JSON in the `filter` query param), but no longer
  something a human reads or types directly.
- **Real frontend rework, not an addition.** This replaces `#filter`, the
  column-autocomplete popup (`#filter-suggest`, `#filter-caret-anchor`),
  and the caret-anchoring code in `dbviewer.html` outright — more deleted
  and rewritten code than the AST-with-client-side-parser route would have
  needed, which could've left the existing text UI untouched.
- **`filter.rs`'s role shrinks further.** Already optional once AST-on-submit
  ships; under this option it additionally stops being exercised by the
  primary UI at all, only by hand-typed `curl` filters — worth remembering
  before trimming or "simplifying" it later, since its only remaining
  caller would be outside the frontend entirely.

## 5. Prior art

- **Kibana/Elasticsearch** — closest match for the *AST-on-submit* half:
  Kibana parses free-text KQL entirely client-side into Elasticsearch's
  structured Query DSL JSON; Elasticsearch itself never sees free text.
- **PostgREST / `postgrest-js`** — closest match for the *builder* half:
  clients compose filter query params directly via a fluent builder
  (`.gte('age', 18)`), never round-tripping through typed text. This is
  already the pattern `dbviewer.html`'s click-to-filter/common-values code
  uses today (`spec/filter-dsl.md` §6: composition, not parsing).
- **Airtable / Notion / Linear** — the direct UI precedent: no free-text
  grammar exists at all, just field/operator/value rows that are the
  filter state.

## 6. Mitigation considered: hybrid mode

Ship the builder as the default, keep a "raw expression" toggle that
free-types the same DSL string and converts it to the identical AST
client-side on switch (using whatever grammar implementation exists at
that point — reference-only, per §4). Gets back power-user speed without
giving up the discoverable/mistake-resistant default, at the cost of
maintaining two UI paths that must agree on every case in
`spec/filter-dsl.md` §5's test table. Not evaluated further than being named as
an option.

## 7. Open questions

- Default vs. toggle vs. full replacement of the free-text input — not
  discussed beyond naming the hybrid as a possibility.
- Does click-to-filter / common-values dropdown / FK-cell navigation change
  at all? They already compose structured clauses today, not text
  (`spec/filter-dsl.md` §6), so plausibly no change is needed — but this
  overlaps `docs/feature-backlog/01-click-to-filter-compose-vs-replace.md`'s
  open questions (multi-condition-per-column OR-grouping display) and
  should be reconciled with that doc if both are ever picked up.
- If the free-text input is fully removed, does `filter.rs` move out of the
  main crate entirely (e.g. into a `curl`-convenience example/tool) rather
  than staying as unreachable-from-the-UI production code?
- Multi-row layout at the grammar's 10-condition cap (`spec/filter-dsl.md` §3) —
  does the builder need scrolling/collapsing before then, or is 10 rows
  fine to just render flat?
