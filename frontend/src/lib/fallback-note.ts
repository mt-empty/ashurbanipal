import type { Swap } from "../core/types.js";

// The fallback note's one sentence, as segments so the caller renders names
// as <code> without building HTML from strings.
export type NoteSegment = { text: string } | { code: string } | { label: string };

// Where the user landed: "here", or the instance's own label once one is known.
export type NotePlace = { kind: "here" } | { kind: "label"; label: string };

const NAME_ORDER = ["source", "schema", "table"] as const;

function placeSegments(place: NotePlace): NoteSegment[] {
  return place.kind === "here" ? [{ text: "here" }] : [{ text: "in " }, { label: place.label }];
}

// "a", "a or b", "a, b or c" — each item is its own run of segments.
function joinOr(items: NoteSegment[][]): NoteSegment[] {
  return items.flatMap((item, i) => {
    if (i === 0) return item;
    return [{ text: i === items.length - 1 ? " or " : ", " }, ...item];
  });
}

function joinSlash(items: NoteSegment[][]): NoteSegment[] {
  return items.flatMap((item, i) => (i === 0 ? item : [{ text: " / " }, ...item]));
}

// `table` is the table now in view, named when only the filter was dropped.
export function buildFallbackNote(swaps: readonly Swap[], table: string | null, place: NotePlace): NoteSegment[] {
  const named = NAME_ORDER.flatMap((kind) => swaps.filter((s) => s.kind === kind));
  const filterDropped = swaps.some((s) => s.kind === "filter");
  if (named.length === 0) {
    if (!filterDropped) return [];
    const target: NoteSegment[] = table ? [{ code: table }, { text: " " }] : [];
    return [{ text: "Your filter doesn't fit " }, ...target, ...placeSegments(place), { text: ", so it was removed." }];
  }
  const out: NoteSegment[] = [
    { text: "There is no " },
    ...joinOr(named.map((s) => [{ text: `${s.kind} ` }, { code: s.asked }])),
    { text: " " },
    ...placeSegments(place),
  ];
  const got = named.filter((s) => s.got !== null);
  if (got.length === 0) {
    out.push({ text: filterDropped ? ". Your filter was removed." : "." });
    return out;
  }
  out.push({ text: ". Showing " }, ...joinSlash(got.map((s) => [{ code: s.got as string }])), {
    text: filterDropped ? " instead, without your filter." : " instead.",
  });
  return out;
}
