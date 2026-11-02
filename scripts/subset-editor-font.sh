#!/usr/bin/env bash
# The editor only renders source text, so the patched Nerd Font icon glyphs are
# left out. Pass the upstream JetBrainsMonoNerdFont-Regular.ttf from Nerd Fonts.
set -euo pipefail
cd "$(dirname "$0")/.."
font=${1:?Usage: $0 /path/to/JetBrainsMonoNerdFont-Regular.ttf}
pyftsubset "$font" \
  --output-file=assets/fonts/JetBrainsMono-Regular.ttf \
  --unicodes='U+0020-007E,U+00A0-00FF,U+2000-206F,U+2190-21FF,U+2500-257F' \
  --layout-features='*'
