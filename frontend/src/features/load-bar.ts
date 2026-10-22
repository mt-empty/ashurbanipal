import { $ } from "../core/dom.js";

// The one progress bar on the grid's top edge. A slow fetch ("loading") wins
// over the auto-refresh countdown; both are decorative (aria-hidden).

const bar = $("load-bar");

let loading = false;
let counting = false;

function render(): void {
  if (loading) bar.dataset.state = "loading";
  else if (counting) bar.dataset.state = "countdown";
  else delete bar.dataset.state;
}

export function setLoadingBar(on: boolean): void {
  loading = on;
  render();
}

// Restarting needs a style flush between the two states, or the CSS animation keeps its old progress.
export function startCountdown(durationMs: number, elapsedMs: number): void {
  counting = true;
  delete bar.dataset.state;
  bar.style.setProperty("--bar-duration", `${durationMs}ms`);
  bar.style.setProperty("--bar-elapsed", `${elapsedMs}ms`);
  void getComputedStyle(bar).animationName;
  render();
}

export function stopCountdown(): void {
  counting = false;
  render();
}
