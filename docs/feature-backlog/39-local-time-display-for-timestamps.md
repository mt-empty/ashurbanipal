# Local-time display for timestamps

> **Status:** OPEN · **Area:** frontend, docs, e2e

## 1. The ask

Timestamps show in the zone the database session uses, usually UTC. A
user in Berlin reads `2026-10-14 01:33:58+00` and must add two hours in
their head. They should be able to see the same instant in their
browser's time zone.

## 2. Decisions so far

- **"As stored" is always the default.** The viewer shows what the
  database holds. Nothing on screen changes unless the user asks.
- **First step is Tier 1: hover only.** Cells stay as stored; a timestamp
  with an offset shows its local time on hover. No control, no saved
  setting. Tier 2 and 3 are follow-ups (§8).
- **Tooltip shows local and UTC, in grid and record dialog. No visible line.**
- **JSON and JSONB values get the same tooltip** for strict RFC 3339
  date-time strings (§5.5).
- **Spec wording gets fixed, not the behavior.** See §4.

## 3. What exists today

- `frontend/src/lib/format.ts:28-60` — `date`, `timestamp`, `timestamptz`,
  `datetime` and the two long spellings all map to one `"date"` class.
  The comment at `:28-30` says nothing renders them differently. Only
  some of these values can carry a local time, so this needs a split.
- `frontend/src/lib/format.ts:97-106` — `formatCellValue` is the one place
  a date cell is built. Grid (`grid.ts:173`) and record view
  (`record-view.ts:32`) both call it. It prints the raw text in a
  `<time>` element.
- `format.ts:100-101` — the `<time>` element has no `datetime` attribute,
  because the raw cast is not valid ISO. Once a value parses, we can set
  one.
- `frontend/src/lib/json-tree.ts:29-49`, `:130-134` — JSON and JSONB cells
  do not use `formatCellValue`. `foldJson` turns each string into a
  scalar (plain or UUID) and `scalarSpan` builds its `<span>`. The text is
  the quoted JSON string, so the raw string is not kept on the node today.
- `grid.ts:176`, `grid.ts:180` — copy and "filter by this value" use the
  **raw** string. Tier 1 leaves both alone.

## 4. What the wire carries

Postgres rows were checked against the devcontainer database. MySQL and
SQLite rows come from engine documentation and
`docs/adapter-decisions.md`; check them against the conformance seed
before building.

| Engine / type | Sample on the wire | Has an offset? |
|---|---|---|
| Postgres `timestamptz` | `2026-10-14 03:33:58.296095+02` | Yes. The offset follows the session `TimeZone`, so one instant can print as `+00` or `+02`. |
| Postgres `timestamptz`, old dates | `1850-01-01 05:53:28+05:53:28` | Yes, with a **seconds** part (local mean time). |
| Postgres `timestamptz`, edge values | `infinity`, `0044-03-15 12:53:28+00:53:28 BC` | `infinity` has none; `BC` is a suffix. |
| Postgres `timestamp` | `2026-10-14 03:33:58.296095` | No. |
| Postgres `date` | `2026-10-14` | No. |
| MySQL `DATETIME` | `2026-10-14 03:33:58` | No. |
| MySQL `TIMESTAMP` | `2026-10-14 03:33:58` | **No.** The server converts to its session zone, then drops the zone. |
| SQLite | any text; often `2026-10-14 03:33:58` or ISO with `Z` | Only if the stored text has one. |

Consequences:

1. **Only a value with an explicit offset can be converted without
   guessing.** A value with no offset is a wall-clock reading in an
   unknown zone. Converting it would invent a zone.
2. **No port sets the session timezone.** Each host's database, role, or
   connection string decides it. "As stored" therefore means "in the
   host's session zone". That is acceptable: it is what the database
   reports. Conversion is safe regardless, because the offset is in the
   text.
3. **The spec overstates.** `spec/protocol.md` §5.4.3 and
   `docs/adapter-decisions.md:48` call the cast timezone-independent.
   For `timestamptz` it follows the session `TimeZone`.
   **Decided: fix the wording.** Say the cast follows the session
   timezone and that clients must read the offset in the value. No port
   pins the session to UTC. This is a wording change only; it is listed
   in §6 as a companion edit.
4. MySQL `TIMESTAMP` is an **accepted gap**: the offset is gone before
   the frontend sees the value. Record it in `docs/adapter-decisions.md`
   §5.4.3.

## 5. Tier 1 behavior

### 5.1 Which values qualify

A value qualifies only if **both** hold:

- the column type class is a timestamp, and
- the text itself carries an explicit offset (`+00`, `+05:30`,
  `+05:53:28`, `Z`).

Everything else is rendered exactly as today: Postgres `timestamp` and
`date`, MySQL `DATETIME`/`TIMESTAMP`, offset-less SQLite text,
`infinity`, `-infinity`, `BC` values, and anything the parser does not
accept. A failed parse is never an error. The cell shows the raw text and
gets no tooltip.

### 5.2 What the user sees

The cell text does not change. A qualifying cell gets a `title`:

```
Local (Europe/Berlin): 2026-10-14 03:33:58.296095 +02:00
UTC: 2026-10-14 01:33:58.296095 Z
```

- Fixed ISO-like form, not `toLocaleString`. It reads the same for every
  user and does not depend on locale.
- The original fractional digits are carried over from the raw text. A
  JS `Date` holds only milliseconds, so it is used for the date, hour and
  minute parts only.
- Cells with no offset get no tooltip. A tooltip on every MySQL date
  cell would be noise.
- The `<time>` element gets a `datetime` attribute: the UTC instant in
  ISO form (`2026-10-14T01:33:58.296095Z`). Assistive tech and
  extensions can read it.
- The record dialog builds values with the same `formatCellValue`, so it
  gets the same tooltip. **Decided: tooltip only.** A `title` does not
  show on touch or by keyboard; that is accepted for Tier 1.

### 5.3 What does not change

- Cell text, column widths (`features/column-widths.ts`), sorting.
- **Copy** and **filter by this value** keep the stored text. The server
  compares the text cast, so a localized string would match nothing.
- Typed filters keep comparing against the stored text, in the session
  zone. A user who types `created_at > 2026-10-14 00:00` gets the host's
  session-zone meaning, not their browser's.
- Common values. JSON text, copy, and the JSON/SQL copy buttons keep the
  stored string.

### 5.4 Parsing

Parse by hand with a regex, not `Date.parse`. The
`YYYY-MM-DD HH:MM:SS+00` form (space, short offset) is handled
differently across engines. `docs/browser-quirks.md` has no entry on this
today; add one if a difference is found. Use
`Intl.DateTimeFormat(…, { timeZone })` only to find the local offset,
not to format the text. Apply the stored offset, including a seconds
part, to get the UTC instant.

### 5.5 JSON and JSONB strings

JSON has no timestamp type, so there is no column type to trust. The only
signal is the shape of the string. A string in a JSON cell qualifies only
if it matches strict RFC 3339 date-time:

`YYYY-MM-DDTHH:MM:SS[.fraction](Z | ±HH:MM)`

- `T` separator (a lowercase `t` is rejected), seconds required, a
  fraction of any length, and an explicit `Z` or `±HH:MM` offset.
- Rejected, shown as today: offset-less strings, date-only strings,
  space-separated strings, compact and week forms. Epoch numbers are JSON
  numbers and are never touched.
- A qualifying string gets the same two-line `title` as §5.2. The text
  stays the quoted string. It is colored as a plain string; no new color.
- This covers `toISOString()`, Python `isoformat()`, Go
  `RFC3339Nano`, Java `Instant`, and Postgres `to_jsonb(timestamptz)`.
- The JSON strictness is deliberate: the column parser (§5.4) also
  accepts the space and short-offset forms, but in free-form JSON a
  looser match would tag IDs and labels.
- Dates in object **keys** are not converted.

## 6. Touchpoints

- `frontend/src/lib/format.ts` — split the timestamp class from plain
  `date`; add the offset parser and the local/UTC formatter;
  `formatCellValue` sets `title` and `datetime`. The parser and
  formatter live here, plus a separate strict RFC 3339 test for JSON.
- `frontend/src/lib/json-tree.ts` — keep the raw string on the scalar
  node; `scalarSpan` sets `title` when it qualifies. `format.ts` is a
  leaf with type-only imports (`format.ts:3-4`), so `json-tree.ts`
  imports the shared parser from a small new leaf module, not from
  `format.ts`.
- `frontend/src/demo/seeds/`, `docs/demo/` — regenerate.
- `spec/protocol.md` §5.4.3, `docs/adapter-decisions.md:48` — the wording
  fix above, and the MySQL `TIMESTAMP` gap. Companion edit, no behavior
  change; confirm it is acceptable under spec governance.

No port change. The shared frontend artifact reaches each port through
its normal vendoring.

## 7. What "done" means

Playwright, next to `cross-engine-types.spec.ts`, using
`test.use({ timezoneId })` with at least two zones, one with a half-hour
offset (`Asia/Kolkata`). Assert on text, `title`, and `datetime`, never
on screenshots.

- `+00`, `+05:30`, and `+02` values give the right local and UTC lines in
  both zones.
- Microsecond digits survive: `…58.296095` stays `…58.296095`.
- A seconds-part offset (`+05:53:28`) converts. `infinity` and a `BC`
  value show as stored, with no tooltip and no thrown error.
- `timestamp`, `date`, and offset-less values have the same text and no
  tooltip.
- Cell text, copy, and "filter by this value" are identical to today.
- A JSON cell with `"2026-10-14T01:33:58.123Z"` and `"…+02:00"` strings
  gets the tooltip on those strings only. Offset-less, date-only,
  space-separated, and non-string values, and object keys, get none.
  Copy JSON returns the stored text unchanged.
- The record dialog shows the same tooltip for a qualifying value and
  none otherwise.
- Per `CLAUDE.md`, run the full suite at default parallelism before
  calling it done.

## 8. Follow-ups, not part of this story

Build these only if users ask to scan whole columns in local time.

**Tier 2 — view switch.** One top-bar button, next to `#theme-toggle`
(`index.html:46`), cycles As stored, Local, and UTC. Saved per device the
way `features/theme.ts` does it: its own `localStorage` key, kept out of
`UI_KEY` and the URL. Qualifying cells render in the chosen view as
`2026-10-14 03:33:58.296095 +02:00`. Cells without an offset stay as
stored and get a hover note, `No time zone in the stored value`. The
switch re-renders fetched rows with no new request, and grow-only widths
in `column-widths.ts` must reset on change. Copy and filter keep the
stored text; a timestamp column shows a one-line hint that typed filters
use the stored text.

**Tier 3 — per column.** A clock toggle on each timestamp column header.
Needs per-table state, so it follows Tier 2.

**Out of scope for all tiers:** looser date shapes inside JSON, translating typed filters (needs
`AT TIME ZONE` in SQL, a protocol change), an arbitrary timezone picker
(`Intl.supportedValuesOf("timeZone")` makes it cheap later), relative
times, and treating offset-less values as UTC.
