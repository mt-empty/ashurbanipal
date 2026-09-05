# UI/UX guidelines

Status: agreed
Scope: applies to all work on `frontend/dbviewer.html` (built from
`frontend/src/`), present and future. Companion to `design.md` §3.1 (which
specs *what* the frontend does) — this doc specs the behavioral rules a
change must not violate regardless of what feature it's implementing.

Written proactively, not in response to an incident — the goal is to give
future changes (mine or a human's) a fast way to check "does this feel
wrong" against something more concrete than taste.

## 1. Foundational principles (the "why")

Two layers underneath every rule in §2.

**Principle of least astonishment.** A UI element should behave the way its
appearance promises, every time. If something looks like a link, it
navigates; if it looks like a button, it doesn't also submit a hidden form.
Surprise is the failure mode this project can least afford, precisely
*because* it's embedded inside someone else's product — a user who
half-notices Ashurbanipal's chrome should never be caught off guard by what
it just did.

**Nielsen's 10 usability heuristics** — general-purpose, not written for
this project, so each gets a one-line read on how much weight it actually
carries here. This is a read-only internal dev tool with one user type
(engineers who already know what a database table is), which mutes a few of
these on purpose rather than by neglect:

1. **Visibility of system status** — the user always knows what's
   happening (loading, empty, error). Full weight — see R9.
2. **Match between system and the real world** — use the vocabulary the
   audience already has (table/column/row, actual Postgres type names).
   Full weight; no need to paper over DB jargon for this audience.
3. **User control and freedom** — every modal/popup has an obvious,
   consistent way out (Esc, backdrop click, light-dismiss). Full weight.
4. **Consistency and standards** — prefer platform conventions over
   inventing new ones. This is *why* native `<dialog>`/Popover/Clipboard
   were chosen over bespoke widgets — see R2.
5. **Error prevention** — stop bad input before it does anything, not after.
   Split ownership: DSL grammar errors are now caught client-side at parse
   time, before any request goes out (`frontend-style-guide.md` §3);
   schema allow-listing (does this column exist on this table) stays
   backend-only, since it needs live schema knowledge the frontend doesn't
   have. For that half, the frontend's job is still to not contradict it —
   never offer an action the backend would reject.
6. **Recognition rather than recall** — surface state instead of making the
   user remember it (row counts always visible, active sort shown via
   ▲/▼, remembered table/sort via `localStorage`). Full weight.
7. **Flexibility and efficiency of use** — power-user accelerators
   (keyboard shortcuts, bulk actions). Deliberately low weight for v1 — this
   is a browse-and-inspect tool, not a daily-driver editor. Revisit only if
   real usage shows friction.
8. **Aesthetic and minimalist design** — show what's needed, nothing more.
   Full weight; matches the no-framework, no-build-step ethos already in
   `CLAUDE.md`.
9. **Help users recognize, diagnose, and recover from errors** — error text
   is the backend's actual rejection reason (`e.message` surfaces the
   response body verbatim), not a generic "Something went wrong." Full
   weight.
10. **Help and documentation** — explicitly **low weight, by design**. No
    onboarding tour, no inline help text, no tooltips-as-documentation. The
    audience is engineers who can read `design.md`; a dev tool that needs a
    tutorial has a UI problem, not a docs problem. Don't build one to paper
    over confusing UI — fix the UI instead.

## 2. Concrete rules

Checkable, not aspirational — each ties back to §1 and (where relevant)
notes current implementation status. Treat these as things a PR review
should block on.

- **R1 — Read-only is load-bearing in the UI, not just the API.** No
  element may *look* mutable: no edit-in-place, no optimistic updates, no
  "Save" button, no affordance implying a write the backend would reject.
  *(Derives from: least astonishment, error prevention.)*
- **R2 — Native elements before libraries, every time.** Reach for what the
  platform already gives you (`<dialog>`, Popover API, Clipboard API,
  `<details>`, form validation) before adding a dependency or hand-rolling a
  widget. A new UI feature that reinvents something the browser already
  does needs a specific reason, not just habit. *(Derives from: consistency
  and standards, aesthetic and minimalist design.)*
- **R3 — CDN is enhancement, never dependency.** The page must fully
  function — browsing, sorting, filtering, pagination — with every CDN
  script blocked. Degrade (raw JSON instead of a tree view), never break.
  *(Derives from: error prevention, visibility of system status — a broken
  page with no explanation is the worst version of this failure.)*
- **R4 — No blocking browser chrome.** Never `alert()`, `confirm()`, or
  `prompt()` — they freeze the tab, look broken inside a host page, and
  bypass every styling/dismissal convention the rest of the UI uses.
  `<dialog>` is the sanctioned replacement for anything that needs to
  interrupt. *(Derives from: least astonishment, consistency and
  standards.)*
- **R5 — Stale or malformed local state must never wedge the UI.** Already
  the rule for `localStorage` (unknown table → default view, bad JSON →
  discard and rewrite); it generalizes to any future persisted client
  state. A corrupted local value is a reset, never a dead end.
  *(Derives from: error prevention, recovery.)*
- **R6 — Persisted client-side state is the user's own view intent, never
  row data.** Every persistence mechanism — `localStorage` and the URL
  (`history.replaceState()`) alike — may carry the view the user built:
  selected table, sort, order, page size, offset, and the filter the user
  authored. It must never carry values read back out of result rows — cell
  contents, or a primary key lifted from a row to build a link. The test is
  authorship: a `WHERE` clause the user typed persists; a value the UI
  copied out of a fetched row does not. A restored filter that the current
  database can't satisfy — it no longer parses, names a column the table
  lacks, or was written against a table that isn't here — resets silently
  to no filter (R5), never an error or a dead-end link. The applied filter
  is the one field that goes to the URL but never `localStorage`: a URL is
  already the shareable-link surface a teammate might reuse, while keeping
  filter text out of `localStorage` means returning to a table later never
  silently reapplies a filter the current visit didn't type. *(Derives from:
  recognition rather than recall — a reload or a shared link should restore
  the view the user built. The host owns who may reach the UI and what data
  is sensitive, `readme.md` §Security; the frontend's remaining duty is
  only that it never persists a value the user did not enter.)*

  Host-facing: filter text now appears in URLs, so it reaches browser
  history, `Referer` headers, and any access log that records query
  strings. A host shipping those logs somewhere long-lived, or rendering
  link previews outside its trust perimeter, should account for that.
- **R7 — Bounded rendering.** The UI renders what the server paginates it —
  it must not independently fetch-all or attempt to render an unbounded
  result set regardless of what an API technically allows. *(Derives from:
  aesthetic and minimalist design, and plain performance.)*
- **R8 — Truncation always has an escape hatch.** Anything visually capped
  (cell width, long text) must have a discoverable way to see the full
  value — today that's the click-to-expand popover. A future truncation
  point that doesn't wire this up is a bug, not a style choice. *(Derives
  from: visibility of system status, user control and freedom.)*
- **R9 — Every async action reports its own status.** Loading, success, and
  error are all visible states — not just error (a `#status` live region,
  a per-row spinner in the sidebar, and `aria-busy` on the table cover
  loading; `#error` covers failure). *(Derives from: visibility of system
  status — heuristic #1, given full weight above.)*
- **R10 — The `refresh` button and its new-row tint are the sanctioned
  "what changed" affordance.** A user-clicked re-fetch of the current view;
  rows absent from the previous same-scope response briefly wash
  (`--row-new-bg`, faded/static per `prefers-reduced-motion`). Constraints:
  it is manual only (no polling timer — that fights R9 and heuristic #7);
  row identity is the primary key, so a PK-less table gets no tint rather
  than a guessed one; the previous row set lives in memory only and is
  never persisted (R6); and the fetch itself reports through the normal
  `fetchTableData` chrome, with the new-row count also announced via
  `#status` (R9, no carve-out). *(Derives from: recognition rather than
  recall, visibility of system status.)*
- **R11 — Sort is remembered per table.** `sort` + `order` persist keyed by
  table name (like hidden columns), so returning to a table restores the
  sort last chosen there — which is what lets R10's refresh surface new
  rows without re-sorting every visit. A restored sort column the backend
  rejects (400 — the schema changed, or storage carried over from another
  database) is dropped and the view retried unsorted (R5). A URL-restored
  filter is stale-risk the same way, so the two are dropped one at a time,
  sort first: it's the visitor's own incidental state, while the filter is
  what the shared link was for, so the link's filtered view still gets its
  chance to render. A filter the user typed on this visit is *not*
  stale-risk — its 400 is theirs to see, and it suppresses the sort retry
  rather than being silently discarded.
  Sort is never carried across tables — a column name is table-specific.
  *(Derives from: recognition rather than recall.)*
- **R12 — Schema is remembered per source.** The selected schema persists
  keyed by source name (like R11's sort keyed by table), so switching
  source and back restores the schema last used there instead of resetting
  to `public`. A remembered schema that no longer exists on that source
  degrades silently to the default via the same validation `loadSchemas()`
  already does (R5); a single-schema source never records an entry. Not
  mirrored to the URL — a shared link's explicit `?schema=` still wins on
  load; the per-source memory only fills in on an in-app source switch.
  *(Derives from: recognition rather than recall.)*
