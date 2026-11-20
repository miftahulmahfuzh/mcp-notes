#!/usr/bin/env bash
# Builds the film the seek-preview journey plays (seek-previews.steps.mjs): 600 s, 640x360 at 25 fps, a
# white bar 48 px wide that crosses a dark picture from left to right over the whole film (its left edge
# at t*592/600 px), so every stretch looks different and a frame gives away its time; a 440 Hz tone tagged
# English. Two copies of the same frames:
#   OUT_DIR/film.mp4   H.264/AAC, faststart: a torrent's file Chrome plays as is (TORRENT_FIXTURE_FILE)
#   OUT_DIR/hls/       master.m3u8 naming one rendition, index.m3u8, 2 s segments copied from film.mp4:
#                      the cloud film the fixture stream host serves in mode hls_film (<run>/direct/film)
# Usage: make-preview-film.sh OUT_DIR   (prints OUT_DIR; a finished OUT_DIR is reused)
set -euo pipefail
out=${1:?usage: make-preview-film.sh OUT_DIR}
if [ -f "$out/.done" ]; then
  echo "$out"
  exit 0
fi
command -v ffmpeg >/dev/null || { echo "make-preview-film: ffmpeg not found" >&2; exit 1; }
mkdir -p "$out/hls"
ffmpeg -hide_banner -loglevel error -nostdin -y \
  -f lavfi -i "color=c=0x1e1e1e:s=640x360:r=25:d=600" \
  -f lavfi -i "color=c=white:s=48x360:r=25:d=600" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=600" \
  -filter_complex "[0:v][1:v]overlay=x='t*592/600':y=0:eval=frame:shortest=1[v]" \
  -map '[v]' -map 2:a \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 50 -keyint_min 50 -sc_threshold 0 \
  -c:a aac -b:a 48k -ac 1 -metadata:s:a:0 language=eng -movflags +faststart "$out/film.mp4"
(
  cd "$out/hls"
  ffmpeg -hide_banner -loglevel error -nostdin -y -i ../film.mp4 -c copy \
    -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_filename 'seg%03d.ts' index.m3u8
  printf '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"\nindex.m3u8\n' >master.m3u8
)
touch "$out/.done"
echo "$out"
