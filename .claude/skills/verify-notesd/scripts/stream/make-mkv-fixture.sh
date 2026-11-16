#!/usr/bin/env bash
# Builds the film the torrent remux journeys play (torrent-remux.steps.mjs): 120 s of 640x360 H.264 with a keyframe
# every 2 s and two AC3 5.1 tracks, Spanish (440 Hz) then English (660 Hz), in an MKV: a file Chrome cannot play as
# is. scripts/torrent/offer-remux.sh hands it to a `verify.sh up --torrent` run (phase 1's seed folder, phase 3's
# candidates.json).
# Usage: make-mkv-fixture.sh OUT_DIR   (prints OUT_DIR; a finished OUT_DIR is reused)
set -euo pipefail
out=${1:?usage: make-mkv-fixture.sh OUT_DIR}
if [ -f "$out/.done" ]; then
  echo "$out"
  exit 0
fi
command -v ffmpeg >/dev/null || { echo "make-mkv-fixture: ffmpeg not found" >&2; exit 1; }
mkdir -p "$out"
ffmpeg -loglevel error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=24" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -f lavfi -i "sine=frequency=660:sample_rate=48000" \
  -t 120 -map 0:v -map 1:a -map 2:a \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 48 \
  -c:a ac3 -b:a 192k -ac 6 \
  -metadata:s:a:0 language=spa -metadata:s:a:1 language=eng \
  "$out/Verify.Fixture.Film.2026.360p.BluRay.x264.AC3-NOTESD.mkv"
touch "$out/.done"
echo "$out"
