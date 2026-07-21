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

**Superseded (2026-07-21):** implemented as a hand-rolled `<details>`/
`<summary>` tree (`renderJsonTree` in `dbviewer.html`) instead. `R3`
(`ui-guidelines.md`) requires any CDN enhancement to degrade to a working
plain-text fallback if unreachable — building that fallback well is most of
the work anyway, so finishing it as the real implementation avoided both
the CDN dependency and Lit's bundled weight, at the cost of the library's
built-in search (not yet missed; can be added later).

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

**Superseded (2026-07-21):** the jsonb use case is covered by
`renderJsonTree` (see §1's update) — its scalar spans are colored directly
off `JSON.parse`'s own type info, no tokenizer needed. Whole-cell coloring
for `uuid`/`boolean`/numeric/date columns (`formatCellValue` in
`dbviewer.html`) is a similarly direct `col.type` lookup, not a
highlighting problem at all — the column's real Postgres type is already
known, so there's no text to parse. Prism itself is no longer needed for
either case; nothing here currently needs general syntax highlighting.

## 3. Diff viewer (deferred, but resolves the open question from `design.md` §9)

This is the one with a real finding, not just a size tradeoff.

**Update (2026-07-20): `@pierre/diffs` no longer requires React.** The
original finding below (React/ReactDOM as a mandatory peer dependency) is
stale. As of `@pierre/diffs@1.2.12` (current npm `latest`; same story on
the `1.3.0-beta.11` beta line), the package split into a vanilla core plus
optional React bindings:

- `README.md` now says explicitly: "Available as vanilla JavaScript and
  React components."
- Exports split by subpath: `.` (vanilla, Web-Components-based —
  `customElements.define` + Shadow DOM, confirmed by reading
  `src/components/web-components.ts`), `./react` (React wrapper), `./ssr`,
  `./worker`.
- Checked all 170 source files under `packages/diffs/src` in the
  [pierrecomputer/pierre](https://github.com/pierrecomputer/pierre) repo:
  the only file outside `src/react/` that imports `react`/`react-dom` is
  `src/ssr/FileDiffReact.tsx`, an opt-in SSR helper not reachable from the
  `.` export.
- `package.json` still lists `react`/`react-dom` as unconditional
  `peerDependencies` for the whole package (not marked optional via
  `peerDependenciesMeta`) — looks like an unfixed packaging detail, not a
  functional requirement. It only matters to npm-install-based tooling and
  is irrelevant to a CDN-script/ESM consumer like this frontend, since
  nothing here runs `npm install`.
- `dist/index.js` (the vanilla entry) is unbundled multi-file ESM with one
  bare-specifier dependency, `"shiki"` (plus, transitively,
  `hast-util-to-html`, `lru_map`, `@pierre/theme`, `@pierre/theming`,
  `@shikijs/transformers`). Loading it via a plain `<script type="module">`
  needs either `esm.sh` (which rewrites bare imports to also resolve from
  esm.sh) or a browser import map — `unpkg.com/@pierre/diffs@1.2.12/dist/index.js`
  200s on its own but won't resolve `"shiki"` without one of those.

This reopens `@pierre/diffs` as a candidate; it should no longer be treated
as ruled out. It hasn't been re-evaluated against Monaco/`diff2html` on
actual fit (API ergonomics, real bundle weight once `shiki` is pulled in,
editor-chrome needs) — that comparison should happen when the diff viewer
is actually implemented, per `design.md` §9's "revisit... once the core
browser is in use."

| Option | Fit |
|---|---|
| **Monaco diff editor** (original plan) | Framework-agnostic (AMD-loaded via `loader.js` from CDN), mature, MIT-licensed, actively maintained by Microsoft. Built-in side-by-side diff editor mode. Text/line diff, not object-structural diff — but pretty-printing the `jsonb` value before diffing gets clean, readable results, same as any text differ would need. Heavier download than the alternatives (tens of MB unpacked, though only the used pieces are fetched/cached), which is the known tradeoff for choosing it. |
| `@pierre/diffs` | **No longer ruled out** — vanilla-JS core confirmed, no React required (see above). Needs its own evaluation pass (bundle weight with `shiki`, import-map/`esm.sh` loading story, API fit) before it can be recommended over Monaco. |
| `diff2html` + `jsdiff` | Lightweight (`jsdiff` computes the diff, `diff2html` renders it), vanilla JS, CDN bundles confirmed available at `cdn.jsdelivr.net/npm/diff2html/bundles/`, supports side-by-side mode. No structural JSON awareness, no editor chrome (folding, minimap) — purely a diff renderer. Worth a look as a lighter-weight fallback if Monaco's payload size becomes a real complaint later. |

**Recommendation**: keep **Monaco** as the default plan for now — it's the
only option of the three fully vetted against this project's constraints.
`@pierre/diffs` is a real contender again and deserves a proper bake-off
against Monaco when the diff viewer actually gets built; don't default back
to Monaco without that comparison just because it was the original plan.
`diff2html`+`jsdiff` remains the lighter-weight fallback if either of the
other two turns out too heavy.
