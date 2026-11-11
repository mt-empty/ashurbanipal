# Copy or download the current page as CSV, TSV, or Markdown

> **Status:** OPEN · **Area:** frontend, docs, e2e

Let the user copy the rows on screen as CSV, TSV, or a Markdown table, or
download them as a `.csv` file. Frontend only, current page only.

## 1. The ask

Today the user can copy one cell, one row as JSON, one row as an `INSERT`
(story 22), or the whole response as JSON from the `payload` dialog. None
of these pastes cleanly into a spreadsheet, a ticket, or a PR description,
which is where rows usually go next. Story 28 §B logged "CSV export of the
current result page"; this story takes that item and adds the clipboard
forms.

## 2. Behaviour

- One `copy ▾` control in the grid toolbar, next to `payload`, with:
  `CSV`, `TSV`, `Markdown table`, and `download CSV`.
- Works on a table view and a join view alike.
- **Rows:** the current page as fetched, in grid order. Never a second
  fetch (R7).
- **Columns:** the visible columns, in grid order. Hidden columns are left
  out, so the output matches the screen.
- **Values:** the raw string the server sent, not the display formatting
  (`frontend/src/lib/format.ts`), so a copied value equals what the
  per-cell copy button gives today.
- **Header row:** the column names. In a join view, use the same labels the
  grid shows, so two `id` columns stay distinct.
- Feedback through the existing `copyText` helper
  (`frontend/src/core/dom.ts`), which already falls back when the
  Clipboard API is missing (R9).

### Format rules

- **CSV:** RFC 4180 — quote a field that holds `,`, `"`, CR or LF, and
  double any `"`. CRLF line ends.
- **TSV:** a tab, CR or LF inside a value would break the row, so quote
  such fields the CSV way (spreadsheets accept that on paste).
- **Markdown:** escape `|` as `\|`, turn line breaks into `<br>`.
- **Download:** a `Blob` and an `<a download>` link; no server route. File
  name `<table>-page<N>.csv`, or `join-page<N>.csv` for a join view.

## 3. Rules this must keep

- **R1:** the control only reads; it must not look like an export job or
  anything that changes data.
- **R6:** a clipboard write or a file the user asked for is not persisted
  view state, so R6 does not apply. Nothing goes into `localStorage` or
  the URL.
- **R7:** current page only. A whole-table export stays in story 28 §B
  ("Streamed full-table export"), which needs a protocol change.

## 4. Touchpoints

- A new `frontend/src/lib/` module for the three serialisers (pure, unit
  tested), and a feature module for the control.
- `frontend/src/index.html` (toolbar), `frontend/src/styles.css`,
  `frontend/src/features/grid.ts` (visible columns and order).
- `docs/feature-backlog/28-feature-expansion-triage-remainder.md` §B now
  points here.
- Check the design canvas boards before building (the grid toolbar); add
  one if none covers this control.

## 5. What "done" means

- Unit tests for each format: commas, quotes, tabs, newlines, `|`,
  `null`, empty string, and a join view's duplicate column names.
- An e2e spec: copy each format and read the clipboard the way
  `tools/e2e-tests/tests/inspection-affordances.spec.ts` does, hide a
  column and see it left out, and download the CSV and read the file.
- The full three-browser e2e suite passes.

## 6. Open questions

- **`null` versus empty string.** CSV has no `null`. Options: an empty
  field for both (simple, but loses the difference), or the literal
  `NULL` (keeps it, but a real `'NULL'` string looks the same). Markdown
  can show `NULL` in italics.
- **Spreadsheet formula injection.** A value starting with `=`, `+`, `-`
  or `@` runs as a formula when the CSV is opened in Excel. Prefixing a
  `'` protects the user but changes the data. Leave values as they are
  and note it, or prefix only in `download CSV`?
- **Copy selected rows only.** The grid has no row selection today. Add it
  later only if whole-page copy proves too coarse.

## 7. Out of scope

- Whole-table or multi-page export (story 28 §B).
- JSON export: the `payload` dialog already covers it.
- Totals over a selection (story 28 §B, separate).
