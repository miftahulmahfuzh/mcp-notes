#!/usr/bin/env bash
# Two small films for the embedded-subtitle journeys (torrent-stream-source phase 7), both H.264/AAC
# MP4 with the index in front, so Chrome plays them as they are (no remux needed):
#   <out>/sub-text.mp4    an English mov_text track: cue N is "Line N", from 3N-2 s to 3N s (N = 1..20)
#   <out>/sub-picture.mp4 an English dvd_subtitle (VobSub) track only: pictures, no text
# Usage: make-torrent-sub-fixtures.sh OUT_DIR. Prints OUT_DIR. Needs ffmpeg and python3. Idempotent.
set -euo pipefail
OUT=${1:?usage: make-torrent-sub-fixtures.sh OUT_DIR}
mkdir -p "$OUT"
if [[ -s "$OUT/sub-text.mp4" && -s "$OUT/sub-picture.mp4" ]]; then echo "$OUT"; exit 0; fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'PY'
import struct, sys
tmp = sys.argv[1]
def stamp(t): return "00:%02d:%02d,000" % (t // 60, t % 60)
with open(f"{tmp}/en.srt", "w") as f:
    f.write("\n".join(f"{n}\n{stamp(3*n-2)} --> {stamp(3*n)}\nLine {n}\n" for n in range(1, 21)))
# A PGS (.sup) file by hand: every 6 s a 100x20 white box for 3 s. ffmpeg turns it into VobSub below.
def seg(pts, typ, data): return b"PG" + struct.pack(">IIBH", pts, 0, typ, len(data)) + data
W, H, w, h = 320, 240, 100, 20
out = b""
for i, t in enumerate(range(1, 60, 6)):
    pts = t * 90000
    pcs = struct.pack(">HHBHBBBB", W, H, 0x10, 2 * i, 0x80, 0, 0, 1) + struct.pack(">HBBHH", 0, 0, 0, 110, 200)
    wds = struct.pack(">BBHHHH", 1, 0, 110, 200, w, h)
    pds = struct.pack(">BB", 0, 0) + bytes([0, 16, 128, 128, 0, 1, 235, 128, 128, 255])
    rle = bytes([0x00, 0xC0 | (w >> 8), w & 0xFF, 1, 0x00, 0x00]) * h
    ods = struct.pack(">HBB", 0, 0, 0xC0) + (len(rle) + 4).to_bytes(3, "big") + struct.pack(">HH", w, h) + rle
    out += seg(pts, 0x16, pcs) + seg(pts, 0x17, wds) + seg(pts, 0x14, pds) + seg(pts, 0x15, ods) + seg(pts, 0x80, b"")
    end = pts + 3 * 90000
    out += seg(end, 0x16, struct.pack(">HHBHBBBB", W, H, 0x10, 2 * i + 1, 0x00, 0, 0, 0)) + seg(end, 0x17, wds) + seg(end, 0x80, b"")
open(f"{tmp}/pic.sup", "wb").write(out)
PY
ffmpeg -v error -y -f lavfi -i testsrc=size=320x240:rate=25:duration=60 -f lavfi -i sine=duration=60 \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac "$TMP/av.mp4"
ffmpeg -v error -y -i "$TMP/av.mp4" -i "$TMP/en.srt" -map 0:v -map 0:a -map 1:0 -c:v copy -c:a copy -c:s mov_text \
  -metadata:s:s:0 language=eng -movflags +faststart "$OUT/sub-text.mp4"
ffmpeg -v error -y -i "$TMP/av.mp4" -fix_sub_duration -i "$TMP/pic.sup" -map 0:v -map 0:a -map 1:0 -c:v copy -c:a copy -c:s dvdsub \
  -metadata:s:s:0 language=eng -movflags +faststart "$OUT/sub-picture.mp4"
echo "$OUT"
