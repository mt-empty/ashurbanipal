// Re-export barrel. The shared client state is split by concern —
// store.ts (the state object + its persistence + the named scope
// transitions), url.ts (URL params <-> state, read side), row-diff.ts
// (the new-rows-since-refresh derivation) — but consumers keep one
// ./state.js entry point.
export * from "./row-diff.js";
export * from "./store.js";
export * from "./url.js";
