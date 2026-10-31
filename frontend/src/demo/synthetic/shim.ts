// The synthetic demo's page script: bundled by build-demo.mjs into
// docs/demo/index.html, answering /api/* from the build-time snapshot.
import { installFetch, showBadge } from "../page-shim.js";
import { serve } from "./serve.js";

installFetch(serve);
showBadge("Demo — synthetic data, no live backend", "Try it on real Postgres →", "live/");
