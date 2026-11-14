#!/usr/bin/env bash
# make-fixtures.sh DEST: build the movie library `verify.sh up --movies` copies into every run.
# Idempotent: DEST/.complete-v1 marks a finished build; anything else in DEST is rebuilt.
# Bump the stamp name when the layout changes, so cached copies are rebuilt.
set -euo pipefail
DEST=${1:?usage: make-fixtures.sh DEST}
STAMP="$DEST/.complete-v1"
[ -f "$STAMP" ] && exit 0
command -v ffmpeg >/dev/null || { echo "make-fixtures: ffmpeg is not on PATH" >&2; exit 1; }
command -v ffprobe >/dev/null || { echo "make-fixtures: ffprobe is not on PATH" >&2; exit 1; }
rm -rf "$DEST"
mkdir -p "$DEST"

LONG=960   # 16 min: over NOTESD_MOVIES_MIN_SECONDS (900); fake-vlc.mjs reports the same length
SHORT=20   # a WhatsApp-style clip: under the minimum, so it never reaches TMDB

video() { # video PATH SECONDS: a black 32x18, 1 fps MPEG-4 video (a few KB)
  mkdir -p "$(dirname "$1")"
  ffmpeg -hide_banner -loglevel error -nostdin -y -f lavfi -i "color=c=0x1d2630:s=32x18:r=1" \
    -t "$2" -c:v mpeg4 -q:v 31 -an "$1"
}

V="$DEST/library/Videos"
T="$DEST/library/Telegram Desktop"
S="$V/Mobland S01 WEB-DL 1080p x265 6CH [Pahe.in]"
video "$V/How.to.Make.a.Killing.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv" "$LONG"
video "$S/MobLand.S01E01.Stick.or.Twist.1080p.WEB-DL.x265.6CH-Pahe.in.mkv" "$LONG"
video "$S/MobLand.S01E02.Eye.for.an.Eye.1080p.WEB-DL.x265.6CH-Pahe.in.mkv" "$LONG"
video "$S/MobLand.S01E03.Lie.Down.with.Dogs.1080p.WEB-DL.x265.6CH-Pahe.in.mkv" "$LONG"
video "$V/Done/The_Rivals_of_Amziah_King_2026_1080p_BluRay_x265_DD+5_1_Pahe_in.mkv" "$LONG"
video "$V/Done/docker_es/WhatsApp Video 2026-10-01 at 21.14.03.mp4" "$SHORT"
video "$T/Oldboy (2003)/Oldboy.mkv" "$LONG"

got="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$T/Oldboy (2003)/Oldboy.mkv")"
awk -v d="$got" 'BEGIN { exit !(d + 0 >= 955 && d + 0 <= 965) }' || {
  echo "make-fixtures: ffprobe reads ${got}s for a ${LONG}s fixture" >&2
  exit 1
}
touch "$STAMP"
