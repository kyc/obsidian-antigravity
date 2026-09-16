#!/usr/bin/env bash
# Generates placeholder screenshots for the READMEs.
# These are deliberately obvious placeholders: replace each file with a real
# capture from Obsidian, keeping the same file name. See docs/images/README.md.
set -euo pipefail

OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/docs/images"
mkdir -p "$OUT_DIR"

FONT="DejaVu-Sans"
FONT_FILE="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
if [ ! -f "$FONT_FILE" ]; then
  FONT_FILE="$(fc-match -f '%{file}' 'Liberation Sans')"
fi

make_placeholder() {
  local file="$1" label="$2" sub="$3" width="$4" height="$5" bg="$6" fg="$7" accent="$8"

  magick -size "${width}x${height}" "xc:${bg}" \
    -fill "${accent}" -draw "rectangle 0,0 ${width},6" \
    -fill "${fg}" \
    -font "$FONT_FILE" -pointsize 52 -gravity center -annotate "+0-40" "$label" \
    -font "$FONT_FILE" -pointsize 26 -fill "${accent}" -gravity center -annotate "+0+40" "$sub" \
    -font "$FONT_FILE" -pointsize 20 -fill "${accent}" -gravity south -annotate "+0+36" "replace with a real screenshot" \
    -strip \
    "$OUT_DIR/$file"
}

# Dark variants (Obsidian dark theme is the most common default).
make_placeholder "hub-view-dark.png"     "Assistant web hub"   "Embedded agy --hub view"          1600 1000 "#1e1e1e" "#dcddde" "#7f6df2"
make_placeholder "task-modal-dark.png"   "Task dialog"         "Context badge and presets"        1200  800 "#1e1e1e" "#dcddde" "#7f6df2"
make_placeholder "result-modal-dark.png" "Task result"         "Markdown output and actions"      1200  900 "#1e1e1e" "#dcddde" "#7f6df2"
make_placeholder "settings-dark.png"     "Settings panel"      "Language, model, hub, rules"      1400  950 "#1e1e1e" "#dcddde" "#7f6df2"

# Light variants.
make_placeholder "hub-view-light.png"     "Assistant web hub"   "Embedded agy --hub view"          1600 1000 "#ffffff" "#2e3338" "#705dcf"
make_placeholder "task-modal-light.png"   "Task dialog"         "Context badge and presets"        1200  800 "#ffffff" "#2e3338" "#705dcf"
make_placeholder "result-modal-light.png" "Task result"         "Markdown output and actions"      1200  900 "#ffffff" "#2e3338" "#705dcf"
make_placeholder "settings-light.png"     "Settings panel"      "Language, model, hub, rules"      1400  950 "#ffffff" "#2e3338" "#705dcf"

echo "Placeholders written to $OUT_DIR"
ls -1 "$OUT_DIR"
