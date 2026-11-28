import type { PathStep } from "../core/types.js";

// ---- JSON cell text, scanned with each value's source span kept. A number's
// own text matters: the server compares the engine's text (`1.50` on Postgres),
// which JSON.parse would turn into 1.5, and a big integer would lose digits. ----

export type DocNode =
  | { kind: "string"; value: string; start: number; end: number }
  | { kind: "number" | "boolean" | "null"; start: number; end: number }
  | { kind: "object"; entries: Entry[]; start: number; end: number }
  | { kind: "array"; items: DocNode[]; start: number; end: number };

type Entry = { key: string; keyStart: number; node: DocNode };

export interface Doc {
  text: string;
  root: DocNode;
}

// Deeper documents are left unscanned: no wash, no suggestions, and plain text
// in place of a tree. The tree is drawn recursively too, so the cap guards both.
const MAX_DEPTH = 1000;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

class ScanError extends Error {}

export function scanJson(text: string): Doc | null {
  let i = 0;
  const ws = (): void => {
    while (i < text.length && (text[i] === " " || text[i] === "\n" || text[i] === "\r" || text[i] === "\t")) i++;
  };
  // Only a string with an escape needs JSON.parse to decode it.
  const string = (): { value: string; start: number } => {
    const start = i;
    let escaped = false;
    i++;
    while (i < text.length && text[i] !== '"') {
      // JSON forbids a raw U+0000–U+001F inside a string; JSON.parse refuses it too.
      if (text[i] < " ") throw new ScanError();
      if (text[i] === "\\") escaped = true;
      i += text[i] === "\\" ? 2 : 1;
    }
    if (i >= text.length) throw new ScanError();
    i++;
    const value = escaped ? (JSON.parse(text.slice(start, i)) as string) : text.slice(start + 1, i - 1);
    return { value, start };
  };
  const literal = (word: string, kind: "boolean" | "null"): DocNode => {
    if (!text.startsWith(word, i)) throw new ScanError();
    const start = i;
    i += word.length;
    return { kind, start, end: i };
  };
  const value = (depth: number): DocNode => {
    if (depth > MAX_DEPTH) throw new ScanError();
    ws();
    const start = i;
    const c = text[i];
    if (c === "{") {
      i++;
      const entries: Entry[] = [];
      ws();
      if (text[i] === "}") i++;
      else
        for (;;) {
          ws();
          if (text[i] !== '"') throw new ScanError();
          const key = string();
          ws();
          if (text[i] !== ":") throw new ScanError();
          i++;
          entries.push({ key: key.value, keyStart: key.start, node: value(depth + 1) });
          ws();
          if (text[i] === ",") i++;
          else if (text[i] === "}") {
            i++;
            break;
          } else throw new ScanError();
        }
      return { kind: "object", entries, start, end: i };
    }
    if (c === "[") {
      i++;
      const items: DocNode[] = [];
      ws();
      if (text[i] === "]") i++;
      else
        for (;;) {
          items.push(value(depth + 1));
          ws();
          if (text[i] === ",") i++;
          else if (text[i] === "]") {
            i++;
            break;
          } else throw new ScanError();
        }
      return { kind: "array", items, start, end: i };
    }
    if (c === '"') {
      const s = string();
      return { kind: "string", value: s.value, start, end: i };
    }
    if (c === "t") return literal("true", "boolean");
    if (c === "f") return literal("false", "boolean");
    if (c === "n") return literal("null", "null");
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) throw new ScanError();
    i += m[0].length;
    return { kind: "number", start, end: i };
  };
  try {
    const root = value(0);
    ws();
    return i === text.length ? { text, root } : null;
  } catch (e) {
    if (e instanceof ScanError || e instanceof SyntaxError) return null;
    throw e;
  }
}

// A repeated key resolves to its last occurrence, as JSON.parse and jsonb do.
function entryOf(node: DocNode | undefined, key: string): Entry | undefined {
  if (node?.kind !== "object") return undefined;
  for (let i = node.entries.length - 1; i >= 0; i--) if (node.entries[i].key === key) return node.entries[i];
  return undefined;
}

// The node a path reaches; undefined for a missing key or a step into the wrong kind.
export function nodeAt(root: DocNode, path: readonly PathStep[]): DocNode | undefined {
  let node: DocNode | undefined = root;
  for (const step of path) {
    if (node === undefined) return undefined;
    if (typeof step === "number") node = node.kind === "array" ? node.items[step] : undefined;
    else node = entryOf(node, step)?.node;
  }
  return node;
}

// The text the server compares a path's value as (spec/protocol.md §5.4.2):
// a string unquoted, anything else its JSON text, and null for a JSON null.
export function compareText(doc: Doc, node: DocNode): string | null {
  if (node.kind === "null") return null;
  return node.kind === "string" ? node.value : doc.text.slice(node.start, node.end);
}

export type KeyKind = "text" | "number" | "boolean" | "null" | "object" | "array" | "mixed";

export interface KeySeen {
  step: PathStep;
  // What it holds, or "mixed" when the rows disagree.
  kind: KeyKind;
  // Rows that have it.
  count: number;
}

// The keys (or, under an array, the indexes) one step below `path`, most common first.
export function keysAt(docs: readonly Doc[], path: readonly PathStep[]): KeySeen[] {
  const seen = new Map<PathStep, KeySeen>();
  const note = (step: PathStep, node: DocNode): void => {
    const kind: KeyKind = node.kind === "string" ? "text" : node.kind;
    const entry = seen.get(step);
    if (!entry) seen.set(step, { step, kind, count: 1 });
    else {
      entry.count++;
      if (entry.kind !== kind) entry.kind = "mixed";
    }
  };
  const keys = new Set<string>();
  for (const doc of docs) {
    const node = nodeAt(doc.root, path);
    if (node?.kind === "object") {
      // From the end, so a repeated key counts once, with its last value.
      keys.clear();
      for (let i = node.entries.length - 1; i >= 0; i--) {
        const { key, node: child } = node.entries[i];
        if (!keys.has(key)) {
          keys.add(key);
          note(key, child);
        }
      }
    } else if (node?.kind === "array") for (const [i, child] of node.items.entries()) note(i, child);
  }
  return [...seen.values()].sort((a, b) => b.count - a.count);
}

export interface ValueSeen {
  text: string;
  // Rows that hold it.
  count: number;
  // Held as a JSON number in at least one of them.
  number: boolean;
}

// The scalar values at `path` with how many rows hold each, most common first.
export function valuesAt(docs: readonly Doc[], path: readonly PathStep[]): ValueSeen[] {
  const seen = new Map<string, ValueSeen>();
  for (const doc of docs) {
    const node = nodeAt(doc.root, path);
    if (!node || node.kind === "object" || node.kind === "array") continue;
    const text = compareText(doc, node);
    if (text === null) continue;
    const entry = seen.get(text) ?? { text, count: 0, number: false };
    entry.count++;
    entry.number ||= node.kind === "number";
    seen.set(text, entry);
  }
  return [...seen.values()].sort((a, b) => b.count - a.count);
}

// Where the member a path names sits in the text: from its key to the end of
// its value (just the value for an array item). Null when the path misses.
export function spanAt(doc: Doc, path: readonly PathStep[]): { start: number; end: number } | null {
  if (path.length === 0) return null;
  const parent = nodeAt(doc.root, path.slice(0, -1));
  const step = path[path.length - 1];
  if (typeof step === "number") {
    const item = parent?.kind === "array" ? parent.items[step] : undefined;
    return item ? { start: item.start, end: item.end } : null;
  }
  const entry = entryOf(parent, step);
  return entry ? { start: entry.keyStart, end: entry.node.end } : null;
}
