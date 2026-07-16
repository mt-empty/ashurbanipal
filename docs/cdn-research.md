# Frontend CDN library research

Candidates evaluated for the three CDN-loaded pieces `dbviewer.html` needs:
JSON tree viewer, syntax highlighting, and the (deferred) diff viewer.
Constraint for all three: framework-agnostic, loadable via a `<script>`/ESM
CDN tag, no build step — per the single-file frontend property in
`design.md`.

## 1. JSON tree viewer — for expanding `jsonb` columns

| Library | Size / deps | CDN | Notes |
|---|---|---|---|
| **`@alenaksu/json-viewer`** | 9.4 KB gzip / 26 KB raw, bundles Lit internally | `unpkg.com/@alenaksu/json-viewer@2.1.0/dist/json-viewer.bundle.js` | Web Component (`<json-viewer>` custom element). MIT, actively maintained (v2.1.2, Oct 2024). Built-in per-type syntax coloring (strings/numbers/booleans/null), search/highlight, `expand()`/`collapse()`/`expandAll()`/`collapseAll()` API, CSS custom properties for theming. |
| renderjson | Single file, zero dependencies | Plain `<script>` tag | Old but stable micro-library (ISC). Does one thing — collapsible/themeable trees — but per-type coloring and search would need to be hand-rolled. |
| JsonTree.js | Zero dependencies, TypeScript, actively maintained (v4.7.1, Apr 2025) | jsDelivr (`gh/williamtroup/JsonTree.js`) | Much larger feature set: editing, drag-drop, 52 translations. Most of that is unnecessary weight for a read-only viewer. |

**Decision**: **`@alenaksu/json-viewer`**. Comparable footprint to renderjson
(~9 KB gzip either way once you account for the styling renderjson would
need by hand), but actively maintained, MIT-licensed, and gives per-type
syntax coloring + search out of the box via a plain custom element —
`<json-viewer data='...'></json-viewer>` with no manual DOM wiring.

## 2. Syntax highlighting — for formatted cell values

Verified via Bundlephobia:

| Library | Gzip size | Notes |
|---|---|---|
| **Prism.js** (core, no languages) | ~7 KB | Load core + only the language grammars actually needed (`json`, maybe `sql`) à la carte from CDN. |
| highlight.js (default bundle, all languages) | ~305 KB gzip / ~956 KB raw | Ships every language by default unless you use their custom-build downloader or the "core" entry point + manual language registration. |

The use case here isn't general source-code highlighting — it's mostly
formatted `jsonb`/value display. That's a small, well-defined grammar need,
not a "detect any language" need.

**Recommendation**: **Prism.js**, loading only the `json` (and optionally
`sql`) components. ~40x smaller than highlight.js's default bundle for the
same practical coverage.

## 3. Diff viewer (deferred, but resolves the open question from `design.md` §9)

This is the one with a real finding, not just a size tradeoff.

**`@pierre/diffs` is not viable for this frontend.** Checked its
`package.json` directly: it declares `react` and `react-dom` as **peer
dependencies**, and depends on `shiki` + `@shikijs/transformers` for
highlighting. It's a React component library, not a vanilla-JS/ESM utility
— the "ESM build exists" fact from the earlier check is true but irrelevant,
since using it still requires React/ReactDOM in the page. That directly
conflicts with `dbviewer.html`'s framework-agnostic, single-file design.
This rules it out, not just deprioritizes it.

| Option | Fit |
|---|---|
| **Monaco diff editor** (original plan) | Framework-agnostic (AMD-loaded via `loader.js` from CDN), mature, MIT-licensed, actively maintained by Microsoft. Built-in side-by-side diff editor mode. Text/line diff, not object-structural diff — but pretty-printing the `jsonb` value before diffing gets clean, readable results, same as any text differ would need. Heavier download than the alternatives (tens of MB unpacked, though only the used pieces are fetched/cached), which is the known tradeoff for choosing it. |
| `@pierre/diffs` | **Ruled out** — hard React peer dependency. |
| `diff2html` + `jsdiff` | Lightweight (`jsdiff` computes the diff, `diff2html` renders it), vanilla JS, CDN bundles confirmed available at `cdn.jsdelivr.net/npm/diff2html/bundles/`, supports side-by-side mode. No structural JSON awareness, no editor chrome (folding, minimap) — purely a diff renderer. Worth a look as a lighter-weight fallback if Monaco's payload size becomes a real complaint later. |

**Recommendation**: keep **Monaco** as the plan when the diff viewer gets
built — it's still the strongest fit and was already the original design.
Drop `@pierre/diffs` from consideration entirely rather than revisiting it;
the React dependency isn't a version-specific detail that might change, it's
structural to how the library is built. `diff2html`+`jsdiff` is worth
keeping in mind as a lighter alternative if Monaco's size is ever a problem,
but there's no reason to switch away from the original plan otherwise.
