#!/usr/bin/env bash
# make-subtitle-fixtures.sh OUT: the fixture torrent folders of TORRENT_STREAM_SOURCE phase 6's journeys, made
# once with ffmpeg and cached (OUT/.done). Prints OUT. Each folder is one torrent; a Film.nfo naming the folder
# makes every info hash different. The video is H.264/AAC MP4 (Chrome plays it as is).
set -euo pipefail
OUT=${1:?usage: make-subtitle-fixtures.sh OUT}
if [ -f "$OUT/.done" ]; then echo "$OUT"; exit 0; fi
command -v ffmpeg >/dev/null || { echo "make-subtitle-fixtures: ffmpeg not found" >&2; exit 1; }
mkdir -p "$OUT"
film() { # film SECONDS FILE
  ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=640x360:rate=24" -f lavfi -i "sine=frequency=440:sample_rate=48000" \
    -t "$1" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart "$2"
}
srt() { printf '1\r\n00:00:01,000 --> 00:00:30,000\r\n%s\r\n\r\n2\r\n00:00:31,000 --> 00:00:59,000\r\n%s (2)\r\n' "$1" "$1"; }
film 60 "$OUT/film-60.mp4"
film 61 "$OUT/film-61.mp4"
for name in with-sub lone ass bare-service bare-byid bare-borrow bare-quiet bare-hi with-sub-low; do
  mkdir -p "$OUT/$name/Film"
  if [ "$name" = bare-hi ]; then cp "$OUT/film-61.mp4" "$OUT/$name/Film/Film.mp4"; else cp "$OUT/film-60.mp4" "$OUT/$name/Film/Film.mp4"; fi
  printf 'fixture %s\n' "$name" >"$OUT/$name/Film/Film.nfo"
done
srt 'Torrent subtitle line one' >"$OUT/with-sub/Film/Film.en.srt"
srt 'Torrent subtitle line one' >"$OUT/with-sub-low/Film/Film.en.srt"
srt 'Lone subtitle line' >"$OUT/lone/Film/Film.srt"
cat >"$OUT/ass/Film/Film.eng.ass" <<'ASS'
[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:30.00,Default,,0,0,0,,ASS subtitle line
ASS
touch "$OUT/.done"
echo "$OUT"
