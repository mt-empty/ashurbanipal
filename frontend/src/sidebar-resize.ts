import { $ } from "./dom.js";

const SIDEBAR_W_KEY = "ashurbanipal_sidebar_w";
// Bounds duplicated in index.html's pre-paint <script> (which can't import this).
const MIN_W = 180;
const MAX_W = 500;

function clamp(w: number): number {
  return Math.min(MAX_W, Math.max(MIN_W, w));
}

const handle = $("sidebar-resize-handle");
let dragging = false;

handle.addEventListener("pointerdown", (e) => {
  dragging = true;
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add("sidebar-resizing");
  handle.classList.add("active");
});

handle.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  document.documentElement.style.setProperty("--sidebar-w", `${clamp(e.clientX)}px`);
});

function endDrag(): void {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove("sidebar-resizing");
  handle.classList.remove("active");
  const w = getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w").trim();
  try {
    localStorage.setItem(SIDEBAR_W_KEY, w);
  } catch {
    /* best-effort */
  }
}
handle.addEventListener("pointerup", endDrag);
handle.addEventListener("pointercancel", endDrag);
