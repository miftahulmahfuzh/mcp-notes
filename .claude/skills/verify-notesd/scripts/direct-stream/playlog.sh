#!/usr/bin/env bash
# playlog.sh RUN [ask|stats|failed|beat|replaced|restart ...]: the play log (stream_play_log, src/directStream/playLog/)
# on a `verify.sh up --direct-stream` run (without --torrent). Every stage drives the real daemon over HTTP as the
# player page does (the fake resolver answers; nothing of the owner's is reached) and reads the row back from the
# run's database, read-only. No stage named: all six, in order. Each stage that passes prints `PASS <stage>`; the
# first failed check stops it with `playlog: FAIL at <stage>`. `beat` takes about 45 s; `restart` restarts the daemon.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: playlog.sh RUN [ask|stats|failed|beat|replaced|restart ...]}
shift
WANTED=("$@")
if [ ${#WANTED[@]} -eq 0 ]; then WANTED=(ask stats failed beat replaced restart); fi
DIR="$VERIFY_HOME/$RUN"
DIRECT="$DIR/direct"
[ -s "$DIRECT/upstream.json" ] || { echo "playlog: $RUN was not started with --direct-stream" >&2; exit 2; }
DB="$(cat "$DIR/db")"
URL="http://127.0.0.1:$(cat "$DIR/port")"
STAGE=start
SID=""
PROVIDER=""
# A film the run's fake TMDB serves (scripts/movies/tmdb.json): a title it does not know answers a position report
# 404 unknown_title, and its page never becomes the stream on screen (so no beat is quiet and nothing is replaced).
FILM=467905

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "play log $STAGE: $*"; }
pass() { echo "PASS $STAGE"; }
fail() {
  echo "playlog: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "play log FAIL at $STAGE: $*" || true
  exit 1
}
q() {
  printf 'begin read only;\n%s;\nrollback;\n' "$1" \
    | docker exec -i mcp-notes-pg-verify psql -X -q -tA -v ON_ERROR_STOP=1 -U postgres -d "$DB" \
    | sed '/^BEGIN$/d;/^ROLLBACK$/d'
}
post() { curl -sS -X POST -H 'content-type: application/json' -H "Origin: $URL" -d "$2" "$URL$1"; }
status() { curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "Origin: $URL" -d "$2" "$URL$1"; }
# until_row SQL WANT: the query reads WANT within 10 s (the log writes behind the answer), else FAIL.
until_row() {
  local got="" i
  for i in $(seq 1 20); do
    got="$(q "$1")"
    [ "$got" = "$2" ] && return 0
    sleep 0.5
  done
  fail "wanted [$2], read [$got] from: $1"
}
# play: film $FILM through the fake resolver; sets SID and PROVIDER.
play() {
  local body
  printf 'hls\n' >"$DIRECT/mode"
  rm -f "$DIRECT/no_subtitle"
  body="$(post /api/stream/play "{\"kind\":\"movie\",\"tmdb_id\":$FILM}")"
  SID="$(jq -r '.session.session_id // empty' <<<"$body")"
  PROVIDER="$(jq -r '.session.provider // empty' <<<"$body")"
  [ -n "$SID" ] || fail "the film did not play: $body"
}
report() { status "/api/stream/sessions/$SID/position" "$1"; }
row() { echo "select $1 from stream_play_log where session = '$SID'"; }

stage_ask() {
  stage ask
  play
  until_row "$(row "via||'|'||kind||'|'||tmdb_id||'|'||coalesce(asked,'-')||'|'||outcome||'|'||channel||'|'||provider_first||'|'||(resolve_ms >= 0)::text||'|'||coalesce(ended,'-')")" "play|movie|$FILM|-|no_picture|cloud|$PROVIDER|true|-"
  ok "the answered ask is one row: play, film $FILM, no source named, no_picture, cloud, $PROVIDER, its time to answer"
  pass
}

stage_stats() {
  stage stats
  play
  [ "$(report '{"position_s":10,"duration_s":600,"paused":false,"stats":{"load":"loadAAAA1","first_frame_ms":1200,"played_ms":10000,"stalls":1,"stalled_ms":2000,"waits":0,"waited_ms":0,"errors":0}}')" = 200 ] || fail "the first report was refused"
  until_row "$(row "outcome||'|'||first_frame_ms||'|'||played_ms||'|'||stalls")" "played|1200|10000|1"
  ok "the first report turned the row to played with the page's counters"
  # The page reloads (a new load id, counting from zero) and closes.
  [ "$(report '{"position_s":20,"duration_s":600,"closed":true,"stats":{"load":"loadBBBB2","first_frame_ms":900,"played_ms":5000,"stalls":2,"stalled_ms":3000,"waits":1,"waited_ms":4000,"errors":1}}')" = 200 ] || fail "the closing report was refused"
  until_row "$(row "first_frame_ms||'|'||played_ms||'|'||stalls||'|'||stalled_ms||'|'||waits||'|'||waited_ms||'|'||errors||'|'||ended||'|'||provider_last||'|'||auto_switches||'|'||owner_switches||'|'||coalesce(subtitle_source,'-')||'|'||(ended_at is not null)::text")" "1200|15000|3|5000|1|4000|1|closed|$PROVIDER|0|0|stream|true"
  ok "two page loads summed, the first frame of the first load kept, closed on $PROVIDER with the stream's English subtitle"
  pass
}

stage_failed() {
  stage failed
  printf 'no_source\n' >"$DIRECT/mode"
  [ "$(status /api/stream/play "{\"kind\":\"movie\",\"tmdb_id\":$FILM,\"provider\":\"cloud\"}")" = 502 ] || fail "a cloud play with no source did not answer 502"
  until_row "select outcome||'|'||failure||'|'||coalesce(cloud_failure,'-')||'|'||coalesce(torrent_failure,'-')||'|'||coalesce(asked,'-')||'|'||(session is null)::text||'|'||(failure_detail is not null)::text from stream_play_log where id = (select max(id) from stream_play_log)" "failed|no_source|no_stream|-|cloud|true|true"
  ok "a cloud ask that found nothing: failed, no_source, the cloud said no_stream, the torrents were not asked"
  printf 'no_chrome\n' >"$DIRECT/mode"
  [ "$(status /api/stream/play "{\"kind\":\"movie\",\"tmdb_id\":$FILM}")" = 502 ] || fail "a play with no Chrome did not answer 502"
  until_row "select outcome||'|'||failure||'|'||coalesce(cloud_failure,'-')||'|'||coalesce(torrent_failure,'-')||'|'||coalesce(asked,'-') from stream_play_log where id = (select max(id) from stream_play_log)" "failed|resolve_failed|resolve_failed|-|-"
  ok "an ask whose resolve could not run: failed, resolve_failed for the cloud, torrents off so not asked"
  printf 'hls\n' >"$DIRECT/mode"
  pass
}

stage_beat() {
  stage beat
  play
  local load='"load":"loadCCCC3","first_frame_ms":800,"stalls":0,"stalled_ms":0,"waits":0,"waited_ms":0,"errors":0' before i
  report "{\"position_s\":5,\"duration_s\":600,\"paused\":false,\"stats\":{$load,\"played_ms\":5000}}" >/dev/null
  until_row "$(row "outcome||'|'||played_ms")" "played|5000"
  before="$(q "$(row "updated_at::text")")"
  # The pause itself, then a beat every 5 s past the 30 s write interval (the page stays the stream on screen).
  report "{\"position_s\":5,\"duration_s\":600,\"paused\":true,\"stats\":{$load,\"played_ms\":5000}}" >/dev/null
  for i in $(seq 1 8); do
    sleep 5
    report "{\"position_s\":5,\"duration_s\":600,\"paused\":true,\"beat\":true,\"stats\":{$load,\"played_ms\":9000}}" >/dev/null
  done
  sleep 1
  [ "$(q "$(row "played_ms||'|'||(updated_at::text = '$before')::text")")" = "5000|true" ] || fail "a paused beat wrote the row: $(q "$(row "played_ms||'|'||updated_at::text")") (was 5000|$before)"
  ok "eight paused beats over 40 s wrote nothing"
  report "{\"position_s\":5,\"duration_s\":600,\"paused\":true,\"stats\":{$load,\"played_ms\":9000}}" >/dev/null
  until_row "$(row "played_ms::text")" "9000"
  ok "the next report that is not a beat wrote what the beats carried"
  pass
}

stage_replaced() {
  stage replaced
  local first
  play
  first=$SID
  report '{"position_s":5,"duration_s":600,"paused":false}' >/dev/null
  play
  report '{"position_s":5,"duration_s":600,"paused":false}' >/dev/null
  until_row "select coalesce(ended,'-') from stream_play_log where session = '$first'" "replaced"
  until_row "$(row "coalesce(ended,'-')")" "-"
  ok "the play whose page took the screen left the other one replaced, and stays open itself"
  pass
}

stage_restart() {
  stage restart
  play
  report '{"position_s":5,"duration_s":600,"paused":false}' >/dev/null
  until_row "$(row "outcome||'|'||coalesce(ended,'-')")" "played|-"
  "$V" restart "$RUN" >/dev/null
  until_row "$(row "coalesce(ended,'-')||'|'||(ended_at is not null)::text")" "restart|true"
  until_row "select count(*) from stream_play_log where session is not null and ended is null" "0"
  ok "the daemon's start closed the open row as restart, and left no session row open"
  pass
}

for s in "${WANTED[@]}"; do
  case "$s" in
    ask | stats | failed | beat | replaced | restart) "stage_$s" ;;
    *) fail "unknown stage $s" ;;
  esac
done
STAGE=all
echo "playlog: PASS (${WANTED[*]})"
"$V" note "$RUN" "play log: PASS (${WANTED[*]})"
