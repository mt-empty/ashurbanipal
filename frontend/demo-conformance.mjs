// Serves the live demo's backend at http://localhost:4005/__ashurbanipal for
// the conformance kit — see src/demo/build/conformance-server.ts.
import { importDemoEntry } from "./demo-node-entry.mjs";

await importDemoEntry("conformance-server");
