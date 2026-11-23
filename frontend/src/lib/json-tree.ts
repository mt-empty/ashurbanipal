// ---- jsonb tree rendering: hand-rolled, dependency-free. foldDoc turns a
// scanned document (lib/json-doc.ts) into a plain shape tree (testable in
// isolation); renderNode walks that tree into DOM. Each object/array gets one gutter fold toggle (▾,
// VS Code/Zed-style) that collapses just that block to an inline
// "{…}"/"[…]"; per-value coloring needs no tokenizer since the scan already
// tells us each value's real type. Every line is its own block-level div, so
// indentation is uniform per nesting depth regardless of preceding key
// length. Leaf lines can carry actions (the `=` and ⧉ of a JSON path filter),
// given the leaf's path and the text a filter compares it as. ----

import type { PathStep } from "../core/types.js";
import type { Doc, DocNode } from "./json-doc.js";

export type JsonScalarKind = "null" | "bool" | "number" | "string" | "uuid";

const SCALAR_CLASS: Record<JsonScalarKind, string> = {
  null: "json-null",
  bool: "json-bool",
  number: "json-number",
  string: "json-string",
  uuid: "json-string json-uuid",
};

export type JsonNode =
  // `text` is what the tree shows; `value` what a path filter compares (null for a JSON null).
  | { kind: "scalar"; scalar: JsonScalarKind; text: string; value: string | null }
  | { kind: "empty"; open: "{" | "["; close: "}" | "]" }
  | { kind: "container"; open: "{" | "["; close: "}" | "]"; entries: { key?: string; node: JsonNode }[] };

type Prefix = (Node | string)[] | null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stringNode(value: string): JsonNode {
  return { kind: "scalar", scalar: UUID_RE.test(value) ? "uuid" : "string", text: JSON.stringify(value), value };
}

// A number shows (and filters by) its own text: 1.50, not 1.5.
export function foldDoc(doc: Doc, node: DocNode = doc.root): JsonNode {
  if (node.kind === "array") {
    const entries = node.items.map((item) => ({ node: foldDoc(doc, item) }));
    return entries.length === 0
      ? { kind: "empty", open: "[", close: "]" }
      : { kind: "container", open: "[", close: "]", entries };
  }
  if (node.kind === "object") {
    // A repeated key keeps its last value at its first position, as JSON.parse does.
    const last = new Map(node.entries.map((e) => [e.key, e.node]));
    const entries = [...last].map(([key, value]) => ({ key, node: foldDoc(doc, value) }));
    return entries.length === 0
      ? { kind: "empty", open: "{", close: "}" }
      : { kind: "container", open: "{", close: "}", entries };
  }
  if (node.kind === "string") return stringNode(node.value);
  if (node.kind === "null") return { kind: "scalar", scalar: "null", text: "null", value: null };
  const text = doc.text.slice(node.start, node.end);
  return { kind: "scalar", scalar: node.kind === "number" ? "number" : "bool", text, value: text };
}

export type LeafActions = (path: PathStep[], value: string | null, scalar: JsonScalarKind) => Node[];

export interface TreeOptions {
  leafActions?: LeafActions;
  // Members to mark with the wash a path filter's match gets in the grid.
  isMatched?: (path: readonly PathStep[]) => boolean;
}

export function renderJsonTree(node: JsonNode, opts: TreeOptions = {}): HTMLElement {
  return renderNode(node, null, false, [], opts);
}

// prefix: [keySpan, ": "] for object entries, or null for array/top level.
function renderNode(node: JsonNode, prefix: Prefix, comma: boolean, path: PathStep[], opts: TreeOptions): HTMLElement {
  const marked = path.length > 0 && opts.isMatched?.(path) === true;
  if (node.kind === "scalar") {
    const line = document.createElement("div");
    line.className = marked ? "json-line json-match" : "json-line";
    if (prefix) line.append(...prefix);
    line.append(scalarSpan(node));
    if (comma) line.append(",");
    const acts = opts.leafActions?.(path, node.value, node.scalar) ?? [];
    if (acts.length > 0) {
      const span = document.createElement("span");
      span.className = "json-acts";
      span.append(...acts);
      line.append(span);
    }
    return line;
  }

  if (node.kind === "empty") {
    const line = document.createElement("div");
    line.className = marked ? "json-line json-match" : "json-line";
    if (prefix) line.append(...prefix);
    const span = document.createElement("span");
    span.className = "json-punct";
    span.textContent = node.open + node.close + (comma ? "," : "");
    line.append(span);
    return line;
  }

  const treeNode = document.createElement("div");
  treeNode.className = marked ? "json-node json-match" : "json-node";

  const fold = document.createElement("button");
  fold.type = "button";
  fold.className = "json-fold";
  fold.setAttribute("aria-expanded", "true");
  fold.setAttribute("aria-label", "collapse");
  fold.onclick = () => {
    const collapsed = treeNode.classList.toggle("collapsed");
    fold.setAttribute("aria-expanded", String(!collapsed));
    fold.setAttribute("aria-label", collapsed ? "expand" : "collapse");
  };

  const openLine = document.createElement("div");
  openLine.className = "json-line";
  const openBrace = document.createElement("span");
  openBrace.className = "json-punct";
  openBrace.textContent = node.open;
  // Duplicates closeLine's punctuation/comma; only one is ever visible
  // (see .json-node.collapsed CSS), so no state to keep in sync.
  const ellipsis = document.createElement("span");
  ellipsis.className = "json-ellipsis";
  ellipsis.textContent = `…${node.close}${comma ? "," : ""}`;
  if (prefix) openLine.append(...prefix);
  openLine.append(fold, openBrace, ellipsis);

  const children = document.createElement("div");
  children.className = "json-children";
  node.entries.forEach((entry, i) => {
    const childPrefix = entry.key === undefined ? null : keyPrefix(entry.key);
    const step = entry.key ?? i;
    children.append(renderNode(entry.node, childPrefix, i < node.entries.length - 1, [...path, step], opts));
  });

  const closeLine = document.createElement("div");
  closeLine.className = "json-line";
  const closeBrace = document.createElement("span");
  closeBrace.className = "json-punct";
  closeBrace.textContent = node.close + (comma ? "," : "");
  closeLine.append(closeBrace);

  treeNode.append(openLine, children, closeLine);
  return treeNode;
}

function keyPrefix(key: string): (Node | string)[] {
  const span = document.createElement("span");
  span.className = "json-key";
  span.textContent = JSON.stringify(key);
  return [span, ": "];
}

function scalarSpan(node: { scalar: JsonScalarKind; text: string }): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = SCALAR_CLASS[node.scalar];
  span.textContent = node.text;
  return span;
}
