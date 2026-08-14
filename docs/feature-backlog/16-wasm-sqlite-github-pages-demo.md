# WASM SQLite backend for the GitHub Pages demo

**What it is:** replace `docs/demo/`'s fetch-shim backend
(`frontend/src/demo-shim.ts` answering `/api/*` from JS-array fixtures in
`demo-fixtures.ts`) with a real SQLite database compiled to WebAssembly
(`sql.js` or `wa-sqlite`) running in the browser, so the demo executes
genuine SQL instead of replaying canned fixture logic.

**Tidbits:**
- This was option B considered before the current demo shipped; dropped in
  favor of the fetch-shim because the ask at the time was "full feature,
  even if it's all fake — show the best version," which favored breadth
  and simplicity over SQL-engine fidelity.
- Pro: exercises real SQL semantics (text-cast sort quirks, `LIKE`, jsonb
  functions if the engine supports them) instead of the shim's
  `typedCompare`/`matchesCondition` JS reimplementation of
  `spec/protocol.md` §5.4.2.
- Con: larger payload (WASM binary + DB file vs. a JS fixture module),
  dialect drift to manage (SQLite vs. Postgres differ on `ILIKE`, jsonb
  operators, `NULLS LAST` defaults — see `docs/adapter-decisions.md` for
  the same class of divergence across real backends), and a second build
  pipeline alongside `frontend/build-demo.mjs`.
- Would still need a translation shim between the six `spec/protocol.md`
  routes and SQL text — same shape as `demo-shim.ts`, just delegating to
  the WASM engine instead of computing answers in JS.
