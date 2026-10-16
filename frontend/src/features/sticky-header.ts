import { $ } from "../core/dom.js";

// Marks #main while the table header is pinned to its top. Until then the
// toolbar sits above the header, so the filter's suggestion list covers it;
// once pinned the header goes over the toolbar and the list slides behind it
// (styles.css, #chrome).
const main = $("main");
const thead = $("thead");

function update(): void {
  main.classList.toggle("header-stuck", thead.getBoundingClientRect().top < main.getBoundingClientRect().top - 0.5);
}

main.addEventListener("scroll", update, { passive: true });
window.addEventListener("resize", update);
update();
