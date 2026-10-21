import { $, el } from "../core/dom.js";
import { state, tableInView, type ViewRequest, viewKey } from "../core/state.js";
import type { Swap } from "../core/types.js";
import { takeSwaps } from "../core/url-intent.js";
import { buildFallbackNote, type NotePlace, type NoteSegment } from "../lib/fallback-note.js";

// Unlike #join-notice this survives a reload of the same view, so a refresh
// keeps it; any change of source, schema, view or filter drops it.

let shownFor: string | null = null;
let shownSwaps: Swap[] = [];
let place: NotePlace = { kind: "here" };

function scopeKey(view: ViewRequest["view"] | null, filter: string): string {
  return JSON.stringify([state.source, state.schema, viewKey(view), filter]);
}

function render(segment: NoteSegment): Node {
  if ("code" in segment) return el("code", undefined, segment.code);
  if ("label" in segment) return el("span", "tag", segment.label);
  return document.createTextNode(segment.text);
}

function clearViewNotice(): void {
  shownFor = null;
  $("view-notice").hidden = true;
}

function renderNote(): void {
  $("view-notice-text").replaceChildren(...buildFallbackNote(shownSwaps, tableInView(), place).map(render));
}

// Called once the boot load settles; ends the URL-intent window either way.
export function showBootFallbackNote(): void {
  shownSwaps = takeSwaps();
  if (shownSwaps.length === 0) return;
  shownFor = scopeKey(state.view, state.filter);
  $("view-notice").hidden = false;
  renderNote();
}

// The instance's own label, once /api/siblings reports one, replaces "here".
export function setNoticePlace(label: string | null): void {
  const next: NotePlace = label === null ? { kind: "here" } : { kind: "label", label };
  if (JSON.stringify(next) === JSON.stringify(place)) return;
  place = next;
  if (shownFor !== null) renderNote();
}

export function syncViewNotice(req: ViewRequest | null): void {
  if (shownFor !== null && shownFor !== scopeKey(req?.view ?? null, req?.filter ?? "")) clearViewNotice();
}

$("view-notice-close").onclick = clearViewNotice;
