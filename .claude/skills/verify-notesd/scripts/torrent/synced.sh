#!/usr/bin/env bash
# synced.sh RUN [torrent|cloud|english ...]: WYZIE_SYNCED_BRIEF's checks, on a run started with
#   NOTESD_TORRENT_WHISPER=off NOTESD_TORRENT_WHISPER_PYTHON=$PWD/tests/fixtures/torrent/fake-vad.mjs \
#     verify.sh up --web --torrent
# (the fake speech detector stands in for Whisper's Python; ffmpeg, the cuts and the page are real).
#   torrent  a torrent session whose subtitle came from the fake Wyzie Subs is re-timed by the fake Wyzie Synced
#            behind the play: the open page takes the synced file, a replay plays it and asks nothing
#   cloud    a cloud stream with no subtitle gets the fake Wyzie's file as a local subtitle, kept per title; its
#            audio is cut from the fixture stream host with the captured headers, and the page takes the synced file
#   english  a cloud stream with an English subtitle asks no service
# The first failed check stops it with `synced: FAIL at <stage>`. No stage named: all three.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: synced.sh RUN [torrent|cloud|english ...]}
shift
WANTED=("$@")
if [ ${#WANTED[@]} -eq 0 ]; then WANTED=(torrent cloud english); fi
DIR="$VERIFY_HOME/$RUN"
TORRENT="$DIR/torrent"
SUBS="$TORRENT/subs"
DIRECT="$DIR/direct"
[ -s "$SUBS/info.json" ] || { echo "synced: $RUN was not started with --torrent" >&2; exit 2; }
URL="http://127.0.0.1:$(cat "$DIR/port")"
EV="$DIR/evidence"
DATA="$DIR/data/movies"
STAGE=start
CODE=""
BODY=""
SID=""

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "synced $STAGE: $*"; }
fail() {
  echo "synced: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "synced FAIL at $STAGE: $*" || true
  exit 1
}
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
play() {
  api POST /api/stream/play "$1"
  [ "$CODE" = 200 ] || fail "POST /api/stream/play $1 answered HTTP $CODE: $BODY"
  SID="$(jq -r .session.session_id <<<"$BODY")"
  printf '%s\n' "$BODY" >"$EV/synced-play-$STAGE.json"
}
session() {
  api GET "/api/stream/sessions/$SID"
  [ "$CODE" = 200 ] || fail "GET the session answered HTTP $CODE"
  BODY="$(jq -c '{session: .}' <<<"$BODY")"
}
sub() { jq -r ".session.subtitles[0].$1 // \"\"" <<<"$BODY"; }
rev() { jq -r .session.subtitle_rev <<<"$BODY"; }
wyzie_lines() { if [ -f "$SUBS/wyzie-requests.jsonl" ]; then wc -l <"$SUBS/wyzie-requests.jsonl" | tr -d ' '; else echo 0; fi; }
syncs() { if [ -f "$SUBS/wyzie-requests.jsonl" ]; then grep -c '"path":"/sync"' "$SUBS/wyzie-requests.jsonl" || true; else echo 0; fi; }
last_sync() { grep '"path":"/sync"' "$SUBS/wyzie-requests.jsonl" | tail -1; }
wait_sync() { # wait_sync COUNT: until the fake Wyzie Synced was asked COUNT times
  for _ in $(seq 1 480); do [ "$(syncs)" -ge "$1" ] && return 0; sleep 0.25; done
  fail "Wyzie Synced was not asked within 120 s (daemon log: $(grep 'torrent sync' "$DIR/daemon.log" | tail -3))"
}
no_secret() { # no_secret WHAT PATH...
  local what=$1
  shift
  ! grep -rq 'verify-fake-wyzie-key\|fake-wyzie-token' "$@" || fail "the Wyzie key or a download token is in $what"
}
page() {
  SESSION_ID="$SID" SYNC_GO="$SUBS/sync-go" "$V" ui "$RUN" "$HERE/../stream/subtitles-synced.steps.mjs" >"$EV/synced-page-$STAGE.txt" 2>&1 \
    || fail "the player page did not take the synced subtitle (see $EV/synced-page-$STAGE.txt)"
  ok "$(grep 'SYNCED PAGE PASS' "$EV/synced-page-$STAGE.txt" | sed 's/^SYNCED PAGE PASS: //')"
}
check_request() { # check_request COVERED_S: the last /sync request
  local req
  req="$(last_sync)"
  [ "$(jq -r '[(.has_key | tostring), .language] | join(" ")' <<<"$req")" = "true en" ] || fail "the sync request is [$req]"
  # To the second: an HLS stream's audio runs a few hundredths past its nominal length.
  [ "$(jq -c '.covered | map(map(round))' <<<"$req")" = "[[0,$1]]" ] || fail "the sync request covers $(jq -c .covered <<<"$req"), not [[0,$1]]"
  [ "$(jq -r .speech_s <<<"$req")" -ge 120 ] && [ "$(jq -r .spans <<<"$req")" -ge 10 ] || fail "the sync request carries too little speech: [$req]"
  ! grep -q 'verify-fake-wyzie-key' "$SUBS/wyzie-requests.jsonl" || fail "the fake service logged the key"
}

stage_torrent() {
  stage torrent
  local fix hash before
  fix="$VERIFY_HOME/.torrent-sync-fixture"
  if [ ! -f "$fix/.done" ]; then
    mkdir -p "$fix/bare-sync/Film"
    # A small file (about 2 MB): the loopback seeder uploads at 200 kB/s, and the cut waits for the whole film.
    ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=320x180:rate=12" -f lavfi -i "sine=frequency=440:sample_rate=48000" \
      -t 150 -c:v libx264 -preset veryfast -crf 36 -pix_fmt yuv420p -c:a aac -b:a 48k -movflags +faststart "$fix/bare-sync/Film/Film.mp4"
    printf 'fixture bare-sync\n' >"$fix/bare-sync/Film/Film.nfo"
    touch "$fix/.done"
  fi
  mkdir -p "$TORRENT/seed"
  [ -d "$TORRENT/seed/bare-sync" ] || { rm -rf "$TORRENT/seed/.bare-sync"; cp -r "$fix/bare-sync" "$TORRENT/seed/.bare-sync"; mv "$TORRENT/seed/.bare-sync" "$TORRENT/seed/bare-sync"; }
  for _ in $(seq 1 120); do [ -s "$TORRENT/seeded/bare-sync.json" ] && break; sleep 0.25; done
  [ -s "$TORRENT/seeded/bare-sync.json" ] || fail "the loopback seeder did not seed bare-sync"
  hash="$(jq -r .info_hash "$TORRENT/seeded/bare-sync.json")"
  jq -nc --arg h "$hash" '[{info_hash: $h, name: "Bad.Apples.2026.1080p.WEB.x264-bare-sync", seeds: 500, size_bytes: 1500000}]' >"$TORRENT/candidates.json"
  printf 'sync\n' >"$SUBS/mode"
  rm -f "$SUBS/sync-go" "$SUBS/sync-refuse"
  before="$(syncs)"
  play '{"kind":"movie","tmdb_id":990003,"provider":"torrent"}'
  [ "$(sub url)" = "/api/stream/torrent/$hash/sub/service-wyzie-7001.vtt" ] || fail "the subtitle is [$(sub url)], not Wyzie's file"
  [ "$(rev)" = 0 ] || fail "subtitle_rev is [$(rev)] at the start"
  ok "the play answered at once with Wyzie's unsynced file (subtitle_rev 0)"
  wait_sync "$((before + 1))"
  check_request 150
  ok "behind the play: ffmpeg cut the film's 150 s of audio, the speech detector found $(jq -r .spans <<<"$(last_sync)") stretches ($(jq -r .speech_s <<<"$(last_sync)") s), and Wyzie Synced was asked with covered [[0,150]]"
  page
  session
  [ "$(sub url)" = "/api/stream/torrent/$hash/sub/synced-0.vtt" ] || fail "the session's subtitle is [$(sub url)] after the sync"
  [ "$(sub label) $(rev)" = 'English (Wyzie, synced) 1' ] || fail "label and revision are [$(sub label) $(rev)]"
  curl -sS "$URL$(sub url)" >"$EV/synced-torrent.vtt"
  grep -q 'Synced subtitle line' "$EV/synced-torrent.vtt" || fail "the served file is not the synced one"
  cp "$DATA/torrents/$hash/.notesd-subs/synced-0.json" "$EV/synced-torrent-outcome.json"
  [ "$(jq -r '[.state, (.offset_s | tostring), (.covered_s | tostring)] | join(" ")' "$EV/synced-torrent-outcome.json")" = "done -0.9 150" ] || fail "the outcome is $(cat "$EV/synced-torrent-outcome.json")"
  grep -q '"synced-0.vtt"' "$DATA/torrents/$hash/.notesd-subs/chosen.json" || fail "chosen.json does not name the synced file"
  no_secret "the daemon log, the play answer or the torrent folder" "$DIR/daemon.log" "$EV/synced-play-torrent.json" "$DATA/torrents/$hash/.notesd-subs"
  [ -z "$(find "$DATA/torrents/$hash" -name '*.wav')" ] || fail "a WAV was left in the torrent folder"
  ok "the session now answers synced-0.vtt (subtitle_rev 1), the outcome is kept (done, offset -0.9 s), no key or token anywhere"
  before="$(syncs)"
  play '{"kind":"movie","tmdb_id":990003,"provider":"torrent"}'
  [ "$(jq -r '[.attempts[] | select(.provider == "Subtitles: kept") | .outcome] | join(",")' <<<"$BODY")" = resolved ] || fail "the replay did not answer the kept subtitle"
  [ "$(sub url)" = "/api/stream/torrent/$hash/sub/synced-0.vtt" ] || fail "the replay's subtitle is [$(sub url)]"
  sleep 3
  [ "$(syncs)" = "$before" ] || fail "the replay asked Wyzie Synced again"
  ok "a replay plays the synced file through the kept tier and Wyzie Synced is not asked again"
}

stage_cloud() {
  stage cloud
  local film before wbefore
  film="$(bash "$HERE/../stream/make-hls-film.sh" "$VERIFY_HOME/.hls-film")"
  mkdir -p "$DIRECT/film"
  cp -r "$film/." "$DIRECT/film/"
  printf 'hls_film\n' >"$DIRECT/mode"
  touch "$DIRECT/no_subtitle"
  printf 'sync\n' >"$SUBS/mode"
  rm -f "$SUBS/sync-go" "$SUBS/sync-refuse"
  before="$(syncs)"
  play '{"kind":"movie","tmdb_id":990001}'
  [ "$(jq -r '.session.torrent // "none"' <<<"$BODY")" = none ] && [ "$(jq -r .session.provider <<<"$BODY")" != Torrent ] || fail "the play is not a cloud session: $(jq -c '{provider: .session.provider, torrent: .session.torrent}' <<<"$BODY")"
  [ "$(jq -c '.session.subtitles | map([.url, .label, .english])' <<<"$BODY")" = '[["/api/stream/subs/movie-990001/outside.vtt","English (Wyzie)",true]]' ] || fail "the session's subtitles are $(jq -c .session.subtitles <<<"$BODY")"
  curl -sS "$URL/api/stream/subs/movie-990001/outside.vtt" | grep -q 'Wyzie subtitle line' || fail "the title's subtitle route does not serve Wyzie's file"
  [ "$(curl -sS -o /dev/null -w '%{http_code}' "$URL/api/stream/subs/movie-990001/chosen.json")" = 404 ] || fail "the route served chosen.json"
  ok "a stream with no subtitle ($(jq -r .session.provider <<<"$BODY")) plays with the fake Wyzie's file as a local subtitle, kept under movies/stream-subs/movie-990001"
  wait_sync "$((before + 1))"
  check_request 300
  # No page is open yet: every request the fixture host saw for the film's segments is ffmpeg's, with the captured headers.
  grep '/film/t[0-9]*/seg' "$DIRECT/upstream.jsonl" | grep -q '"referer":"https://embed.fixture/".*"status":20' || fail "the fixture stream host saw no request from ffmpeg for the film's segments"
  ok "behind the play: ffmpeg cut the stream's 300 s of audio from the fixture host (which answers 403 without the captured Referer) and Wyzie Synced was asked with covered [[0,300]]"
  page
  session
  [ "$(jq -c '.session.subtitles | map([.url, .label])' <<<"$BODY") $(rev)" = '[["/api/stream/subs/movie-990001/synced.vtt","English (Wyzie, synced)"]] 1' ] || fail "after the sync the session answers $(jq -c '[.session.subtitles, .session.subtitle_rev]' <<<"$BODY")"
  cp "$DATA/stream-subs/movie-990001/synced.json" "$EV/synced-cloud-outcome.json"
  [ "$(jq -r .state "$EV/synced-cloud-outcome.json")" = done ] || fail "the outcome is $(cat "$EV/synced-cloud-outcome.json")"
  no_secret "the daemon log, the play answer or the title's folder" "$DIR/daemon.log" "$EV/synced-play-cloud.json" "$DATA/stream-subs"
  ok "the session now answers synced.vtt (subtitle_rev 1); the outcome is kept; no key or token anywhere"
  before="$(syncs)"
  wbefore="$(wyzie_lines)"
  play '{"kind":"movie","tmdb_id":990001}'
  [ "$(sub url)" = /api/stream/subs/movie-990001/synced.vtt ] || fail "the second play's subtitle is [$(sub url)]"
  sleep 3
  [ "$(wyzie_lines)" = "$wbefore" ] && [ "$(syncs)" = "$before" ] || fail "the second play of the title asked a subtitle service"
  ok "a second play of the title uses the kept synced file and asks nothing"
  rm -f "$DIRECT/no_subtitle"
}

stage_english() {
  stage english
  local wbefore
  rm -f "$DIRECT/no_subtitle"
  printf 'hls\n' >"$DIRECT/mode"
  printf 'sync\n' >"$SUBS/mode"
  wbefore="$(wyzie_lines)"
  play '{"kind":"movie","tmdb_id":990002}'
  [ "$(jq -c '.session.subtitles | map(.label)' <<<"$BODY")" = '["English"]' ] || fail "the session's subtitles are $(jq -c .session.subtitles <<<"$BODY")"
  sleep 3
  [ "$(wyzie_lines)" = "$wbefore" ] || fail "a subtitle service was asked although the stream has an English subtitle"
  [ ! -e "$DATA/stream-subs/movie-990002" ] || fail "a file was kept for a title whose stream has an English subtitle"
  ok "a stream with its own English subtitle is left as it is: no service asked, nothing kept, no sync"
}

for s in "${WANTED[@]}"; do
  case "$s" in
    torrent) stage_torrent ;;
    cloud) stage_cloud ;;
    english) stage_english ;;
    *) echo "synced: unknown stage $s" >&2; exit 2 ;;
  esac
done
echo "synced: PASS (${WANTED[*]})"
"$V" note "$RUN" "synced PASS (${WANTED[*]})"
