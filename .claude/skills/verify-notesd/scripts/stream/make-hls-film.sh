#!/usr/bin/env bash
# Builds the HLS film the pause-cache journey plays (pause-cache.steps.mjs): 300 s, 360p video and
# audio muxed in 2 s segments, one master.m3u8 naming one rendition, every file in one folder. The
# fixture stream host (tests/fixtures/direct-stream/upstream.mjs --state DIR) serves it from
# DIR/film under an address that carries a token; the fake resolver hands it out in mode hls_film.
# Usage: make-hls-film.sh OUT_DIR   (prints OUT_DIR; a finished OUT_DIR is reused)
set -euo pipefail
out=${1:?usage: make-hls-film.sh OUT_DIR}
if [ -f "$out/.done" ]; then
  echo "$out"
  exit 0
fi
command -v ffmpeg >/dev/null || { echo "make-hls-film: ffmpeg not found" >&2; exit 1; }
mkdir -p "$out"
(
  cd "$out"
  ffmpeg -loglevel error -y \
    -f lavfi -i "testsrc2=size=640x360:rate=25" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000" \
    -t 300 -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 50 -keyint_min 50 -sc_threshold 0 \
    -c:a aac -b:a 64k \
    -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_filename 'seg%03d.ts' index.m3u8
  printf '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"\nindex.m3u8\n' > master.m3u8
)
touch "$out/.done"
echo "$out"
