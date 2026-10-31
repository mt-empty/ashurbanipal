// Injected by build-demo.mjs into the live demo's worker bundle: node-express's
// filter/join parsers measure input with Buffer.byteLength, and its row
// mapping asks Buffer.isBuffer. A browser has no Buffer.
const encoder = new TextEncoder();

export const Buffer = {
  byteLength: (s: string) => encoder.encode(s).length,
  isBuffer: (_value: unknown) => false,
};
