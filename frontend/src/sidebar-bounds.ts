// The sidebar width key and clamp bounds. A standalone leaf so build.mjs can
// import it too: index.html's pre-paint <script> needs these values but runs
// before the module bundle and can't import at runtime, so build.mjs reads
// them here and injects them into that script.
export const SIDEBAR_W_KEY = "ashurbanipal_sidebar_w";
export const SIDEBAR_MIN_W = 180;
export const SIDEBAR_MAX_W = 500;
