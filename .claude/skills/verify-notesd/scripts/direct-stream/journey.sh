#!/usr/bin/env bash
# journey.sh RUN [seed|hls|dash|refuse|evidence|playerlog|snapshot|unwritable ...]: the direct-streaming feature map's checks on a
# `verify.sh up --direct-stream` run. Every stage drives the real daemon over HTTP: the fake resolver
# (tests/fixtures/direct-stream/fake-cli.mjs) answers the resolve and the fixture stream host
# (tests/fixtures/direct-stream/upstream.mjs) serves the stream. End states are read over HTTP, from
# the run's database (read-only) and from the fixture host's request log. The first failed check stops
# it with `journey: FAIL at <stage>`. No stage named: all eight, in order; run `seed` first on a fresh run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: journey.sh RUN [seed|hls|dash|refuse|evidence|playerlog|snapshot|unwritable ...]}
shift
WANTED=("$@")
if [ ${#WANTED[@]} -eq 0 ]; then WANTED=(seed hls dash refuse evidence playerlog snapshot unwritable); fi
DIR="$VERIFY_HOME/$RUN"
DIRECT="$DIR/direct"
EVLOG="$DIR/data/movies/stream-evidence-$(hostname).jsonl"
[ -s "$DIRECT/upstream.json" ] || { echo "journey: $RUN was not started with --direct-stream" >&2; exit 2; }
DB="$(cat "$DIR/db")"
URL="http://127.0.0.1:$(cat "$DIR/port")"
UP="$(jq -r .origin "$DIRECT/upstream.json")"
ROOT="$(sed -n 's/^repo=//p' "$DIR/meta")"
EV="$DIR/evidence"
STAGE=start
CODE=""
BODY=""
SID=""
MANIFEST=""

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "direct-stream journey $STAGE: $*"; }
fail() {
  echo "journey: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "direct-stream journey FAIL at $STAGE: $*" || true
  exit 1
}
# q SQL: the query's value(s) from the run's database, in a read-only transaction.
q() {
  printf 'begin read only;\n%s;\nrollback;\n' "$1" \
    | docker exec -i mcp-notes-pg-verify psql -X -q -tA -v ON_ERROR_STOP=1 -U postgres -d "$DB" \
    | sed '/^BEGIN$/d;/^ROLLBACK$/d'
}
# api METHOD PATH [JSON]: through verify.sh (evidence saved, same-origin Origin sent); sets CODE and BODY.
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
# get PATH NAME [curl args...]: GET as the player does (no Origin); headers and body saved as evidence; sets CODE.
get() {
  local path=$1 name=$2
  shift 2
  CODE="$(curl -sS -D "$EV/direct-$name.head" -o "$EV/direct-$name.body" -w '%{http_code}' "$@" "$URL$path")"
}
enc() { jq -rn --arg u "$1" '$u|@uri'; }
upstream_count() { if [ -f "$DIRECT/upstream.jsonl" ]; then wc -l <"$DIRECT/upstream.jsonl" | tr -d ' '; else echo 0; fi; }
# play JSON: POST /api/stream/play; sets SID and MANIFEST.
play() {
  api POST /api/stream/play "$1"
  [ "$CODE" = 200 ] || fail "POST /api/stream/play $1 answered HTTP $CODE: $BODY"
  SID="$(jq -r .session.session_id <<<"$BODY")"
  MANIFEST="$(jq -r .session.manifest_url <<<"$BODY")"
  [[ $SID =~ ^[A-Za-z0-9_-]{32}$ ]] || fail "session id [$SID] is not 32 random characters"
  [[ $MANIFEST == "/api/stream/sessions/$SID/p?u="* ]] || fail "manifest_url [$MANIFEST] does not come back through the pass-through"
}

stage_seed() {
  stage seed
  local want got host
  want="$(node -e 'const n = (f) => JSON.parse(require("fs").readFileSync(f, "utf8")).length; console.log(n(process.argv[1]) + n(process.argv[2]))' "$ROOT/claude/streaming/direct/providers.seed.json" "$ROOT/claude/streaming/direct/anime.seed.json")"
  got="$(q "select count(*) || ' ' || count(*) filter (where origin_site is null) from stream_providers")"
  [ "$got" = "$want $want" ] || fail "stream_providers holds [$got] (all, from the seed), wanted [$want $want]"
  ok "the seed's $want providers are in stream_providers, all marked as from the seed"
  printf 'hls\n' >"$DIRECT/mode"
  play '{"kind":"movie","tmdb_id":550}'
  host="$(hostname)"
  got="$(q "select string_agg(last_outcome || ':' || successes || ':' || failures || ':' || coalesce(en_subtitle::text, '-') || ':' || coalesce(best_height::text, '-'), ' ' order by last_outcome) from stream_provider_health where host = '$host'")"
  [ "$got" = "bot_check:0:1:-:- resolved:1:0:true:1080" ] || fail "this host's health rows are [$got]"
  got="$(q "select count(*) from stream_provider_health where host <> '$host'")"
  [ "$got" = 0 ] || fail "$got health row(s) carry another host"
  ok "one resolve wrote this host's health: bot_check for the first provider, resolved with an English subtitle at 1080p for the second"
}

stage_hls() {
  stage hls
  printf 'hls\n' >"$DIRECT/mode"
  local before prefix lines bad req v720 v1080 seg last
  before="$(upstream_count)"
  play '{"kind":"movie","tmdb_id":550}'
  last="$(tail -1 "$DIRECT/calls.jsonl" | jq -c .args)"
  [ "$last" = "[\"open\",\"http://localhost:$(cat "$DIR/port")/stream/$SID\",\"--fullscreen\"]" ] || fail "the resolver was asked to open [$last]"
  ok "the player page http://localhost:<port>/stream/$SID was opened full screen"
  get "$MANIFEST" hls-master
  [ "$CODE" = 200 ] || fail "the master playlist answered $CODE"
  grep -qi '^content-type: application/vnd.apple.mpegurl' "$EV/direct-hls-master.head" || fail "the master playlist is not served as HLS"
  prefix="/api/stream/sessions/$SID/p?u="
  lines="$(grep -v '^#' "$EV/direct-hls-master.body" | grep -v '^[[:space:]]*$' || true)"
  [ "$(grep -c . <<<"$lines")" = 2 ] || fail "the master playlist has [$lines] as address lines, wanted 2"
  bad="$( (grep -v "^$prefix" <<<"$lines" || true) | grep -c . || true)"
  [ "$bad" = 0 ] || fail "$bad address line(s) do not come back through the pass-through"
  [ "$(grep -o 'URI="[^"]*"' "$EV/direct-hls-master.body" | grep -c .)" = 1 ] || fail "the subtitle rendition's URI is missing"
  bad="$( (grep -o 'URI="[^"]*"' "$EV/direct-hls-master.body" | grep -v "^URI=\"$prefix" || true) | grep -c . || true)"
  [ "$bad" = 0 ] || fail "$bad URI attribute(s) do not come back through the pass-through"
  ! grep -q 'http://' "$EV/direct-hls-master.body" || fail "a plain stream host address is left in the playlist"
  ok "every address in the master playlist (2 variants, 1 subtitle rendition) comes back through /api/stream/sessions/$SID/p"
  req="$(sed -n "$((before + 1)),\$p" "$DIRECT/upstream.jsonl" | jq -c 'select(.path == "/hls/master.m3u8") | {referer, origin, user_agent, cookie}' | tail -1)"
  [ "$req" = '{"referer":"https://embed.fixture/","origin":"https://embed.fixture","user_agent":"FixtureChrome/1.0","cookie":null}' ] || fail "the stream host saw [$req]"
  ok "the stream host saw exactly the captured Referer, Origin and User-Agent, and no cookie"
  v720="$(sed -n 1p <<<"$lines")"
  v1080="$(sed -n 2p <<<"$lines")"
  get "$v1080" hls-1080
  [ "$CODE" = 200 ] || fail "the 1080p variant, on a host only the playlist named, answered $CODE"
  ok "the 1080p variant on the second host, named only inside the playlist, answers 200"
  get "$v720" hls-720
  [ "$CODE" = 200 ] || fail "the 720p variant answered $CODE"
  seg="$(grep -v '^#' "$EV/direct-hls-720.body" | grep -v '^[[:space:]]*$' | head -1)"
  [[ $seg == "$prefix"* ]] || fail "the media playlist's segment [$seg] does not come back through the pass-through"
  get "$seg" hls-seg -H 'Range: bytes=0-99'
  [ "$CODE" = 206 ] || fail "a ranged segment request answered $CODE"
  grep -qi '^content-range: bytes 0-99/1000' "$EV/direct-hls-seg.head" || fail "no content-range bytes 0-99/1000"
  [ "$(wc -c <"$EV/direct-hls-seg.body" | tr -d ' ')" = 100 ] || fail "the ranged segment is not 100 bytes"
  ok "a segment fetched with Range: bytes=0-99 answers 206 with 100 bytes"
}

stage_dash() {
  stage dash
  printf 'dash\n' >"$DIRECT/mode"
  play '{"kind":"movie","tmdb_id":550}'
  printf 'hls\n' >"$DIRECT/mode"
  local prefix media seg
  get "$MANIFEST" dash-mpd
  [ "$CODE" = 200 ] || fail "the DASH manifest answered $CODE"
  grep -qi '^content-type: application/dash+xml' "$EV/direct-dash-mpd.head" || fail "the manifest is not served as DASH"
  prefix="/api/stream/sessions/$SID/p?u="
  [ "$(grep -c "<BaseURL>$prefix" "$EV/direct-dash-mpd.body")" = 2 ] || fail "the two BaseURLs are not rewritten"
  ! grep -q 'http://' "$EV/direct-dash-mpd.body" || fail "a plain stream host address is left in the manifest"
  media="$(grep -o 'media="[^"]*"' "$EV/direct-dash-mpd.body" | head -1 | sed 's/^media="//;s/"$//')"
  [[ $media == "$prefix"*'$RepresentationID$'*'$Number%05d$'* ]] || fail "the segment template [$media] lost its template fields"
  ok "both BaseURLs and the segment template come back through the pass-through, template fields untouched"
  seg="${media//\$RepresentationID\$/v720}"
  seg="${seg//\$Number%05d\$/00001}"
  get "$seg" dash-seg
  [ "$CODE" = 200 ] || fail "the filled-in segment address answered $CODE"
  [ "$(wc -c <"$EV/direct-dash-seg.body" | tr -d ' ')" = 1000 ] || fail "the DASH segment is not 1000 bytes"
  ok "the player's filled-in segment address, on the host the manifest's BaseURL named, answers 200 with 1000 bytes"
}

stage_refuse() {
  stage refuse
  printf 'hls\n' >"$DIRECT/mode"
  play '{"kind":"movie","tmdb_id":550}'
  local before after
  before="$(upstream_count)"
  get "/api/stream/sessions/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/p?u=$(enc "$UP/hls/master.m3u8")" refuse-unknown
  { [ "$CODE" = 403 ] && grep -q '"unknown_session"' "$EV/direct-refuse-unknown.body"; } || fail "an unknown session answered $CODE $(cat "$EV/direct-refuse-unknown.body")"
  get "/api/stream/sessions/$SID/p?u=$(enc 'http://evil.example/x.m3u8')" refuse-host
  { [ "$CODE" = 403 ] && grep -q '"forbidden_host"' "$EV/direct-refuse-host.body"; } || fail "a foreign host answered $CODE $(cat "$EV/direct-refuse-host.body")"
  get "/api/stream/sessions/$SID/p?u=$(enc 'http://127.0.0.1:9/x.m3u8')" refuse-port
  { [ "$CODE" = 403 ] && grep -q '"forbidden_host"' "$EV/direct-refuse-port.body"; } || fail "another port answered $CODE $(cat "$EV/direct-refuse-port.body")"
  after="$(upstream_count)"
  [ "$before" = "$after" ] || fail "the stream host got $((after - before)) request(s) for refused addresses"
  ok "an unknown session and two hosts the resolve did not return answer 403, and the stream host got no request"
}

stage_evidence() {
  stage evidence
  printf 'hls\n' >"$DIRECT/mode"
  play '{"kind":"movie","tmdb_id":550}'
  local n
  get "$MANIFEST" ev-master
  [ "$CODE" = 200 ] || fail "the master playlist answered $CODE"
  get "/api/stream/sessions/$SID/p?u=$(enc "$UP/hls/720/seg1.ts?token=JOURNEYSECRET")" ev-seg -H 'Range: bytes=0-99'
  [ "$CODE" = 206 ] || fail "the ranged segment answered $CODE"
  get "/api/stream/sessions/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/p?u=$(enc "$UP/hls/master.m3u8")" ev-gone
  [ "$CODE" = 403 ] || fail "an ended session answered $CODE"
  api GET "/api/stream/evidence?session=$SID&limit=50"
  [ "$CODE" = 200 ] || fail "GET /api/stream/evidence answered $CODE: $BODY"
  n="$(jq '[.records[] | select(.type == "request" and .path == "/hls/720/seg1.ts" and .status == 206 and .answer == 206 and .bytes == 100 and .outcome == "end" and (.ttfb_ms|type) == "number" and (.duration_ms|type) == "number" and (.kbps|type) == "number")] | length' <<<"$BODY")"
  [ "$n" = 1 ] || fail "no single complete record for the segment: $BODY"
  n="$(jq '[.records[] | select(.type == "request" and .path == "/hls/master.m3u8" and .kind == "hls" and .status == 200)] | length' <<<"$BODY")"
  [ "$n" -ge 1 ] || fail "no record for the master playlist"
  ok "the segment's record has status 206, 100 bytes, time to first byte, duration and throughput; the playlist's is marked hls"
  api GET "/api/stream/evidence?session=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
  [ "$(jq -r '.records[-1] | "\(.outcome) \(.answer) \(.error)"' <<<"$BODY")" = "refused 403 unknown_session" ] || fail "the ended session's request is not recorded as refused: $BODY"
  ok "a request for an ended session is recorded as refused with unknown_session"
  [ -s "$EVLOG" ] || fail "no evidence log at $EVLOG"
  cp "$EVLOG" "$EV/direct-evidence.jsonl"
  ! grep -q JOURNEYSECRET "$EVLOG" || fail "the token in the query reached the evidence log"
  ! grep -q FixtureChrome "$EVLOG" || fail "a captured header value reached the evidence log"
  ok "the log on disk holds host and path only: no query token, no captured header value"
}

stage_playerlog() {
  stage playerlog
  printf 'hls\n' >"$DIRECT/mode"
  play '{"kind":"movie","tmdb_id":550}'
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{"lines":[{"text":"x"}]}' "$URL/api/stream/sessions/$SID/events")"
  [ "$code" = 403 ] || fail "events without an Origin answered $code"
  api POST "/api/stream/sessions/$SID/events" '{"lines":[{"text":"refresh after 403 at 61.2 s","stage":"refreshing","position_s":61.2,"buffer_s":3.5},{"text":"error: networkError fragLoadError /api/stream/sessions/x/p?u=SECRETLINE","stage":"error","position_s":61.2,"buffer_s":0}]}'
  [ "$CODE" = 200 ] && [ "$(jq -r .recorded <<<"$BODY")" = 2 ] || fail "POST events answered $CODE: $BODY"
  api GET "/api/stream/evidence?session=$SID"
  [ "$(jq -c '[.records[] | select(.type == "player") | [.stage, .text, .position_s, .buffer_s]]' <<<"$BODY")" = '[["refreshing","refresh after 403 at 61.2 s",61.2,3.5],["error","error: networkError fragLoadError /api/stream/sessions/x/p",61.2,0]]' ] \
    || fail "the page's lines are not in the log as posted: $BODY"
  ! grep -q SECRETLINE "$EVLOG" || fail "a query in a page line reached the evidence log"
  ok "the page's two lines are in the evidence log under the session, the query cut off; no Origin is refused"
}

stage_snapshot() {
  stage snapshot
  printf 'hls\n' >"$DIRECT/mode"
  play '{"kind":"movie","tmdb_id":550}'
  local prov sdir
  prov="$(jq -r .session.provider <<<"$BODY")"
  get "$MANIFEST" snap-master
  api POST "/api/stream/sessions/$SID/events" '{"lines":[{"text":"error: networkError fragLoadError","stage":"error","position_s":12.5,"buffer_s":0}]}'
  api POST "/api/stream/sessions/$SID/refresh"
  [ "$CODE" = 200 ] || fail "the refresh answered $CODE: $BODY"
  api POST /api/stream/evidence/snapshot "{\"session_id\":\"$SID\"}"
  [ "$CODE" = 200 ] || fail "the snapshot answered $CODE: $BODY"
  [ "$(jq -r .complete <<<"$BODY")" = true ] || fail "the snapshot of a live session is not complete: $BODY"
  sdir="$(jq -r .dir <<<"$BODY")"
  [[ $sdir == "$DIR/data/movies/stream-reports/"*"-${SID:0:6}" ]] || fail "the snapshot folder [$sdir] is not under stream-reports named after the session"
  for f in session.json evidence.jsonl player.json; do [ -s "$sdir/$f" ] || fail "$f is missing from $sdir"; done
  [ "$(jq -r '"\(.live) \(.source.provider) \(.source.refreshes) \(.source.attempts|length) \(.source.captured_headers|join(","))"' "$sdir/session.json")" = "true $prov 1 2 referer,origin,user_agent" ] \
    || fail "session.json does not hold the source: $(jq -c .source "$sdir/session.json")"
  jq -e '.lines | map(select(.text == "error: networkError fragLoadError" and .position_s == 12.5)) | length == 1' "$sdir/player.json" >/dev/null || fail "player.json does not hold the posted line"
  grep -q '"path":"/hls/master.m3u8"' "$sdir/evidence.jsonl" || fail "evidence.jsonl does not hold the playlist's record"
  ! grep -rq FixtureChrome "$sdir" || fail "a captured header value reached the snapshot"
  cp -r "$sdir" "$EV/direct-snapshot"
  ok "the snapshot folder holds the source ($prov, 2 attempts, 1 refresh), the records and the page's line, and no captured header value"
}

stage_unwritable() {
  stage unwritable
  printf 'hls\n' >"$DIRECT/mode"
  play '{"kind":"movie","tmdb_id":550}'
  local kept="$DIR/data/movies/stream-evidence.kept" code bytes warned=no
  [ -f "$EVLOG" ] && mv "$EVLOG" "$kept"
  mkdir -p "$EVLOG"
  get "/api/stream/sessions/$SID/p?u=$(enc "$UP/hls/720/seg1.ts")" unw-seg -H 'Range: bytes=0-99'
  code="$CODE"
  bytes="$(wc -c <"$EV/direct-unw-seg.body" | tr -d ' ')"
  sleep 1
  grep -q 'stream evidence: could not write' "$DIR/daemon.log" && warned=yes
  rmdir "$EVLOG"
  [ -f "$kept" ] && mv "$kept" "$EVLOG"
  [ "$code" = 206 ] && [ "$bytes" = 100 ] || fail "with the log unwritable the segment answered $code with $bytes bytes"
  [ "$warned" = yes ] || fail "the daemon did not log the failed write"
  ok "with the evidence log unwritable the segment still answered 206 with 100 bytes, and the daemon logged the failure"
}

for s in "${WANTED[@]}"; do
  case "$s" in
    seed) stage_seed ;;
    hls) stage_hls ;;
    dash) stage_dash ;;
    refuse) stage_refuse ;;
    evidence) stage_evidence ;;
    playerlog) stage_playerlog ;;
    snapshot) stage_snapshot ;;
    unwritable) stage_unwritable ;;
    *) echo "journey: unknown stage $s" >&2; exit 2 ;;
  esac
done
echo "journey: PASS (${WANTED[*]})"
"$V" note "$RUN" "direct-stream journey PASS (${WANTED[*]})"
