# Diff viewer for comparing two rows

**Where logged:** `design.md` §9.

**What it is:** the originally-scoped feature — a diff editor for comparing
two whole rows against each other, column by column. Deferred to a later
iteration; not built. `jsonb` columns are the main reason a real diff tool
is needed at all — plain scalar columns can be eyeballed side by side, but
a `jsonb` value only becomes comparable once pretty-printed, and that's
where the candidates below (Monaco, `@pierre/diffs`) come in: text/line
diff on the pretty-printed value, not structural JSON diff.

## Candidates evaluated

Constraint for all three: framework-agnostic, loadable via a
`<script>`/ESM CDN tag, no bundler added to the shipped `dbviewer.html` —
per the single-file frontend property in `design.md`.

**Monaco diff editor (default plan).** Framework-agnostic (AMD-loaded via
`loader.js` from CDN), mature, MIT-licensed, actively maintained by
Microsoft. Built-in side-by-side diff editor mode. Text/line diff, not
object-structural diff — but pretty-printing the `jsonb` value before
diffing gets clean, readable results, same as any text differ would need.
Heavier download than the alternatives (tens of MB unpacked, though only
the used pieces are fetched/cached), which is the known tradeoff for
choosing it.

**`@pierre/diffs` — reopened as a candidate, not fully vetted.** Originally
ruled out outright over a hard `react`/`react-dom` peer dependency. Reopened
2026-07-20: as of `@pierre/diffs@1.2.12` (same story on the `1.3.0-beta.11`
beta line), the package split into a vanilla core plus optional React
bindings —

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

It should no longer be treated as ruled out, but hasn't been re-evaluated
against Monaco on actual fit (API ergonomics, real bundle weight once
`shiki` is pulled in, editor-chrome needs) — that comparison should happen
when the diff viewer is actually implemented, not be prejudged here.

**`diff2html` + `jsdiff` — lighter-weight fallback.** `jsdiff` computes the
diff, `diff2html` renders it; vanilla JS, CDN bundles confirmed available
at `cdn.jsdelivr.net/npm/diff2html/bundles/`, supports side-by-side mode.
No structural JSON awareness, no editor chrome (folding, minimap) — purely
a diff renderer. Worth a look if either Monaco's or `@pierre/diffs`'s
payload size becomes a real complaint later — not the primary plan.

## Recommendation

Keep **Monaco** as the default plan for now — it's the only option of the
three fully vetted against this project's constraints. `@pierre/diffs` is a
real contender and deserves a proper bake-off against Monaco when the diff
viewer actually gets built; don't default back to Monaco without that
comparison just because it was the original plan.

## Related

The jsonb tree-view/coloring work this would build on (pretty-printing,
structure-aware rendering) already shipped as a hand-rolled
`<details>`/`<summary>` tree (`renderJsonTree` in `dbviewer.html`) rather
than a CDN library. A diff viewer would still need its own
pretty-print-then-diff step; it doesn't get that for free from
`renderJsonTree`.
