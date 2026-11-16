#!/usr/bin/env bash
# offer-remux.sh RUN: hands torrent phase 5's MKV fixture (make-mkv-fixture.sh) to a `verify.sh up --torrent` run:
# moves a copy into phase 1's seed folder (<run>/torrent/seed/remux/), waits for <run>/torrent/seeded/remux.json, and
# makes it the fake index's only answer (<run>/torrent/candidates.json, release tail 360p.BluRay.x264.AC3-NOTESD).
# Prints the info hash. Idempotent per run.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: offer-remux.sh RUN}
TOR="$VERIFY_HOME/$RUN/torrent"
[ -s "$TOR/fixture.json" ] || { echo "offer-remux: $RUN was not started with --torrent" >&2; exit 2; }
FIX="$(bash "$HERE/../stream/make-mkv-fixture.sh" "$VERIFY_HOME/.stream-fixture-mkv")"
if [ ! -s "$TOR/seeded/remux.json" ]; then
  rm -rf "$TOR/seed/.remux"
  mkdir -p "$TOR/seed/.remux"
  cp "$FIX"/*.mkv "$TOR/seed/.remux/"
  mv "$TOR/seed/.remux" "$TOR/seed/remux"
  for _ in $(seq 1 80); do [ -s "$TOR/seeded/remux.json" ] && break; sleep 0.25; done
  [ -s "$TOR/seeded/remux.json" ] || { echo "offer-remux: the seeder did not seed the MKV (log: $TOR/seeder.out)" >&2; exit 1; }
fi
jq -c '[{info_hash, name: "360p.BluRay.x264.AC3-NOTESD", seeds: 25, size_bytes: ([.files[].length] | add)}]' "$TOR/seeded/remux.json" >"$TOR/candidates.json"
jq -r .info_hash "$TOR/seeded/remux.json"
