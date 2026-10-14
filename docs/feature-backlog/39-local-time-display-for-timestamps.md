# Local-time display for timestamps

> **Status:** OPEN · **Area:** frontend, docs, e2e

## 1. The ask

Timestamps show in whatever zone the database session uses, usually UTC.
A user in Berlin reads `2026-10-14 01:33:58+00` and must add two hours in
their head. The viewer should be able to show those values in the
browser's own time zone.

The hard part is not the conversion. It is deciding how much to convert,
and how to make clear to the reader what they are looking at. This story
settles that.

## 2. What exists today

- `frontend/src/lib/format.ts:28-60` — `date`, `timestamp`, `timestamptz`,
  `datetime` and the two long spellings all map to one `"date"` class.
  The comment at `:28-30` says nothing renders them differently. This
  story ends that: only some of these values may be converted.
- `frontend/src/lib/format.ts:97-106` — `formatCellValue` is the one
  place a date cell is built. Grid (`grid.ts:173`) and record view
  (`record-view.ts:32`) both call it. It prints the raw text in a
  `<time>` element.
- `format.ts:100-101` — the `<time>` element has no `datetime` attribute,
  because the raw cast is not valid ISO. Once we parse the value, we can
  set one.
- `grid.ts:176`, `grid.ts:180` — copy and "filter by this value" use the
  **raw** string, not the displayed node. The common-values dropdown
  (`filter-ui.ts:290`) also shows raw values.
- `frontend/src/features/theme.ts:1-40` — the precedent for a device
  preference: its own `localStorage` key, kept out of `state`/`UI_KEY`
  and the URL.
- `spec/protocol.md` §5.4.3 — every cell is the engine's own text cast,
  done in SQL. This story does not change that.

## 3. What the wire carries

A rule that only converts when it is safe needs to know what each engine
sends. Postgres rows below were checked against the devcontainer
database. MySQL and SQLite rows come from engine documentation and
`docs/adapter-decisions.md`; check them against the conformance seed
before building.

| Engine / type | Sample on the wire | Has an offset? |
|---|---|---|
| Postgres `timestamptz` | `2026-10-14 03:33:58.296095+02` | Yes. The offset follows the session `TimeZone`, so the same instant can print as `+00` or `+02`. |
| Postgres `timestamptz`, old dates | `1850-01-01 05:53:28+05:53:28` | Yes, with a **seconds** part (local mean time). |
| Postgres `timestamptz`, edge values | `infinity`, `0044-03-15 12:53:28+00:53:28 BC` | `infinity` has none; `BC` is a suffix. |
| Postgres `timestamp` | `2026-10-14 03:33:58.296095` | No. |
| Postgres `date` | `2026-10-14` | No. |
| MySQL `DATETIME` | `2026-10-14 03:33:58` | No. |
| MySQL `TIMESTAMP` | `2026-10-14 03:33:58` | **No.** The server converts to its session zone, then drops the zone. |
| SQLite | any text; often `2026-10-14 03:33:58` or ISO with `Z` | Only if the stored text has one. |

Two facts follow:

1. **Only a value with an explicit offset can be converted without
   guessing.** A value with no offset is a wall-clock reading in a zone we
   do not know. Converting it would invent a zone.
2. **The wire is not fully "timezone-independent".** `spec/protocol.md`
   §5.4.3 and `docs/adapter-decisions.md:48` say the cast is timezone
   independent. For `timestamptz` it follows the session `TimeZone`. See
   open question 1.

## 4. Proposed behavior

Each point is a decision, with a recommendation.

### D1. What to convert

**Rule:** convert a value only if the text itself carries an explicit
offset (or `Z`) **and** the column type class is a timestamp. Show every
other value exactly as received.

- Postgres `timestamptz` and SQLite text with an offset convert.
- Postgres `timestamp`, `date`, MySQL `DATETIME`/`TIMESTAMP`, and
  offset-less SQLite text never convert.
- `infinity`, `-infinity`, and anything the parser does not accept stay
  raw. A failed parse is never an error; the cell shows the raw text.

A converted-or-not decision per value, not per column type, keeps this
rule engine-neutral. The type check only guards against date-shaped text
in a text column.

MySQL `TIMESTAMP` is an **accepted gap**: the offset is gone before the
frontend sees the value. Record it in `docs/adapter-decisions.md` §5.4.3.

### D2. Default view and the control

Three views: **As stored** (today), **Local**, **UTC**.

- **Recommendation: default to As stored.** This is a tool for seeing
  what the database holds. A silent change would make every existing
  user doubt the data. Local is one click away.
- One control in the top bar next to `#theme-toggle` (`index.html:46`):
  a button that cycles the three views, with the current one in its label.
- Stored as a device preference, copying `theme.ts`: its own key
  (`ashurbanipal_time_view`), not in `UI_KEY`, not in the URL. A shared
  link must show the same thing to everyone.
- Switching re-renders the visible rows from the rows already fetched.
  No new request.

### D3. Display shape

**Recommendation:** a fixed ISO-like form, not `toLocaleString`:

`2026-10-14 03:33:58.296095 +02:00`

- Fixed width, so columns do not jump when the view changes. This matters
  with the grow-only widths in `features/column-widths.ts`.
- Reads the same for every user, and sorts by eye.
- Keeps the **original fractional digits**. A JS `Date` holds only
  milliseconds, so the digits are carried over from the raw text and only
  the date, hour, and minute parts move.
- Shows the offset on each cell, so the reader never has to guess which
  zone a cell is in. In UTC view the suffix is `Z`.

Parse by hand with a regex, not `Date.parse`. The `YYYY-MM-DD HH:MM:SS+00`
form (space, short offset) is handled differently across engines.
`docs/browser-quirks.md` has no entry on this today; add one if a
difference is found. Use `Intl.DateTimeFormat(…, { timeZone })` only to
find the target offset, not to format the text.

### D4. Showing the reader what happened

- Every converted cell gets a `title` with the stored text and the UTC
  value, for example `Stored: 2026-10-14 03:33:58.296095+02 · UTC 2026-10-14 01:33:58.296095Z`.
- A cell that stays unconverted in Local or UTC view gets a `title` of
  `No time zone in the stored value; shown as stored`. Without it, a
  mixed column looks like a bug.
- The control's label names the zone, for example `Local (Europe/Berlin)`.
- With a valid parse, set `datetime` on the `<time>` element (the
  normalized UTC form). This lets assistive tech and extensions read it.
- Record view shows the same cell, plus the stored text on a second line
  when the view is not As stored.

### D5. What stays raw

- **Copy** copies the stored text. The copy button's tooltip says so.
- **Filter by this value** (`=`) uses the stored text, because the server
  compares the text cast. A localized string would match nothing.
- **Typed filters** are not translated. A user who types
  `created_at > 2026-10-14 00:00` is comparing against the stored text,
  in the session zone. The filter bar shows a one-line hint on a
  timestamp column when the view is not As stored. Translating filter
  input needs `AT TIME ZONE` in SQL, which is a protocol change.
- **Common values**, **sorting**, and JSON-column contents are unchanged.
  Dates inside JSON strings are never converted.

### D6. Out of scope

- Relative times (`3 h ago`).
- Choosing an arbitrary time zone. Browser-local and UTC cover the ask.
  `Intl.supportedValuesOf("timeZone")` makes a later picker cheap.
- Per-column or per-table overrides.
- Any change to what the server sends.

## 5. Touchpoints

- `frontend/src/lib/format.ts` — split the timestamp class from plain
  `date`; add the offset parser and formatter; `formatCellValue` takes the
  current view.
- `frontend/src/features/time-view.ts` (new) — the control, the stored
  preference, and a change event. Modeled on `theme.ts`.
- `frontend/src/features/grid.ts`, `record-view.ts` — re-render on
  change; keep raw values for copy and filter.
- `frontend/src/features/column-widths.ts` — grow-only widths must not
  stay wide after a switch to a shorter form; clear on view change.
- `frontend/src/index.html`, `styles.css` — the control.
- `docs/ui-guidelines.md` — a rule that any transformed display value
  keeps its stored value one gesture away.
- `docs/adapter-decisions.md` §5.4.3 — the MySQL `TIMESTAMP` gap.
- `frontend/src/demo/demo-fixtures.ts`, `docs/demo/` — regenerate.

No `spec/` or port change. The shared frontend artifact reaches each port
through its normal vendoring.

## 6. What "done" means

Playwright, next to `cross-engine-types.spec.ts`, using
`test.use({ timezoneId })` with at least two zones, one with a half-hour
offset (`Asia/Kolkata`). Assert on text, `title`, and `datetime`, never on
screenshots.

- `+00` and `+05:30` and `+02` values convert correctly in both zones.
- Microsecond digits survive. `…58.296095` stays `…58.296095`.
- A seconds-part offset (`+05:53:28`), `infinity`, and a `BC` value show
  as stored and do not throw.
- `timestamp`, `date`, and MySQL-style offset-less values never change.
- Copy and `=` filter send the stored text in every view.
- The preference survives reload and is absent from the URL.
- A value that fails to parse shows its raw text.
- Per `CLAUDE.md`, run the full suite at default parallelism before
  calling it done.

## 7. Open questions

1. **Protocol wording.** `spec/protocol.md` §5.4.3 calls the cast
   timezone independent. For `timestamptz` it follows the session
   `TimeZone`, so two ports with different session settings print
   different text for one row. Should the spec say so, or should ports
   pin the session zone to UTC? Not decided here.
2. **Default.** As stored is recommended. Is a new user better served by
   Local?
3. **Bare offset-less values.** Offer an opt-in "treat as UTC" for
   MySQL and Postgres `timestamp`? Recommended no: it makes a guess look
   like a fact.
4. **Offset display.** Per-cell suffix (recommended) or only in the
   column header to save width?
