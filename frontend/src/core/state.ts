// Re-export barrel. The shared client state is split by concern — store.ts
// (the state object, its persistence, the named scope transitions, and the
// new-rows-since-refresh bookkeeping) and url.ts (URL params <-> state, read
// side) — but consumers keep one ./state.js entry point.
export * from "./store.js";
export * from "./url.js";
