#!/usr/bin/env bash
# torrent.sh RUN [idle|files|refuse|range|cap|leave|only|disk ...]: the torrent engine's checks
# (torrent-stream-source phase 1) on a `verify.sh up --torrent` run; `torrent.sh RUN off` on a run started
# without --torrent. Every stage drives the real daemon over HTTP against the loopback seeder `up --torrent`
# started (seed.mjs, the fixture of make-fixture.sh); end states are read over HTTP, from the torrent folder,
# the seeder's log, the daemon's log and the daemon's sockets. The first failed check stops it with
# `torrent: FAIL at <stage>`. No stage named: every stage but `off`, in order, once per run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: torrent.sh RUN [idle|files|refuse|range|cap|leave|only|disk|off ...]}
shift
WANTED=("$@")
if [ ${#WANTED[@]} -eq 0 ]; then WANTED=(idle files refuse range cap leave only disk); fi
DIR="$VERIFY_HOME/$RUN"
[ -f "$DIR/port" ] || { echo "torrent: no live run $RUN" >&2; exit 2; }
URL="http://127.0.0.1:$(cat "$DIR/port")"
EV="$DIR/evidence"
T="$DIR/torrent"
ROOT="$DIR/data/movies/torrents"
FIXTURE="$VERIFY_HOME/.torrent-fixture"
STAGE=start
CODE=""
BODY=""
HASH=""

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "torrent $STAGE: $*"; }
pass() { echo "$1 PASS ${*:2}"; "$V" note "$RUN" "torrent $1 PASS ${*:2}"; }
fail() {
  echo "torrent: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "torrent FAIL at $STAGE: $*" || true
  exit 1
}
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
status() { curl -sS "$URL/api/stream/torrent"; }
# The ss lines of every process in the group `up` started (the daemon and its tsx child).
sockets() {
  local pids
  pids="$(ps -o pid= -g "$(cat "$DIR/pid")" | tr -d ' ' | paste -sd'|')"
  ss -tuanpH 2>/dev/null | grep -E "pid=(${pids})," || true
}
udp_sockets() { sockets | awk '$1 == "udp"' | wc -l | tr -d ' '; }
tcp_listening() { sockets | awk '$1 == "tcp" && $2 == "LISTEN" { n = split($5, a, ":"); print a[n] }' | sort -un | paste -sd' '; }

if [ -s "$T/fixture.json" ]; then
  HASH="$(jq -r .info_hash "$T/fixture.json")"
  NAME="$(jq -r .name "$T/fixture.json")"
  idx() { jq -r --arg s "$1" '[.files[] | select(.path | endswith($s))][0].index' "$T/fixture.json"; }
  VIDEO="$(idx "$NAME.mp4")"
  SUB="$(idx "$NAME.en.srt")"
  EXE="$(idx setup.exe)"
  LEN="$(jq -r --argjson i "$VIDEO" '.files[] | select(.index == $i) | .length' "$T/fixture.json")"
  SRC="$FIXTURE/$(jq -r --argjson i "$VIDEO" '.files[] | select(.index == $i) | .path' "$T/fixture.json")"
  OPEN="{\"info_hash\":\"$HASH\",\"name\":\"$NAME\",\"kind\":\"movie\",\"tmdb_id\":550"
fi
need_torrent() {
  [ -n "$HASH" ] || fail "$RUN was not started with --torrent"
  [ "$SUB" != null ] && [ "$EXE" != null ] || fail "the seeded film is not the generated fixture (TORRENT_FIXTURE_FILE?): these stages need its .srt and setup.exe"
}
quiet() { [ "$(udp_sockets)" = 0 ] && [ "$(tcp_listening)" = "$(cat "$DIR/port")" ]; }

stage_off() {
  stage off
  [ ! -d "$T" ] || fail "$RUN was started with --torrent; start one without it for this stage"
  api GET /api/stream/torrent
  [ "$CODE" = 503 ] && [ "$(jq -r .error <<<"$BODY")" = torrent_off ] || fail "GET /api/stream/torrent answered HTTP $CODE: $BODY"
  api POST /api/stream/torrent "{\"info_hash\":\"$(printf 'ab%.0s' $(seq 1 20))\",\"kind\":\"movie\",\"tmdb_id\":550,\"files\":[0]}"
  [ "$CODE" = 503 ] && [ "$(jq -r .error <<<"$BODY")" = torrent_off ] || fail "POST /api/stream/torrent answered HTTP $CODE: $BODY"
  quiet || fail "the daemon holds sockets beyond its HTTP port: $(sockets)"
  pass OFF "torrent_off on GET and POST; no UDP socket; TCP listens on $(tcp_listening) only"
}

stage_idle() {
  stage idle
  need_torrent
  api GET /api/stream/torrent
  [ "$CODE" = 200 ] || fail "GET /api/stream/torrent answered HTTP $CODE: $BODY"
  [ "$(jq -c '[.port, (.swarm | length)]' <<<"$BODY")" = '[null,0]' ] || fail "an engine runs before any torrent was opened: $BODY"
  quiet || fail "sockets before any torrent: $(sockets)"
  ok "torrents on and nothing opened: no engine port, no UDP socket, TCP only on the HTTP port"
}

stage_files() {
  stage files
  need_torrent
  api POST /api/stream/torrent "$OPEN}"
  [ "$CODE" = 200 ] || fail "POST /api/stream/torrent answered HTTP $CODE: $BODY"
  [ "$(jq '.files | length' <<<"$BODY")" = "$(jq '.files | length' "$T/fixture.json")" ] || fail "the file list differs from the seeder's: $BODY"
  [ "$(jq -r --argjson i "$VIDEO" '.files[] | select(.index == $i) | .media' <<<"$BODY")" = video ] || fail "the film is not marked video: $BODY"
  [ "$(jq -r --argjson i "$EXE" '.files[] | select(.index == $i) | .media' <<<"$BODY")" = null ] || fail "setup.exe is marked as media: $BODY"
  [ "$(jq -r '[.torrent.state, (.torrent.in_swarm | tostring), (.from_disk | tostring)] | join(" ")' <<<"$BODY")" = "downloading true false" ] || fail "unexpected view: $BODY"
  sleep 2
  local n
  n="$(find "$ROOT/$HASH" -type f 2>/dev/null | wc -l | tr -d ' ')"
  [ "$n" = 0 ] || fail "$n file(s) under the torrent folder before any file was chosen: $(find "$ROOT/$HASH" -type f)"
  ok "the file list ($(jq '.files | length' <<<"$BODY") files) came from the loopback seeder; nothing is on disk before a choice"
}

stage_refuse() {
  stage refuse
  need_torrent
  api POST /api/stream/torrent "$OPEN,\"files\":[$EXE]}"
  [ "$CODE" = 400 ] && [ "$(jq -r .error <<<"$BODY")" = not_media ] || fail "choosing setup.exe answered HTTP $CODE: $BODY"
  api GET "/api/stream/torrent/$HASH/f/$EXE"
  [ "$CODE" = 404 ] && [ "$(jq -r .error <<<"$BODY")" = not_selected ] || fail "reading setup.exe answered HTTP $CODE: $BODY"
  [ ! -e "$ROOT/$HASH/$NAME/setup.exe" ] || fail "setup.exe is on disk"
  pass REFUSE "setup.exe: 400 not_media to choose, 404 not_selected to read, absent from disk"
}

stage_range() {
  stage range
  need_torrent
  api POST /api/stream/torrent "$OPEN,\"files\":[$VIDEO,$SUB]}"
  [ "$CODE" = 200 ] && [ "$(jq -r .torrent.users <<<"$BODY")" = 1 ] || fail "choosing the film answered HTTP $CODE: $BODY"
  local start end code progress
  start=$((LEN * 9 / 10))
  end=$((start + 65535))
  code="$(curl -sS -D "$EV/torrent-range.head" -o "$EV/torrent-range.body" -w '%{http_code}' -r "$start-$end" "$URL/api/stream/torrent/$HASH/f/$VIDEO")"
  [ "$code" = 206 ] || fail "the range answered HTTP $code"
  grep -qi "^content-range: bytes $start-$end/$LEN" "$EV/torrent-range.head" || fail "content-range: $(grep -i content-range "$EV/torrent-range.head")"
  [ "$(stat -c %s "$EV/torrent-range.body")" = 65536 ] || fail "the body is $(stat -c %s "$EV/torrent-range.body") bytes, not 65536"
  cmp -s -i "$start:0" -n 65536 "$SRC" "$EV/torrent-range.body" || fail "the bytes differ from the film's bytes $start-$end"
  api GET "/api/stream/torrent/$HASH"
  progress="$(jq -r .progress <<<"$BODY")"
  awk -v p="$progress" 'BEGIN { exit !(p < 0.5) }' || fail "progress was $progress when the range at 90% came back: it was not fetched first"
  api GET "/api/stream/torrent/$HASH/map"
  jq -e --argjson s "$start" --argjson e "$((end + 1))" 'any(.byte_ranges[]; .[0] <= $s and .[1] >= $e)' <<<"$BODY" >/dev/null || fail "the map does not hold the range: $BODY"
  pass RANGE "206 with exactly bytes $start-$end of $LEN while $progress of the film was on disk"
}

wait_ready() {
  local view state
  for _ in $(seq 1 240); do
    view="$(curl -sS "$URL/api/stream/torrent/$HASH")"
    state="$(jq -r .state <<<"$view")"
    [ "$state" = ready ] && return 0
    [ "$state" = failed ] && fail "the download failed: $view"
    sleep 0.5
  done
  fail "the download was not ready in 120 s (last: $view)"
}

stage_cap() {
  stage cap
  need_torrent
  wait_ready
  api GET /api/stream/torrent
  local port cap limit out
  port="$(jq -r .port <<<"$BODY")"
  cap="$(jq -r .upload_cap_bytes_per_s <<<"$BODY")"
  [[ $port =~ ^[0-9]+$ ]] || fail "no engine port while the film is held: $BODY"
  out="$(node "$HERE/seed.mjs" leech --info-hash "$HASH" --peer "127.0.0.1:$port" --file "$VIDEO" --bytes 524288 --out "$T/leech" --timeout-s 90)" || fail "the test peer could not download from the daemon: $out"
  echo "$out" >"$EV/torrent-cap.json"
  limit=$((cap * 5 / 4))
  [ "$(jq -c .peers <<<"$out")" = "[\"127.0.0.1:$port\"]" ] || fail "the test peer had other peers than the daemon: $out"
  [ "$(jq -r .bytes_per_s <<<"$out")" -le "$limit" ] || fail "the daemon uploaded at $(jq -r .bytes_per_s <<<"$out") B/s, over $limit (the cap $cap B/s + 25%)"
  pass CAP "a peer of the daemon got 512 KiB at $(jq -r .bytes_per_s <<<"$out") B/s under a cap of $cap B/s"
}

stage_leave() {
  stage leave
  need_torrent
  api POST "/api/stream/torrent/$HASH/release"
  [ "$CODE" = 200 ] && [ "$(jq -r .released <<<"$BODY")" = true ] || fail "release answered HTTP $CODE: $BODY"
  local s="" peers=""
  for _ in $(seq 1 40); do
    s="$(status)"
    [ "$(jq -c '[.port, (.swarm | length)]' <<<"$s")" = '[null,0]' ] && break
    sleep 0.25
  done
  [ "$(jq -c '[.port, (.swarm | length)]' <<<"$s")" = '[null,0]' ] || fail "still in the swarm 10 s after release: $s"
  api GET /api/stream/torrent
  for _ in $(seq 1 20); do
    peers="$(tail -1 "$T/seeder.jsonl" | jq -r --arg h "$HASH" '.torrents[] | select(.info_hash == $h) | .peers')"
    [ "$peers" = 0 ] && break
    sleep 0.5
  done
  [ "$peers" = 0 ] || fail "the seeder still has $peers peer(s) on the film"
  grep -q "left the swarm of $NAME" "$DIR/daemon.log" || fail "the daemon log has no 'left the swarm of $NAME' line"
  quiet || fail "sockets left after leaving: $(sockets)"
  pass LEAVE "released a finished film: no swarm, no engine port, the seeder has 0 peers on it, no torrent socket left"
}

stage_only() {
  stage only
  need_torrent
  local listing want
  listing="$(cd "$ROOT/$HASH" && find . -type f | sed 's#^\./##' | sort | paste -sd'|')"
  want="$(printf '%s\n' "$NAME/$NAME.en.srt" "$NAME/$NAME.mp4" | sort | paste -sd'|')"
  [ "$listing" = "$want" ] || fail "the torrent folder holds [$listing], not only [$want]"
  cmp -s "$SRC" "$ROOT/$HASH/$NAME/$NAME.mp4" || fail "the film on disk differs from the seeder's"
  pass ONLY "the torrent folder holds only the film and its subtitle, byte for byte the seeder's"
}

stage_disk() {
  stage disk
  need_torrent
  local pid joined code
  pid="$(cat "$DIR/seeder.pid")"
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  if kill -0 "$pid" 2>/dev/null; then fail "the seeder did not stop"; fi
  joined="$(grep -c "joined the swarm of $NAME" "$DIR/daemon.log" || true)"
  api POST /api/stream/torrent "$OPEN,\"files\":[$VIDEO,$SUB]}"
  [ "$CODE" = 200 ] && [ "$(jq -r .from_disk <<<"$BODY")" = true ] && [ "$(jq '.files | length' <<<"$BODY")" = 2 ] || fail "opening the finished film answered HTTP $CODE: $BODY"
  code="$(curl -sS -o "$EV/torrent-disk.body" -w '%{http_code}' -r 0-1023 "$URL/api/stream/torrent/$HASH/f/$VIDEO")"
  [ "$code" = 206 ] && cmp -s -n 1024 "$SRC" "$EV/torrent-disk.body" || fail "the first KiB from disk answered HTTP $code or differs"
  api GET /api/stream/torrent
  [ "$(jq -c '[.port, (.swarm | length)]' <<<"$BODY")" = '[null,0]' ] || fail "playing from disk joined a swarm: $BODY"
  [ "$(grep -c "joined the swarm of $NAME" "$DIR/daemon.log" || true)" = "$joined" ] || fail "the daemon joined the swarm again"
  quiet || fail "sockets while playing from disk: $(sockets)"
  api POST "/api/stream/torrent/$HASH/release"
  pass DISK "with the seeder gone the finished film opens from disk (from_disk true) and serves exact bytes; no swarm joined, no torrent socket"
}

for s in "${WANTED[@]}"; do
  case "$s" in
    off | idle | files | refuse | range | cap | leave | only | disk) "stage_$s" ;;
    *) fail "unknown stage $s" ;;
  esac
done
echo "torrent: PASS (${WANTED[*]})"
