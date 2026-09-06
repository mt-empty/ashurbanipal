// ---- jsonb tree rendering: hand-rolled, dependency-free. foldJson turns a
// parsed value into a plain shape tree (testable in isolation); renderNode
// walks that tree into DOM. Each object/array gets one gutter fold toggle (▾,
// VS Code/Zed-style) that collapses just that block to an inline
// "{…}"/"[…]"; per-value coloring needs no tokenizer since JSON.parse already
// tells us each value's real type. Every line is its own block-level div, so
// indentation is uniform per nesting depth regardless of preceding key
// length. ----

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type JsonScalarKind = "null" | "bool" | "number" | "string" | "uuid";

const SCALAR_CLASS: Record<JsonScalarKind, string> = {
  null: "json-null",
  bool: "json-bool",
  number: "json-number",
  string: "json-string",
  uuid: "json-string json-uuid",
};

export type JsonNode =
  | { kind: "scalar"; scalar: JsonScalarKind; text: string }
  | { kind: "empty"; open: "{" | "["; close: "}" | "]" }
  | { kind: "container"; open: "{" | "["; close: "}" | "]"; entries: { key?: string; node: JsonNode }[] };

type Prefix = (Node | string)[] | null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function foldJson(value: JsonValue): JsonNode {
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: "empty", open: "[", close: "]" };
    return { kind: "container", open: "[", close: "]", entries: value.map((v) => ({ node: foldJson(v) })) };
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return { kind: "empty", open: "{", close: "}" };
    return {
      kind: "container",
      open: "{",
      close: "}",
      entries: entries.map(([key, v]) => ({ key, node: foldJson(v) })),
    };
  }
  if (value === null) return { kind: "scalar", scalar: "null", text: "null" };
  if (typeof value === "boolean") return { kind: "scalar", scalar: "bool", text: String(value) };
  if (typeof value === "number") return { kind: "scalar", scalar: "number", text: String(value) };
  return { kind: "scalar", scalar: UUID_RE.test(value) ? "uuid" : "string", text: JSON.stringify(value) };
}

export function renderJsonTree(value: JsonValue): HTMLElement {
  return renderNode(foldJson(value), null, false);
}

// prefix: [keySpan, ": "] for object entries, or null for array/top level.
function renderNode(node: JsonNode, prefix: Prefix, comma: boolean): HTMLElement {
  if (node.kind === "scalar") {
    const line = document.createElement("div");
    line.className = "json-line";
    if (prefix) line.append(...prefix);
    line.append(scalarSpan(node));
    if (comma) line.append(",");
    return line;
  }

  if (node.kind === "empty") {
    const line = document.createElement("div");
    line.className = "json-line";
    if (prefix) line.append(...prefix);
    const span = document.createElement("span");
    span.className = "json-punct";
    span.textContent = node.open + node.close + (comma ? "," : "");
    line.append(span);
    return line;
  }

  const treeNode = document.createElement("div");
  treeNode.className = "json-node";

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
    children.append(renderNode(entry.node, childPrefix, i < node.entries.length - 1));
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
