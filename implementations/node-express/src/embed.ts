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
const PINNED_FRONTEND_SHA256 = "32952af7ed3fb2a8e1c3a113b70de821fd90c5e47a5267fea22762c1c817be2e";

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
