// ---- jsonb tree rendering: hand-rolled, dependency-free. Each
// object/array gets one gutter fold toggle (▾, VS Code/Zed-style) that
// collapses just that block to an inline "{…}"/"[…]"; per-value coloring
// needs no tokenizer since JSON.parse already tells us each value's real
// type. Every line is its own block-level div, so indentation is uniform
// per nesting depth regardless of preceding key length. ----

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonScalarValue = null | boolean | number | string;

type Prefix = (Node | string)[] | null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function renderJsonTree(value: JsonValue): HTMLElement {
  return jsonEntryValue(value, null, false);
}

// prefix: [keySpan, ": "] for object entries, or null for array/top level.
function jsonEntryValue(value: JsonValue, prefix: Prefix, comma: boolean): HTMLElement {
  if (Array.isArray(value)) {
    return jsonContainer(value.map((v) => ({ prefix: null, value: v })), "[", "]", prefix, comma);
  }
  if (value !== null && typeof value === "object") {
    return jsonContainer(
      Object.entries(value).map(([k, v]) => ({ prefix: jsonKeyPrefix(k), value: v })),
      "{", "}", prefix, comma,
    );
  }
  const line = document.createElement("div");
  line.className = "json-line";
  if (prefix) line.append(...prefix);
  line.append(jsonScalar(value));
  if (comma) line.append(",");
  return line;
}

function jsonKeyPrefix(key: string): Prefix {
  const span = document.createElement("span");
  span.className = "json-key";
  span.textContent = JSON.stringify(key);
  return [span, ": "];
}

function jsonContainer(
  entries: { prefix: Prefix; value: JsonValue }[],
  openCh: string,
  closeCh: string,
  prefix: Prefix,
  comma: boolean,
): HTMLElement {
  if (entries.length === 0) {
    const line = document.createElement("div");
    line.className = "json-line";
    if (prefix) line.append(...prefix);
    const span = document.createElement("span");
    span.className = "json-punct";
    span.textContent = openCh + closeCh + (comma ? "," : "");
    line.append(span);
    return line;
  }

  const node = document.createElement("div");
  node.className = "json-node";

  const fold = document.createElement("button");
  fold.type = "button";
  fold.className = "json-fold";
  fold.setAttribute("aria-expanded", "true");
  fold.setAttribute("aria-label", "collapse");
  fold.onclick = () => {
    const collapsed = node.classList.toggle("collapsed");
    fold.setAttribute("aria-expanded", String(!collapsed));
    fold.setAttribute("aria-label", collapsed ? "expand" : "collapse");
  };

  const openLine = document.createElement("div");
  openLine.className = "json-line";
  const openBrace = document.createElement("span");
  openBrace.className = "json-punct";
  openBrace.textContent = openCh;
  // Duplicates closeLine's punctuation/comma; only one is ever visible
  // (see .json-node.collapsed CSS), so no state to keep in sync.
  const ellipsis = document.createElement("span");
  ellipsis.className = "json-ellipsis";
  ellipsis.textContent = `…${closeCh}${comma ? "," : ""}`;
  if (prefix) openLine.append(...prefix);
  openLine.append(fold, openBrace, ellipsis);

  const children = document.createElement("div");
  children.className = "json-children";
  entries.forEach((entry, i) => {
    children.append(jsonEntryValue(entry.value, entry.prefix, i < entries.length - 1));
  });

  const closeLine = document.createElement("div");
  closeLine.className = "json-line";
  const closeBrace = document.createElement("span");
  closeBrace.className = "json-punct";
  closeBrace.textContent = closeCh + (comma ? "," : "");
  closeLine.append(closeBrace);

  node.append(openLine, children, closeLine);
  return node;
}

function jsonScalar(value: JsonScalarValue): HTMLSpanElement {
  const span = document.createElement("span");
  if (value === null) {
    span.className = "json-null";
    span.textContent = "null";
  } else if (typeof value === "boolean") {
    span.className = "json-bool";
    span.textContent = String(value);
  } else if (typeof value === "number") {
    span.className = "json-number";
    span.textContent = String(value);
  } else {
    span.className = UUID_RE.test(value) ? "json-string json-uuid" : "json-string";
    span.textContent = JSON.stringify(value);
  }
  return span;
}
