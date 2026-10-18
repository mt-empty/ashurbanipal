// ==== Fuzzy matching for pick lists ====
// The query's characters must appear in order in the text, case-insensitively
// (`ordx` matches `order_extra`). Higher scores rank first: a match at the start,
// at the start of a word (after `_`, `-`, `.` or a space), or right after the
// previous matched character counts for more, and a shorter text wins a tie.

const BOUNDARY = /[_\-. ]/;

// Where `ch` matches from `from` on: right here if it continues the run, else
// the next word start, else the first occurrence.
function place(t: string, ch: string, from: number): number {
  if (t[from] === ch) return from;
  for (let i = from; i < t.length; i++) {
    if (t[i] === ch && (i === 0 || BOUNDARY.test(t[i - 1]))) return i;
  }
  return t.indexOf(ch, from);
}

export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q === "") return 0;
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const at = place(t, ch, from);
    if (at < 0) return null;
    if (at === 0) score += 8;
    else if (BOUNDARY.test(t[at - 1])) score += 6;
    if (at === prev + 1) score += 4;
    score += 1;
    prev = at;
    from = at + 1;
  }
  return score * 100 - t.length;
}

// Items whose `key` matches, best first; equal scores keep their input order.
export function fuzzyFilter<T>(query: string, items: readonly T[], key: (item: T) => string): T[] {
  return items
    .map((item, i) => ({ item, i, score: fuzzyScore(query.trim(), key(item)) }))
    .filter((m): m is { item: T; i: number; score: number } => m.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((m) => m.item);
}
