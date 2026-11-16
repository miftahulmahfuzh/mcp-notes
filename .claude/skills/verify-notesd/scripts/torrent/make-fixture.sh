#!/usr/bin/env bash
# make-fixture.sh DEST: the torrents `verify.sh up --torrent` seeds on loopback (torrent-stream-source phase 1).
#   DEST/Fixture.Film.2026.1080p.WEB-DL.x264-NOTESD/   a 120 s H.264/AAC MP4 (faststart, audio tagged eng),
#       its .en.srt, README.txt, Sample/sample.mp4 (5 s) and setup.exe (inert text: a file notesd must
#       never fetch or run, only its name says "program")
#   DEST/Fixture.Show.S01.1080p.WEB-DL.x264-NOTESD/    a season pack: S01E01 and S01E02, 20 s each
# Idempotent: DEST/.complete-v1 marks a finished build. Prints DEST.
set -euo pipefail
DEST=${1:?usage: make-fixture.sh DEST}
STAMP="$DEST/.complete-v1"
if [ -f "$STAMP" ]; then
  echo "$DEST"
  exit 0
fi
command -v ffmpeg >/dev/null || { echo "make-fixture: ffmpeg is not on PATH" >&2; exit 1; }
rm -rf "$DEST"
FILM=Fixture.Film.2026.1080p.WEB-DL.x264-NOTESD
SHOW=Fixture.Show.S01.1080p.WEB-DL.x264-NOTESD
mkdir -p "$DEST/$FILM/Sample" "$DEST/$SHOW"

clip() { # clip PATH SECONDS HZ: H.264 + AAC (English), fast start, so Chrome plays it as is
  ffmpeg -hide_banner -loglevel error -nostdin -y \
    -f lavfi -i "testsrc2=size=640x360:rate=25" -f lavfi -i "sine=frequency=$3:sample_rate=48000" \
    -t "$2" -c:v libx264 -preset veryfast -pix_fmt yuv420p -b:v 400k -g 50 \
    -c:a aac -b:a 64k -metadata:s:a:0 language=eng -movflags +faststart "$1"
}

clip "$DEST/$FILM/$FILM.mp4" 120 440
clip "$DEST/$FILM/Sample/sample.mp4" 5 660
cat >"$DEST/$FILM/$FILM.en.srt" <<'EOF'
1
00:00:01,000 --> 00:00:04,000
A torrent fixture, made by notesd's verify harness.

2
00:00:05,000 --> 00:00:08,000
Every byte of it came over loopback.
EOF
printf 'notesd verify fixture: a torrent may carry files like this one. notesd never downloads them.\n' >"$DEST/$FILM/README.txt"
head -c 1048576 < <(yes 'notesd fixture: never fetched, never run') >"$DEST/$FILM/setup.exe"
clip "$DEST/$SHOW/Fixture.Show.S01E01.1080p.WEB-DL.x264-NOTESD.mp4" 20 523
clip "$DEST/$SHOW/Fixture.Show.S01E02.1080p.WEB-DL.x264-NOTESD.mp4" 20 587
touch "$STAMP"
echo "$DEST"
