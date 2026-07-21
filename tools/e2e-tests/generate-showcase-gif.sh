#!/bin/bash
# Generate a Bayer-dithered showcase.gif from the showcase.spec.ts Playwright
# recording. Wraps the Playwright run (video capture) + ffmpeg (palette +
# GIF encode) two-pass process: palettegen builds a 256-color palette
# analyzing every frame (stats_mode=full), then paletteuse re-encodes
# against that palette with Bayer dithering — noticeably better color
# fidelity than a single-pass GIF encode (e.g. ImageMagick's default),
# especially across the colored jsonb tree and cell highlights this
# walkthrough shows.
#
# Unlike a from-PNG-frames pipeline (e.g. a per-hour dashboard render),
# there's only one continuous browser recording here, so both ffmpeg passes
# read the .webm directly (via -i) instead of a glob of frame images —
# fps/scale are applied as filters at encode time rather than being baked
# into pre-rendered frames.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

FPS="${FPS:-10}"
WIDTH="${WIDTH:-960}"
OUTPUT_GIF="${1:-showcase.gif}"

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

echo -e "${BLUE}=====================================================${NC}"
echo -e "${BLUE}   dbviewer.html Showcase GIF Generator${NC}"
echo -e "${BLUE}=====================================================${NC}"
echo ""

rm -rf showcase-results
pnpm exec playwright test --config=playwright.showcase.config.ts

video=$(find showcase-results -name '*.webm' | head -1)
if [ -z "$video" ]; then
    echo -e "${RED}[FAIL] No .webm recording found under showcase-results/${NC}"
    exit 1
fi

FILTER="fps=$FPS,scale=$WIDTH:-1:flags=lanczos"

echo ""
echo -e "${BLUE}Generating optimized palette (fps=$FPS, width=$WIDTH)...${NC}"
palette="$(mktemp -t showcase-palette-XXXX.png)"
ffmpeg -i "$video" -vf "$FILTER,palettegen=max_colors=256:stats_mode=full" \
    -y "$palette" -loglevel error
echo -e "${GREEN}[OK] Palette generated${NC}"

echo -e "${BLUE}Encoding GIF with Bayer dithering...${NC}"
ffmpeg -i "$video" -i "$palette" \
    -lavfi "$FILTER[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
    -y "$OUTPUT_GIF" -loglevel error
rm -f "$palette"
echo -e "${GREEN}[OK] GIF saved: $SCRIPT_DIR/$OUTPUT_GIF${NC}"

echo ""
echo -e "${GREEN}=====================================================${NC}"
echo -e "${GREEN}   Done!${NC}"
echo -e "${GREEN}=====================================================${NC}"
echo ""
echo -e "${YELLOW}Tips:${NC}"
echo -e "  - Preview: open $OUTPUT_GIF"
echo -e "  - Adjust quality/size: FPS=6 WIDTH=800 ./generate-showcase-gif.sh"
echo -e "  - Clean up the recording: rm -rf showcase-results"
echo ""
