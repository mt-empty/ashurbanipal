import type { Swap, SwapKind, UrlIntent } from "../core/types.js";

// The fallback note's one sentence, as segments so the caller renders names
// as <code> without building HTML from strings.
export type NoteSegment = { text: string } | { code: string } | { label: string };

const ORDER: readonly SwapKind[] = ["source", "schema", "table", "filter"];

// What the settled page differs from the URL on. A null source or schema means
// that selector is hidden (one source, one schema), which is not a swap; a null
// table is (the scope has no tables). A dropped filter settles as null.
export function swapsFrom(asked: UrlIntent, settled: Record<SwapKind, string | null>): Swap[] {
  return ORDER.flatMap((kind): Swap[] => {
    const want = asked[kind];
    const got = settled[kind];
    if (want === undefined || want === got) return [];
    if ((kind === "source" || kind === "schema") && got === null) return [];
    return [{ kind, asked: want, got }];
  });
}

// `label` is the instance's own label; without one the note says "here".
function placeSegments(label: string | null): NoteSegment[] {
  return label === null ? [{ text: "here" }] : [{ text: "in " }, { label }];
}

// Joins runs of segments: "a, b or c" with lastSep " or ", "a / b" with " / ".
function joinWith(items: NoteSegment[][], sep: string, lastSep = sep): NoteSegment[] {
  return items.flatMap((item, i) => (i === 0 ? item : [{ text: i === items.length - 1 ? lastSep : sep }, ...item]));
}

// `table` is the table now in view, named when only the filter was dropped.
export function buildFallbackNote(swaps: readonly Swap[], table: string | null, label: string | null): NoteSegment[] {
  const named = ORDER.flatMap((kind) => (kind === "filter" ? [] : swaps.filter((s) => s.kind === kind)));
  const filterDropped = named.length < swaps.length;
  if (named.length === 0) {
    if (!filterDropped) return [];
    const target: NoteSegment[] = table ? [{ code: table }, { text: " " }] : [];
    return [{ text: "Your filter doesn't fit " }, ...target, ...placeSegments(label), { text: ", so it was removed." }];
  }
  const out: NoteSegment[] = [
    { text: "There is no " },
    ...joinWith(
      named.map((s) => [{ text: `${s.kind} ` }, { code: s.asked }]),
      ", ",
      " or ",
    ),
    { text: " " },
    ...placeSegments(label),
  ];
  const shown = named.flatMap((s) => (s.got === null ? [] : [[{ code: s.got }]]));
  if (shown.length === 0) {
    out.push({ text: filterDropped ? ". Your filter was removed." : "." });
    return out;
  }
  out.push({ text: ". Showing " }, ...joinWith(shown, " / "), {
    text: filterDropped ? " instead, without your filter." : " instead.",
  });
  return out;
}
