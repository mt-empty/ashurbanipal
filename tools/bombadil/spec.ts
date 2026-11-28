// Bombadil spec for the viewer on the seed database; run it with `mise run frontend:explore`
// (docs/e2e-testing-guidelines.md). Bombadil reads only this file's exports: every exported
// formula is a property, and the one exported generator decides the actions.
export { noHttpErrorCodes, noUncaughtExceptions } from "@antithesishq/bombadil/browser/defaults";
export { explore } from "./lib/actions.ts";
export {
  busySettles,
  noConsoleErrors,
  noErrorBanner,
  noUnhandledRejections,
  pageNeverOverflows,
  reloadKeepsTheView,
} from "./lib/properties.ts";
