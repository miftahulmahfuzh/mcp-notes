#!/usr/bin/env bash
# Builds the HLS film the stream player journeys play (player.steps.mjs): 120 s, 720p and 360p,
# a French (DEFAULT=YES) and an English WebVTT track inside the manifest, and a separate English
# .srt. Every address is already in the pass-through's form, /api/stream/sessions/S1/p?u=<path>.
# Usage: make-hls-fixture.sh OUT_DIR   (prints OUT_DIR; a finished OUT_DIR is reused)
set -euo pipefail
out=${1:?usage: make-hls-fixture.sh OUT_DIR}
if [ -f "$out/.done" ]; then
  echo "$out"
  exit 0
fi
command -v ffmpeg >/dev/null || { echo "make-hls-fixture: ffmpeg not found" >&2; exit 1; }
mkdir -p "$out/v720" "$out/v360" "$out/subs"
P='/api/stream/sessions/S1/p?u='

for r in 720 360; do
  w=$((r * 16 / 9))
  ffmpeg -loglevel error -y \
    -f lavfi -i "testsrc2=size=${w}x${r}:rate=25" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000" \
    -t 120 -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 50 -keyint_min 50 -sc_threshold 0 \
    -c:a aac -b:a 64k \
    -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_filename "$out/v$r/seg%03d.ts" "$out/v$r/index.m3u8"
  sed -i -E "s#^(seg[0-9]+\.ts)\$#${P}v$r/\1#" "$out/v$r/index.m3u8"
done

printf 'WEBVTT\n\n00:00:00.000 --> 00:02:00.000\nHello from the English track\n' >"$out/subs/en.vtt"
printf 'WEBVTT\n\n00:00:00.000 --> 00:02:00.000\nBonjour de la piste francaise\n' >"$out/subs/fr.vtt"
for lang in en fr; do
  printf '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:120\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:120.0,\n%ssubs/%s.vtt\n#EXT-X-ENDLIST\n' \
    "$P" "$lang" >"$out/subs/$lang.m3u8"
done
printf '1\r\n00:00:00,000 --> 00:02:00,000\r\nHello from the SRT file\r\n' >"$out/subs/en.srt"

cat >"$out/master.m3u8" <<EOF
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Francais",LANGUAGE="fr",DEFAULT=YES,AUTOSELECT=YES,URI="${P}subs/fr.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="${P}subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",SUBTITLES="subs"
${P}v720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",SUBTITLES="subs"
${P}v360/index.m3u8
EOF
touch "$out/.done"
echo "$out"
