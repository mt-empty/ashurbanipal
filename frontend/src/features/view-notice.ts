import { $, el } from "../core/dom.js";
import { scopeIdentity, startTable, state, tableInView, type ViewRequest, viewKey } from "../core/state.js";
import type { Swap } from "../core/types.js";
import { takeUrlIntent } from "../core/url-intent.js";
import { buildFallbackNote, type NoteSegment, swapsFrom } from "../lib/fallback-note.js";

// Unlike #join-notice this survives a reload of the same view, so a refresh
// keeps it; any change of source, schema, view or filter drops it.

let shownFor: string | null = null;
let shownSwaps: Swap[] = [];
let placeLabel: string | null = null;
let customText: string | null = null;

function noticeKey(view: ViewRequest["view"] | null, filter: string): string {
  return JSON.stringify([scopeIdentity(), viewKey(view), filter]);
}

function render(segment: NoteSegment): Node {
  if ("code" in segment) return el("code", undefined, segment.code);
  if ("label" in segment) return el("span", "tag", segment.label);
  return document.createTextNode(segment.text);
}

function clearViewNotice(): void {
  shownFor = null;
  customText = null;
  $("view-notice").hidden = true;
}

function renderNote(): void {
  $("view-notice-text").replaceChildren(
    ...(customText === null
      ? buildFallbackNote(shownSwaps, tableInView(), placeLabel).map(render)
      : [document.createTextNode(customText)]),
  );
}

// A plain note for the view on screen; like the fallback note it drops on any view change.
export function showViewNotice(text: string): void {
  customText = text;
  shownFor = noticeKey(state.view, state.filter);
  $("view-notice").hidden = false;
  renderNote();
}

// Called once the boot load settles: whatever the URL asked for that the page
// did not end up on gets the note. Ends the URL-intent window either way.
export function showBootFallbackNote(): void {
  shownSwaps = swapsFrom(takeUrlIntent(), {
    // Where there was nothing to choose, the selector is hidden and no name is a swap.
    source: state.manySources ? state.scope.source : null,
    schema: state.manySchemas ? state.scope.schema : null,
    table: startTable(state.view),
    filter: state.filter || null,
  });
  if (shownSwaps.length === 0) return;
  shownFor = noticeKey(state.view, state.filter);
  $("view-notice").hidden = false;
  renderNote();
}

// The instance's own label, once /api/siblings reports one, replaces "here".
export function setNoticePlace(label: string | null): void {
  if (label === placeLabel) return;
  placeLabel = label;
  if (shownFor !== null) renderNote();
}

export function syncViewNotice(req: ViewRequest | null): void {
  if (shownFor !== null && shownFor !== noticeKey(req?.view ?? null, req?.filter ?? "")) clearViewNotice();
}

$("view-notice-close").onclick = clearViewNotice;
