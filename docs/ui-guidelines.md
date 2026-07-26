# UI/UX guidelines

Status: agreed
Scope: applies to all work on `src/frontend/dbviewer.html`, present and
future. Companion to `design.md` §3.1 (which specs *what* the frontend does)
and `acceptance-criteria.md` (which specs *whether v1 is done*) — this doc
specs the behavioral rules a change must not violate regardless of what
feature it's implementing.

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
   happening (loading, empty, error). Full weight — see the loading-state
   gap in §3.
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
should block on, the same way `acceptance-criteria.md` gates "v1 done."

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
- **R6 — No sensitive or bulky data persisted client-side.** `localStorage`
  carries UI shape only (selected table, sort, page size) — never row data,
  never filter values (filters can contain data). This is a blanket rule so
  each future feature doesn't re-litigate it case by case. *(Security
  invariant first, but also match-the-real-world: a user's mental model of
  "this tool doesn't cache my data" should stay true.)*
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
  error are all visible states — not just error. See the gap in §3: right
  now there's error-on-failure but no loading indicator, which technically
  violates this rule already. *(Derives from: visibility of system status —
  heuristic #1, given full weight above.)*
