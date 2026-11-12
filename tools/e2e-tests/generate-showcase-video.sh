#!/bin/bash
# Record the showcase.spec.ts walkthrough and encode it to showcase.mp4.
# H.264 + yuv420p + faststart is what GitHub's README player handles in every
# browser; keep the output under GitHub's 10 MB free-plan video upload limit.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CRF="${CRF:-28}"
OUTPUT="${1:-showcase.mp4}"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

if ! command -v ffmpeg >/dev/null 2>&1; then
    echo -e "${RED}[FAIL] ffmpeg is not installed.${NC}"
    echo -e "${YELLOW}Install it, e.g.:${NC}"
    echo "  Debian/Ubuntu: sudo apt-get install ffmpeg"
    echo "  macOS:         brew install ffmpeg"
    exit 1
fi

rm -rf showcase-results
pnpm exec playwright test --config=playwright.showcase.config.ts

video=$(find showcase-results -name '*.webm' | head -1)
if [ -z "$video" ]; then
    echo -e "${RED}[FAIL] No .webm recording found under showcase-results/${NC}"
    exit 1
fi

echo -e "${BLUE}Encoding H.264 MP4 (crf=$CRF)...${NC}"
ffmpeg -i "$video" -c:v libx264 -preset slow -crf "$CRF" -tune animation \
    -pix_fmt yuv420p -movflags +faststart -an -y "$OUTPUT" -loglevel error

size=$(du -h "$OUTPUT" | cut -f1)
echo -e "${GREEN}[OK] Saved $SCRIPT_DIR/$OUTPUT ($size)${NC}"
echo -e "${YELLOW}Upload it to GitHub (e.g. drag into a PR comment) and point readme.md's <video> at the user-attachments URL.${NC}"
