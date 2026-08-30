import { api } from "./api.js";
import { $ } from "./dom.js";
import type { Sibling } from "./types.js";

// Same class of bug as loadDataToken: a slow health-check round that
// resolves after a later poll would otherwise overwrite the more-current
// result.
let siblingsRequestToken = 0;
export async function loadSiblings(): Promise<void> {
  const token = ++siblingsRequestToken;
  let siblings: Sibling[] = [];
  try { ({ siblings } = await api<{ siblings: Sibling[] }>("/siblings")); } catch { /* leave empty */ }
  if (token !== siblingsRequestToken) return; // superseded by a newer poll
  $("siblings").hidden = siblings.length === 0;
  const div = $("siblings-list");
  div.replaceChildren(...siblings.map((s) => {
    const p = document.createElement("div");
    const dot = document.createElement("span");
    dot.className = "dot " + (s.healthy ? "up" : "down");
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", s.healthy ? "healthy" : "unhealthy");
    const a = document.createElement("a");
    a.href = s.base_url; a.textContent = s.name;
    a.target = "_blank"; a.rel = "noopener";
    a.title = s.name; // truncation escape hatch
    p.className = "sibling-row";
    a.className = "sibling-name";
    p.append(dot, a);
    return p;
  }));
}
