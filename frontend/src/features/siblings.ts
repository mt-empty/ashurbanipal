import { api } from "../core/api.js";
import { $, el } from "../core/dom.js";
import type { Sibling } from "../core/types.js";

// Same class of bug as loadDataToken: a slow health-check round that
// resolves after a later poll would otherwise overwrite the more-current
// result.
let siblingsRequestToken = 0;
// Warn once per outage, not on every 15s poll; re-armed on the next success.
let siblingsWarned = false;
export async function loadSiblings(): Promise<void> {
  const token = ++siblingsRequestToken;
  let siblings: Sibling[] = [];
  try {
    ({ siblings } = await api<{ siblings: Sibling[] }>("/siblings"));
    siblingsWarned = false;
  } catch (e) {
    if (!siblingsWarned) {
      console.warn("ashurbanipal: /siblings poll failed; hiding the panel", e);
      siblingsWarned = true;
    }
  }
  if (token !== siblingsRequestToken) return; // superseded by a newer poll
  $("siblings").hidden = siblings.length === 0;
  const down = siblings.filter((s) => !s.healthy).length;
  // Text carries the status too, so the dot's color is never the only signal.
  $("siblings-summary").textContent =
    down > 0 ? `Other services · ${down} down` : `Other services · ${siblings.length} up`;
  $("siblings-dot").className = `dot ${down > 0 ? "down" : "up"}`;
  $("siblings-list").replaceChildren(
    ...siblings.map((s) => {
      const a = el("a");
      a.href = s.base_url;
      a.target = "_blank";
      a.rel = "noopener";
      a.className = "sibling-row";
      const dot = el("span", `dot ${s.healthy ? "up" : "down"}`);
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", s.healthy ? "healthy" : "unhealthy");
      const name = el("span", "sibling-name", s.name);
      name.title = s.name; // truncation escape hatch
      const state = el("span", "sibling-state", s.healthy ? "up ↗" : "down ↗");
      a.append(dot, name, state);
      return a;
    }),
  );
}
