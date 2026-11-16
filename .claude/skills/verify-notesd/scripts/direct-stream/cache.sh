#!/usr/bin/env bash
# cache.sh RUN [start|tool|refused|other|clear ...]: the stream cache's checks (stream-cache phase 5)
# on a `verify.sh up --direct-stream` run. Every stage drives the real daemon over HTTP or MCP: the
# fake resolver (tests/fixtures/direct-stream/fake-cli.mjs) answers the resolves and the fixture stream
# host (tests/fixtures/direct-stream/upstream.mjs) serves the stream. End states are read over HTTP,
# from the run's database (read-only), from the cache folder and from the fixture host's request log.
# The first failed check stops it with `cache: FAIL at <stage>`. No stage named: all five, in order.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: cache.sh RUN [start|tool|refused|other|clear ...]}
shift
WANTED=("$@")
if [ ${#WANTED[@]} -eq 0 ]; then WANTED=(start tool refused other clear); fi
DIR="$VERIFY_HOME/$RUN"
DIRECT="$DIR/direct"
[ -s "$DIRECT/upstream.json" ] || { echo "cache: $RUN was not started with --direct-stream" >&2; exit 2; }
DB="$(cat "$DIR/db")"
URL="http://127.0.0.1:$(cat "$DIR/port")"
EV="$DIR/evidence"
ROOT="$DIR/data/movies/stream-cache"
OTHER_ID=00000000-0000-4000-8000-000000000603
STAGE=start
CODE=""
BODY=""
PASSED=()

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "stream cache $STAGE: $*"; }
fail() {
  echo "cache: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "stream cache FAIL at $STAGE: $*" || true
  exit 1
}
q() {
  printf 'begin read only;\n%s;\nrollback;\n' "$1" \
    | docker exec -i mcp-notes-pg-verify psql -X -q -tA -v ON_ERROR_STOP=1 -U postgres -d "$DB" \
    | sed '/^BEGIN$/d;/^ROLLBACK$/d'
}
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
get() {
  local path=$1 name=$2
  shift 2
  CODE="$(curl -sS -D "$EV/cache-$name.head" -o "$EV/cache-$name.body" -w '%{http_code}' "$@" "$URL$path")"
}
mcp() { "$V" mcp "$RUN" direct_stream_cache "$1" 2>/dev/null | sed '1d;/^< ERROR$/d'; }
upstream_count() { if [ -f "$DIRECT/upstream.jsonl" ]; then wc -l <"$DIRECT/upstream.jsonl" | tr -d ' '; else echo 0; fi; }
upstream_since() { if [ -f "$DIRECT/upstream.jsonl" ]; then sed -n "$(($1 + 1)),\$p" "$DIRECT/upstream.jsonl"; fi; }
# wait_state ID STATE: polls GET /api/stream/cache/ID (no evidence per poll) until STATE, at most 90 s.
wait_state() {
  local id=$1 want=$2 state view
  for _ in $(seq 1 360); do
    view="$(curl -sS "$URL/api/stream/cache/$id")"
    state="$(jq -r .state <<<"$view")"
    [ "$state" = "$want" ] && { api GET "/api/stream/cache/$id"; return 0; }
    if [ "$state" = failed ] && [ "$want" != failed ]; then fail "cache $id failed: $(jq -c '{error, error_detail}' <<<"$view")"; fi
    sleep 0.25
  done
  fail "cache $id did not reach $want in 90 s (last: $view)"
}
reset_fixture() { rm -f "$DIRECT/token_uses" "$DIRECT/fail_once" "$DIRECT/delay_ms"; }

stage_start() {
  stage start
  reset_fixture
  printf 'hls\n' >"$DIRECT/mode"
  local before id row log
  before="$(upstream_count)"
  api POST /api/stream/cache '{"kind":"movie","tmdb_id":550,"max_height":720}'
  [ "$CODE" = 202 ] || fail "POST /api/stream/cache answered HTTP $CODE: $BODY"
  id="$(jq -r .cache.id <<<"$BODY")"
  [[ $id =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || fail "cache id [$id] is not a uuid"
  [ "$(jq -r .cache.state <<<"$BODY")" = downloading ] || fail "a new cache is not downloading: $BODY"
  wait_state "$id" ready
  [ "$(jq -r '[.height, .max_height, .segments_done, .segments_total, .subtitle, .available, .playlist_url] | map(tostring) | join(" ")' <<<"$BODY")" = "720 720 2 2 true true /api/stream/cache/$id/f/master.m3u8" ] \
    || fail "GET /api/stream/cache/$id is $BODY"
  row="$(q "select state || ' ' || height || ' ' || segments_done || '/' || segments_total || ' ' || manifest_kind || ' ' || resolves || ' ' || (provider is not null)::text || ' ' || (host = '$(hostname)')::text from stream_caches where id = '$id'")"
  [ "$row" = "ready 720 2/2 hls 1 true true" ] || fail "stream_caches holds [$row]"
  ok "a cache of movie 550 under 720p is ready and recorded: $row"
  for f in master.m3u8 video.m3u8 v-init-1.mp4 v-00001.m4s v-00002.m4s subtitle.vtt cache.json; do
    [ -s "$ROOT/$id/$f" ] || fail "$f is not in $ROOT/$id"
  done
  ok "the folder holds the playlists, the init section, both segments and the subtitle"
  log="$(upstream_since "$before")"
  [ "$(jq -s '[.[] | select(.path | startswith("/hls/1080/"))] | length' <<<"$log")" = 0 ] || fail "the 1080p rendition was fetched"
  [ "$(jq -s '[.[] | select(.path == "/hls/720/index.m3u8")] | length' <<<"$log")" = 1 ] || fail "the 720p playlist was not fetched once"
  ok "only the 720p rendition was fetched (the master also names 1080p)"
  get "/api/stream/cache/$id/f/video.m3u8" video-playlist
  [ "$CODE" = 200 ] || fail "video.m3u8 answered HTTP $CODE"
  grep -qx 'v-00002.m4s' "$EV/cache-video-playlist.body" && grep -qx '#EXT-X-ENDLIST' "$EV/cache-video-playlist.body" \
    || fail "video.m3u8 does not list the local segments with ENDLIST"
  get "/api/stream/cache/$id/f/v-00001.m4s" segment-range -H 'Range: bytes=0-99'
  [ "$CODE" = 206 ] && [ "$(wc -c <"$EV/cache-segment-range.body" | tr -d ' ')" = 100 ] || fail "a 100-byte range of v-00001.m4s answered HTTP $CODE"
  get "/api/stream/cache/$id/f/subtitle.vtt" subtitle
  head -1 "$EV/cache-subtitle.body" | grep -qx 'WEBVTT' || fail "subtitle.vtt is not WebVTT"
  ok "the files are served from disk: the playlist, a 206 range, the subtitle"
  echo "$id" >"$EV/cache-start.id"
  PASSED+=(start)
}

stage_tool() {
  stage tool
  reset_fixture
  printf 'hls\n' >"$DIRECT/mode"
  local out id
  out="$(mcp '{"action":"start","title":"tv-247718","season":1,"episode":1}')"
  [ "$(jq -r .started <<<"$out")" = true ] || fail "direct_stream_cache start answered $out"
  id="$(jq -r .cache.id <<<"$out")"
  wait_state "$id" ready
  out="$(mcp '{"action":"status","title":"tv-247718","season":1,"episode":1}')"
  [ "$(jq -r '.caches[0] | [.state, .season, .episode, .available] | map(tostring) | join(" ")' <<<"$out")" = "ready 1 1 true" ] \
    || fail "direct_stream_cache status answered $out"
  [ "$(q "select kind || ' ' || season || ' ' || episode || ' ' || state from stream_caches where id = '$id'")" = "tv 1 1 ready" ] \
    || fail "the tool's cache is not recorded as tv S1E1 ready"
  ok "direct_stream_cache started tv 247718 S01E01, which is ready and recorded"
  PASSED+=(tool)
}

stage_refused() {
  stage refused
  reset_fixture
  printf 'hls_token\n' >"$DIRECT/mode"
  printf '10\n' >"$DIRECT/token_uses"
  printf 'seg3.ts\n' >"$DIRECT/fail_once"
  local before id row log files
  before="$(upstream_count)"
  api POST /api/stream/cache '{"kind":"movie","tmdb_id":990004}'
  [ "$CODE" = 202 ] || fail "POST /api/stream/cache answered HTTP $CODE: $BODY"
  id="$(jq -r .cache.id <<<"$BODY")"
  wait_state "$id" ready
  reset_fixture
  row="$(q "select state || ' ' || segments_done || '/' || segments_total || ' ' || height || ' ' || audio_lang || ' ' || (resolves >= 3)::text from stream_caches where id = '$id'")"
  [ "$row" = "ready 24/24 720 ko true" ] || fail "stream_caches holds [$row]"
  log="$(upstream_since "$before")"
  [ "$(jq -s '[.[] | select((.path | startswith("/tok/")) and .status == 403)] | length' <<<"$log")" -ge 1 ] || fail "the host never refused a token"
  [ "$(jq -s '[.[] | select(.status == 503 and (.path | endswith("/seg3.ts")))] | length' <<<"$log")" = 1 ] || fail "seg3.ts was not failed exactly once"
  [ "$(jq -s '[.[] | select((.path | startswith("/tok/")) and .status == 200 and (.path | test("seg[0-9]+\\.ts$"))) | (.path | sub("^/tok/t[0-9]+/"; ""))] | group_by(.) | map(select(length > 1)) | length' <<<"$log")" = 0 ] \
    || fail "a segment was downloaded twice: the download did not carry on from disk"
  [ "$(jq -s '[.[] | select(.path | test("/audio/en/"))] | length' <<<"$log")" = 0 ] || fail "the English dub was fetched"
  files="$(find "$ROOT/$id" -maxdepth 1 -name 'v-0*.ts' | wc -l | tr -d ' ') $(find "$ROOT/$id" -maxdepth 1 -name 'a-0*.ts' | wc -l | tr -d ' ')"
  [ "$files" = "12 12" ] && [ -s "$ROOT/$id/v-key-1.key" ] || fail "the folder holds [$files] video/audio segments"
  ok "refused tokens resolved again, seg3.ts retried, no segment fetched twice, Korean audio only: $row"
  PASSED+=(refused)
}

stage_other() {
  stage other
  "$V" exec "$RUN" "insert into stream_caches (id, host, kind, tmdb_id, provider, manifest_kind, height, state, segments_total, segments_done, bytes, resolves, subtitle, completed_at) values ('$OTHER_ID', 'other-laptop', 'movie', 603, 'Alpha', 'hls', 1080, 'ready', 10, 10, 12345, 1, true, now()) on conflict do nothing" >/dev/null
  api GET /api/stream/cache
  [ "$(jq -r --arg id "$OTHER_ID" '.caches[] | select(.id == $id) | [.available, .host, .playlist_url, .subtitle_url] | map(tostring) | join(" ")' <<<"$BODY")" = "false other-laptop null null" ] \
    || fail "the other machine's cache is listed as $BODY"
  for f in master.m3u8 v-00001.ts subtitle.vtt; do
    get "/api/stream/cache/$OTHER_ID/f/$f" "other-$f"
    [ "$CODE" = 404 ] && [ "$(jq -r '.error + " " + .host' "$EV/cache-other-$f.body")" = "not_on_this_machine other-laptop" ] \
      || fail "$f of the other machine's cache answered HTTP $CODE: $(cat "$EV/cache-other-$f.body")"
  done
  api DELETE "/api/stream/cache/$OTHER_ID"
  [ "$CODE" = 404 ] && [ "$(jq -r .error <<<"$BODY")" = not_on_this_machine ] || fail "DELETE of the other machine's cache answered HTTP $CODE: $BODY"
  [ "$(q "select count(*) from stream_caches where id = '$OTHER_ID'")" = 1 ] || fail "the other machine's row was removed"
  ok "the other machine's cache is listed available false; its files and its delete answer 404 not_on_this_machine; its row stays"
  PASSED+=(other)
}

stage_clear() {
  stage clear
  reset_fixture
  [ -s "$EV/cache-start.id" ] || fail "run the start stage first"
  local id lid n1 n2
  id="$(cat "$EV/cache-start.id")"
  api DELETE "/api/stream/cache/$id"
  [ "$CODE" = 200 ] && [ "$(jq -r '.ok, .id' <<<"$BODY" | tr '\n' ' ')" = "true $id " ] || fail "DELETE answered HTTP $CODE: $BODY"
  [ ! -e "$ROOT/$id" ] || fail "$ROOT/$id is still there"
  [ "$(q "select count(*) from stream_caches where id = '$id'")" = 0 ] || fail "the row is still there"
  api GET /api/stream/cache
  [ "$(jq -r --arg id "$id" '[.caches[] | select(.id == $id)] | length' <<<"$BODY")" = 0 ] || fail "GET /api/stream/cache still lists it"
  [ "$(mcp '{"action":"list"}' | jq -r --arg id "$id" '[.caches[] | select(.id == $id)] | length')" = 0 ] || fail "direct_stream_cache list still lists it"
  api GET "/api/stream/cache/$id"
  [ "$CODE" = 404 ] && [ "$(jq -r .error <<<"$BODY")" = unknown_cache ] || fail "GET of the cleared cache answered HTTP $CODE: $BODY"
  ok "a ready cache was cleared: folder, row and every listing"
  printf 'hls_token\n' >"$DIRECT/mode"
  printf '300\n' >"$DIRECT/delay_ms"
  api POST /api/stream/cache '{"kind":"movie","tmdb_id":680}'
  [ "$CODE" = 202 ] || fail "POST answered HTTP $CODE: $BODY"
  lid="$(jq -r .cache.id <<<"$BODY")"
  for _ in $(seq 1 120); do
    [ "$(curl -sS "$URL/api/stream/cache/$lid" | jq -r .segments_done)" -ge 1 ] && break
    sleep 0.25
  done
  [ "$(curl -sS "$URL/api/stream/cache/$lid" | jq -r .state)" = downloading ] || fail "the second cache is not downloading"
  api DELETE "/api/stream/cache/$lid"
  [ "$CODE" = 200 ] || fail "DELETE during the download answered HTTP $CODE: $BODY"
  sleep 1
  n1="$(upstream_count)"
  sleep 2
  n2="$(upstream_count)"
  reset_fixture
  [ "$n1" = "$n2" ] || fail "the stream host got $((n2 - n1)) request(s) after the clear"
  [ ! -e "$ROOT/$lid" ] && [ "$(q "select count(*) from stream_caches where id = '$lid'")" = 0 ] || fail "the cleared download left its folder or row"
  ok "a running download was cleared: no request after it, folder and row gone"
  PASSED+=(clear)
}

for s in "${WANTED[@]}"; do
  case "$s" in
    start | tool | refused | other | clear) "stage_$s" ;;
    *) echo "cache: unknown stage $s" >&2; exit 2 ;;
  esac
done
echo "cache: PASS (${PASSED[*]})"
"$V" note "$RUN" "stream cache: PASS (${PASSED[*]})"
