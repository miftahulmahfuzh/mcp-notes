#!/usr/bin/env bash
# Builds the DASH film the expiry journey plays (dash-expiry.steps.mjs): 120 s, 360p video and
# audio in 2 s segments, one manifest.mpd with a segment template. The fixture stream host
# (tests/fixtures/direct-stream/upstream.mjs --state DIR) serves it from DIR/film under an address
# that carries a token.
# Usage: make-dash-fixture.sh OUT_DIR   (prints OUT_DIR; a finished OUT_DIR is reused)
set -euo pipefail
out=${1:?usage: make-dash-fixture.sh OUT_DIR}
if [ -f "$out/.done" ]; then
  echo "$out"
  exit 0
fi
command -v ffmpeg >/dev/null || { echo "make-dash-fixture: ffmpeg not found" >&2; exit 1; }
mkdir -p "$out"
(
  cd "$out"
  ffmpeg -loglevel error -y \
    -f lavfi -i "testsrc2=size=640x360:rate=25" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000" \
    -t 120 -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 50 -keyint_min 50 -sc_threshold 0 \
    -c:a aac -b:a 64k \
    -f dash -seg_duration 2 -use_template 1 -use_timeline 0 \
    -init_seg_name 'init-$RepresentationID$.m4s' -media_seg_name 'seg-$RepresentationID$-$Number%05d$.m4s' \
    manifest.mpd
)
touch "$out/.done"
echo "$out"
