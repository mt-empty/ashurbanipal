// Builds a row's copy-as-JSON text without a JSON.parse round-trip, which
// would round integers past 2^53. A leaf with no imports so `node --test`
// can load it directly.

export interface JsonField {
  name: string;
  raw: string | null;
  // The value is the engine's own valid JSON text, spliced in unchanged.
  json: boolean;
}

export function recordJson(fields: JsonField[]): string {
  if (fields.length === 0) return "{}";
  const lines = fields.map(({ name, raw, json }) => {
    const value = raw == null ? "null" : json ? reindentJson(raw, 1) : JSON.stringify(raw);
    return `  ${JSON.stringify(name)}: ${value}`;
  });
  return `{\n${lines.join(",\n")}\n}`;
}

// Re-lays out JSON text the way JSON.stringify(v, null, 2) would, but copies
// every string and number token verbatim. `depth` is the nesting level the
// value starts at. Callers validate first; malformed input gives garbled
// output but never throws.
// JSON's four whitespace characters; JS `\s` matches more.
const isJsonSpace = (ch: string | undefined) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

export function reindentJson(text: string, depth = 0): string {
  let out = "";
  let level = depth;
  const newline = () => `\n${"  ".repeat(Math.max(level, 0))}`;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "{" || ch === "[") {
      const close = ch === "{" ? "}" : "]";
      let j = i + 1;
      while (isJsonSpace(text[j])) j++;
      if (text[j] === close) {
        out += ch + close;
        i = j;
      } else {
        level++;
        out += ch + newline();
      }
    } else if (ch === "}" || ch === "]") {
      level--;
      out += newline() + ch;
    } else if (ch === ",") {
      out += `,${newline()}`;
    } else if (ch === ":") {
      out += ": ";
    } else if (!isJsonSpace(ch)) {
      out += ch;
    }
  }
  return out;
}
