# Browser quirks

Status: living record of cross-browser inconsistencies found in
`dbviewer.html`, kept deliberately as-is (not bugs to fix) so a future
change doesn't "fix" the same thing twice or misread the gap as an
oversight.

---

## 1. No native clear ("x") button on search inputs in Firefox — kept as-is

**Found:** 2026-07-20, while adding Firefox/WebKit projects to the
Playwright E2E suite (`docs/browser-quirks.md` didn't exist yet — logged
here once cross-browser testing surfaced it).

**What happens:** `#table-filter` and `#filter` are both `<input
type="search">`. Chromium and legacy WebKit render a native clear icon
inside the field once it has a value; Firefox has never implemented this
— there's no visual clear affordance at all, in any Firefox version.

**Decision:** left as-is, not treated as a bug to patch around (e.g. via a
hand-rolled clear button). Reasoning:

- It's a real, standard native-browser affordance gap, not something this
  app's code controls — Firefox simply doesn't draw one.
- The functional workaround (select-all, retype) is available identically
  everywhere and costs nothing for this audience — engineers already
  comfortable with a browser text field, not end users who'd expect a
  discoverable clear icon (`ui-guidelines.md` §1, heuristic 10: help/
  onboarding affordances are deliberately low-weight for this tool).
- Recreating it as a custom button would mean hand-rolling a widget the
  platform already half-provides on two of three engines, which
  `ui-guidelines.md` R2 asks for a specific reason to do, not just parity.

**Related:** a second, separate Firefox-only issue was found alongside
this one — `#table-filter` missing `autocomplete="off"` let Firefox
restore its value across a plain page reload (Chromium didn't exhibit
this under Playwright's automation, but the mechanism is a documented
Firefox form-restore behavior, not an artifact of testing). That one *was*
fixed, since a search box silently showing a value that isn't backing any
active filter is a "least astonishment" violation (`ui-guidelines.md` §1),
not a cosmetic gap — unlike the missing icon above.
