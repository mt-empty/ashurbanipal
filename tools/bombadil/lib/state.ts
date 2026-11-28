import { extract } from "@antithesishq/bombadil/browser";

// What the properties and actions read off the page, each from the element that owns it in
// frontend/src/index.html. Extractors run inside the page on every captured state.

// The #error banner's text, or null when empty. Only core/dom.ts reportError writes it.
export const errorText = extract((s) => s.document.getElementById("error")?.textContent || null);

// bootstrap/controller.ts holds #data-table aria-busy while any view fetch is in flight and across
// the view transition that draws its rows. (The load bar shows only fetches slower than 250 ms.)
export const busy = extract((s) => s.document.getElementById("data-table")?.getAttribute("aria-busy") === "true");

// Data rows in the grid.
export const rowCount = extract((s) => s.document.querySelectorAll("#tbody > tr").length);

// The page size the view asked for: the URL's limit (core/url.ts), 50 when absent.
export const pageSize = extract((s) => Number(new URL(s.window.location.href).searchParams.get("limit") ?? 50));

export const url = extract((s) => s.window.location.href);

// The view in the URL is the one on screen: the table not busy (the controller sets #current
// before the transition that redraws the grid, inside the busy window), and for a table view
// #current naming that table.
export const settled = extract((s) => {
  const doc = s.document;
  const table = new URL(s.window.location.href).searchParams.get("table");
  if (doc.getElementById("data-table")?.getAttribute("aria-busy") === "true") return false;
  return table === null || doc.getElementById("current")?.textContent === table;
});

// A join view (core/url.ts carries its text in `join`); its filters need qualified columns.
export const inJoin = extract((s) => new URL(s.window.location.href).searchParams.has("join"));

// The grid's column names, from the header cells features/grid.ts tags with data-col.
export const columnNames = extract((s) =>
  [...s.document.querySelectorAll<HTMLElement>("#thead th[data-col]")].map((th) => th.dataset.col ?? ""),
);

// What the reader sees of the view, built from the rendered page rather than the URL, so a
// reload that restores the wrong state shows up: the table, the sort note, the pager, and
// the first row.
export const viewKey = extract((s) => {
  const text = (id: string) => s.document.getElementById(id)?.textContent?.trim() ?? "";
  const sortNote = s.document.getElementById("sort-note");
  // Cell values only: the row's buttons change glyph for a moment after a click (core/dom.ts flashIcon).
  const firstRow = [...s.document.querySelectorAll("#tbody > tr:first-child td[data-col] .cell-text")]
    .map((c) => c.textContent ?? "")
    .join("\u241f")
    .slice(0, 200);
  return JSON.stringify([
    text("current"),
    sortNote?.hidden ? "" : text("sort-note-col") + text("sort-note-dir"),
    text("page"),
    firstRow,
  ]);
});

// Console errors, as text. console.warn is left out: the frontend breadcrumbs rare failures with it on purpose.
export const consoleErrors = extract((s) =>
  s.console
    .filter((e) => e.level === "error")
    .map((e) => e.args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")),
);

// Uncaught exceptions and unhandled rejections. A rejection's reason is only in its remote object.
export const uncaught = extract((s) =>
  s.errors.uncaughtExceptions.map((e) => [e.text, e.remote_object?.description].filter(Boolean).join(" ")),
);
