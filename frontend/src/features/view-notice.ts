import { $, el } from "../core/dom.js";
import { state, tableInView, type ViewRequest, viewKey } from "../core/state.js";
import { takeSwaps } from "../core/url-intent.js";
import { buildFallbackNote, type NoteSegment } from "../lib/fallback-note.js";

// Unlike #join-notice this survives a reload of the same view, so a refresh
// keeps it; any change of source, schema, view or filter drops it.

let shownFor: string | null = null;

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

// Called once the boot load settles; ends the URL-intent window either way.
export function showBootFallbackNote(): void {
  const segments = buildFallbackNote(takeSwaps(), tableInView(), { kind: "here" });
  if (segments.length === 0) return;
  shownFor = scopeKey(state.view, state.filter);
  $("view-notice").hidden = false;
  $("view-notice-text").replaceChildren(...segments.map(render));
}

export function syncViewNotice(req: ViewRequest | null): void {
  if (shownFor !== null && shownFor !== scopeKey(req?.view ?? null, req?.filter ?? "")) clearViewNotice();
}

$("view-notice-close").onclick = clearViewNotice;
