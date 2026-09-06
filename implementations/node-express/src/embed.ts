import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Mirrors the Go port's embed.go and PORTING.md's vendoring contract: a
// build pipeline can silently mangle the vendored file, so the hash is
// re-verified on every process start (module load), not just recorded
// once at vendoring time. In a real release this would pin a tagged
// frontend/dbviewer.html release artifact; here it pins this repo's own
// copy since there is no separate tagged release to vendor from yet
// (same caveat the go-nethttp port documents).
const PINNED_FRONTEND_SHA256 = "1cba8dc87e66e7104cb3c37a38348bff631e2d75389c60c4fd171311c303b1c0";

const here = dirname(fileURLToPath(import.meta.url));
// From dist/ (built) or src/ (tsx dev run) the frontend dir is one level up, at the package root.
const frontendPath = join(here, "..", "frontend", "dbviewer.html");

function loadFrontend(): string {
  const contents = readFileSync(frontendPath, "utf8");
  const actual = createHash("sha256").update(contents, "utf8").digest("hex");
  if (actual !== PINNED_FRONTEND_SHA256) {
    throw new Error(
      `ashurbanipal: frontend/dbviewer.html sha256 mismatch: expected ${PINNED_FRONTEND_SHA256}, got ${actual} ` +
        "(the vendored frontend changed upstream — re-pin deliberately, don't silently accept a mangled copy)",
    );
  }
  return contents;
}

export const dbviewerHtml = loadFrontend();
