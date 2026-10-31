// Modules build-demo.mjs supplies: seed SQL as text, and the synthetic page's snapshot.
declare module "*.sql" {
  const text: string;
  export default text;
}

// A Snapshot (synthetic/snapshot-types.ts); an ambient module can't import it by relative path.
declare module "virtual:demo-snapshot" {
  const snapshot: unknown;
  export default snapshot;
}
