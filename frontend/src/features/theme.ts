import { $ } from "../core/dom.js";

const THEME_KEY = "ashurbanipal_theme";

// ==== Theme ====
// A device display preference, not view state — deliberately kept out of
// `state`/UI_KEY (which mirror to the URL) and given its own localStorage
// key. Which icon shows and which color-scheme applies are both pure CSS
// (system prefers-color-scheme by default, overridden by :root[data-theme]
// — see styles.css) and need no JS at all. This is the one thing CSS can't
// do: write the explicit choice to localStorage so a click survives a
// reload. The inline <script> in <head> applies any saved override before
// first paint, so there's no flash on load either.
function currentTheme(): "light" | "dark" {
  const saved = document.documentElement.dataset.theme;
  if (saved === "light" || saved === "dark") return saved;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
$("theme-toggle").setAttribute("aria-pressed", String(currentTheme() === "dark"));
$("theme-toggle").onclick = () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  $("theme-toggle").setAttribute("aria-pressed", String(next === "dark"));
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* best-effort */
  }
};
