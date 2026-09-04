# Persisted and shareable filter state

Status: proposed 2026-09-01. Challenges an existing rule (`ui-guidelines.md`
R6, `frontend-style-guide.md` §6) rather than working around it. Not
scheduled. Supersedes the "carve out an exception to R6" branch of
`docs/feature-backlog/02-per-table-query-filter-history.md` if accepted.

## 1. The ask

A filter should survive a reload, and a URL should carry it so a teammate
opening the link lands on the same filtered view. Today `syncUrl()`
(`frontend/src/nav.ts:28-48`) deliberately omits the filter, and the
`popstate` handler (`frontend/src/nav.ts:50-64`) hard-clears it on every
history navigation.

## 2. Why the current rule blocks it

- **`ui-guidelines.md:100` (R6)** — client-side persistence carries "UI
  shape only… never filter values (filters can contain data)." Explicitly a
  blanket rule "so each future feature doesn't re-litigate it case by case."
- **`frontend-style-guide.md:164` (§6)** — same boundary, names
  `history.replaceState()` alongside `localStorage`.
- **`frontend/src/nav.ts:26`** — code comment pointing at R6 as the reason
  the filter is left out of `syncUrl()`.

## 3. The case for changing it

R6 is a data-handling policy: it decides that filter text is too sensitive
to persist. Under the project's own charter that is the host's call, not
the frontend's:

- `readme.md:45` — "Ashurbanipal ships no authentication or authorization.
  Access is a perimeter concern." The host owns who reaches the UI and what
  data is sensitive.
- `CLAUDE.md` — Ashurbanipal has no concept of environment and never will;
  it must not infer where it runs. A rule justified by "the data might be
  sensitive here" is the frontend making an environment/sensitivity
  judgement the rest of the project refuses to make.
- Intended use is day-to-day feature work in development and integration
  environments (`readme.md` §Why). Re-typing a filter every reload, and not
  being able to paste a filtered view into a ticket, tax the primary use
  case.
- The leak is already partial: `?table=customers` reveals what you browse,
  and every row on screen is in the DOM, the response body, and the browser
  cache. A filter string in the URL is a difference of degree.
- The perimeter model means everyone who can open a shared link already has
  unrestricted `SELECT` on that database. The link is not a privilege
  escalation.

## 4. What survives the challenge

Not the whole rule, but a narrower core:

- **Authorship line.** A `WHERE` clause the user typed is intent and may
  persist. A value the UI read back out of a result row — a cell value, or
  a primary key lifted from a row to build a link — is data the user never
  entered, and persisting it in a URL or `localStorage` is surprising.
  `frontend/src/state.ts:165` already guards the PK case; keep it.
- **Safe default + recovery.** A filter that no longer parses on restore
  resets silently to no filter (the existing R5 stale-state behaviour),
  never wedges or errors.
- **Host-facing disclosure.** Filter text in URLs reaches browser history,
  `Referer` headers, access logs that record query strings, and chat link
  previews (which may sit outside the host's perimeter). This is a
  documentation callout, not a reason to keep the ban.

## 5. Proposed replacement wording

### `docs/ui-guidelines.md` R6

> - **R6 — Persisted client-side state is the user's own view intent,
>   never row data.** Every persistence mechanism — `localStorage` and the
>   URL (`history.replaceState()`) alike — may carry the view the user
>   built: selected table, sort, order, page size, offset, and the filter
>   the user authored. It must never carry values read back out of result
>   rows — cell contents, or a primary key lifted from a row to build a
>   link. The test is authorship: a `WHERE` clause the user typed persists;
>   a value the UI copied out of a fetched row does not. A persisted filter
>   that no longer parses resets silently to no filter (R5). *(Derives
>   from: recognition rather than recall — a reload or a shared link should
>   restore the view the user built. The host owns who may reach the UI and
>   what data is sensitive, `readme.md` §Security; the frontend's remaining
>   duty is only that it never persists a value the user did not enter.)*
>
>   Host-facing: filter text now appears in URLs, so it reaches browser
>   history, `Referer` headers, and any access log that records query
>   strings. A host shipping those logs somewhere long-lived, or rendering
>   link previews outside its trust perimeter, should account for that.

### `docs/frontend-style-guide.md` §6

> ## 6. State and URLs
>
> - `localStorage` and the URL (`history.replaceState()`) persist the
>   user's own view intent only — table, sort, order, limit, offset, and
>   the user-authored filter. Never values read back out of result rows
>   (cell contents, PKs lifted from a row). Authorship is the line: a
>   filter the user typed persists; a value the UI copied from a fetched
>   row does not (`ui-guidelines.md` R6).
> - Stale or malformed persisted state (an unknown table, unparseable JSON,
>   a filter that no longer parses) resets silently to the default view. It
>   never wedges the UI or errors.

The R10 cross-reference at `ui-guidelines.md:127` ("the previous row set
lives in memory only and is never persisted (R6)") still holds unchanged —
a row set is row data.

## 6. Implementation touchpoints

- `frontend/src/nav.ts:28-48` `syncUrl()` — add the filter to the params.
- `frontend/src/nav.ts:50-64` `popstate` handler — currently sets
  `state.filter = ""` and `setAppliedFilterAst([])` unconditionally;
  restore both from the URL instead.
- `frontend/src/nav.ts:26` — delete or rewrite the "filter is never
  included" comment.
- `frontend/src/state.ts:62` initial load, and `applyScopeParams` /
  `buildScopeParams` (`frontend/src/state.ts:126`, `:132`) — carry the
  filter through the scope-param round trip.
- `frontend/src/main.ts:30`, `frontend/src/filter-ui.ts:224` — filter text
  already serialises to a query param here; reuse that encoding, don't
  invent a second one.
- Restore path re-runs the normal parse/apply chain; a parse failure is a
  silent reset to no filter, not an error toast.
- R10 baseline: restoring or changing the filter via URL is a scope change,
  so the new-row-tint baseline row set resets.
- `docs/design.md` documents the URL params — update it there too.
- Protocol/conformance: unaffected. Filter-in-URL is purely frontend; the
  wire contract (`spec/protocol.md` §5.4.2) does not change.

## 7. Open questions

- **DSL text or JSON AST in the param.** The submit format is the JSON AST
  (`spec/protocol.md` §5.4.2), but the `#filter` box holds DSL text and a
  human may want to read or edit the shared link. `main.ts:30` already puts
  DSL text in a param. `docs/feature-backlog/10-structured-filter-builder-ui.md`
  §4 assumes "JSON in the `filter` query param." Pick one and reconcile
  with entry 10.
- **URL only, or `localStorage` too.** URL-only means the filter is lost on
  a plain reload without the query string. Persisting to `localStorage`
  keyed per table (like sort, R11) restores a table's last filter on
  return — which may be surprising and interacts with R10's "same scope"
  refresh semantics. Decide the scope.
- **Host opt-out.** A config flag to disable filter-in-URL reintroduces
  backend surface for a behaviour in the byte-for-byte-shared frontend, and
  cuts against "no environment knobs." Leaning no — a host that can't
  tolerate filter text in URLs does not enable the tool — but name it.
- **Exact-restore fidelity.** Round-tripping DSL text through parse →
  serialize may normalise whitespace/quoting; confirm that is acceptable or
  preserve the original string.

## 8. Tests

- e2e: apply a filter, reload, filter still applied and the same rows show.
- e2e: copy the URL, open in a fresh context, same filtered rows.
- e2e: a malformed `filter` param loads the default view — no error, no
  wedge (R5/R6).
- e2e: back/forward across a filter change restores and clears the filter
  in step with the rest of the scope.
- unit: scope-param build/parse round-trips the filter; parse failure
  yields an empty filter.

## 9. Relationship to other entries

- `docs/feature-backlog/02-per-table-query-filter-history.md` — its
  "consciously carve out an exception to R6" branch becomes the default if
  this is accepted; the "session-only in-memory" branch is then moot.
- `docs/feature-backlog/10-structured-filter-builder-ui.md` — shares the
  "what encodes into the `filter` param" question (§7 above).
