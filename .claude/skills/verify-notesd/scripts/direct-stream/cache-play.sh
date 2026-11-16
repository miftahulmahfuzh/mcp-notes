#!/usr/bin/env bash
# cache-play.sh RUN [ready|downloading|other-host ...]: playing from the stream cache
# (STREAM_CACHE_AND_BUG_REPORT phase 6) on a `verify.sh up --direct-stream` run. Makes (or reuses) a
# cache of TMDB movie 550 through phase 5's POST /api/stream/cache, against the fake resolver and the
# fixture stream host, and waits for it to be ready. Then:
#   ready        the fake resolver is set to fail (no_source); a play answers 200 from the cache with no
#                resolve and one open, and its playlist and a segment come from disk (the fixture host
#                gets no request).
#   downloading  the cache's segment files are removed and its row set to downloading; a play answers
#                cached.state "downloading", and a segment the local playlist names is fetched on demand
#                (the fixture host gets a request) and answered 200.
#   other-host   the cache's row is moved to another host; POST /api/stream/cache/<id>/play answers 404
#                not_on_this_machine with that host, and a play of the title resolves as if there were
#                no cache (502 no_source, one more resolve).
# Stages run in the order given (default: all three). Ends with `cache-play: PASS (<stages>)`; the first
# failed check stops it with `cache-play: FAIL at <stage>`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: cache-play.sh RUN [ready|downloading|other-host ...]}
shift
WANTED=("$@")
if [ ${#WANTED[@]} -eq 0 ]; then WANTED=(ready downloading other-host); fi
DIR="$VERIFY_HOME/$RUN"
DIRECT="$DIR/direct"
[ -s "$DIRECT/upstream.json" ] || { echo "cache-play: $RUN was not started with --direct-stream" >&2; exit 2; }
URL="http://127.0.0.1:$(cat "$DIR/port")"
EV="$DIR/evidence"
STAGE=start
CODE=""
BODY=""
CID=""
FILM='{"kind":"movie","tmdb_id":550}'

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "cache-play $STAGE: $*"; }
fail() {
  echo "cache-play: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "cache-play FAIL at $STAGE: $*" || true
  exit 1
}
# api METHOD PATH [JSON]: through verify.sh (evidence saved, same-origin Origin sent); sets CODE and BODY.
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
# get PATH NAME: GET as the player does (no Origin); headers and body saved as evidence; sets CODE.
get() {
  CODE="$(curl -sS -D "$EV/cache-$2.head" -o "$EV/cache-$2.body" -w '%{http_code}' "$URL$1")"
}
upstream_count() { if [ -f "$DIRECT/upstream.jsonl" ]; then wc -l <"$DIRECT/upstream.jsonl" | tr -d ' '; else echo 0; fi; }
# calls_of VERB: how many times the fake resolver was run with that first argument (resolve, open).
calls_of() {
  if [ -f "$DIRECT/calls.jsonl" ]; then jq -r '.args[0]' "$DIRECT/calls.jsonl" | { grep -cx "$1" || true; }; else echo 0; fi
}
# first_segment PATH: the first media segment the local playlist at PATH names; a master playlist is
# followed to its first rendition. Prints nothing when the playlist names a remote address.
first_segment() {
  local path=$1 body line hops=0
  while :; do
    body="$(curl -sS "$URL$path")"
    line="$(grep -v '^#' <<<"$body" | grep -v '^[[:space:]]*$' | head -1 | tr -d '\r')"
    [ -n "$line" ] || return 0
    case "$line" in
      /*) ;;
      http:* | https:*) return 0 ;;
      *) line="${path%/*}/$line" ;;
    esac
    if grep -q '^#EXT-X-STREAM-INF' <<<"$body" && [ $hops -lt 2 ]; then
      path=$line
      hops=$((hops + 1))
      continue
    fi
    echo "$line"
    return 0
  done
}
# ensure_cache: CID of a ready cache of movie 550 on this run (phase 5's routes; either answer shape).
ensure_cache() {
  [ -z "$CID" ] || return 0
  printf 'hls\n' >"$DIRECT/mode"
  api POST /api/stream/cache "$FILM"
  [[ $CODE == 20? ]] || fail "POST /api/stream/cache answered HTTP $CODE: $BODY"
  CID="$(jq -r '.cache.id // .id // empty' <<<"$BODY")"
  [ -n "$CID" ] || fail "POST /api/stream/cache named no cache id: $BODY"
  local state="" i
  for i in $(seq 1 60); do
    api GET "/api/stream/cache/$CID"
    state="$(jq -r '.cache.state // .state // empty' <<<"$BODY")"
    [ "$state" = ready ] && break
    [ "$state" = failed ] && fail "the cache failed: $BODY"
    sleep 0.5
  done
  [ "$state" = ready ] || fail "the cache is [$state] after 30 s: $BODY"
  ok "cache $CID of movie 550 is ready"
}

stage_ready() {
  stage ready
  ensure_cache
  printf 'no_source\n' >"$DIRECT/mode"
  local resolves opens ups manifest seg
  resolves=$(calls_of resolve)
  opens=$(calls_of open)
  ups=$(upstream_count)
  api POST /api/stream/play "$FILM"
  [ "$CODE" = 200 ] || fail "a play of the cached film answered HTTP $CODE: $BODY"
  [ "$(jq -r '.session.cached.id' <<<"$BODY")" = "$CID" ] || fail "session.cached is not the cache: $(jq -c .session.cached <<<"$BODY")"
  [ "$(jq -r '.session.cached.state' <<<"$BODY")" = ready ] || fail "session.cached.state is not ready: $(jq -c .session.cached <<<"$BODY")"
  [ "$(jq -r '.attempts | length' <<<"$BODY")" = 0 ] || fail "the play carries resolver attempts: $(jq -c .attempts <<<"$BODY")"
  manifest="$(jq -r .session.manifest_url <<<"$BODY")"
  [[ $manifest == "/api/stream/cache/$CID/f/"* ]] || fail "manifest_url [$manifest] is not the cache's file route"
  [ "$(calls_of resolve)" = "$resolves" ] || fail "the play ran the resolver"
  [ "$(calls_of open)" = "$((opens + 1))" ] || fail "the play did not open exactly one player page"
  get "$manifest" ready-manifest
  [ "$CODE" = 200 ] || fail "the local playlist answered HTTP $CODE"
  seg="$(first_segment "$manifest")"
  [ -n "$seg" ] || fail "the local playlist $manifest names no local segment"
  get "$seg" ready-segment
  [ "$CODE" = 200 ] || fail "the segment $seg answered HTTP $CODE"
  [ "$(upstream_count)" = "$ups" ] || fail "playing from the ready cache reached the stream host"
  ok "a play of movie 550 came from ready cache $CID: no resolve (resolver set to no_source), one open, playlist and $seg from disk, the stream host untouched"
}

stage_downloading() {
  stage downloading
  ensure_cache
  local cdir removed ups manifest seg
  cdir="$(find "$DIR" -type d -name "$CID" -print -quit)"
  [ -n "$cdir" ] || fail "no folder named $CID under $DIR"
  removed="$(find "$cdir" -type f \( -name '*.ts' -o -name '*.m4s' \) -print -delete | wc -l | tr -d ' ')"
  [ "$removed" -gt 0 ] || fail "the cache folder $cdir holds no segment file"
  # completed_at goes with the state: phase 5's stream_caches_ready_check ties `ready` to completed_at.
  # verify.sh exec does not fail on an SQL error, so the change is read back.
  "$V" exec "$RUN" "update stream_caches set state = 'downloading', completed_at = null where id = '$CID'" >/dev/null
  "$V" exec "$RUN" "select state from stream_caches where id = '$CID'" 2>/dev/null | grep -qw downloading || fail "the row of $CID could not be set to downloading"
  printf 'hls\n' >"$DIRECT/mode"
  api POST /api/stream/play "$FILM"
  [ "$CODE" = 200 ] || fail "a play of the downloading cache answered HTTP $CODE: $BODY"
  [ "$(jq -r '.session.cached.state' <<<"$BODY")" = downloading ] || fail "session.cached is $(jq -c .session.cached <<<"$BODY"), wanted state downloading"
  manifest="$(jq -r .session.manifest_url <<<"$BODY")"
  [[ $manifest == "/api/stream/cache/$CID/f/"* ]] || fail "manifest_url [$manifest] is not the cache's file route"
  ups=$(upstream_count)
  seg="$(first_segment "$manifest")"
  [ -n "$seg" ] || fail "the local playlist $manifest names no local segment"
  get "$seg" missing-segment
  [ "$CODE" = 200 ] || fail "the segment $seg, not on disk, answered HTTP $CODE (it should be fetched on demand)"
  [ "$(upstream_count)" -gt "$ups" ] || fail "the missing segment was not fetched from the stream host"
  ok "a play of the downloading cache $CID used its local playlist; $seg ($removed segment files removed) was fetched on demand and answered 200"
}

stage_other_host() {
  stage other-host
  ensure_cache
  local resolves
  "$V" exec "$RUN" "update stream_caches set host = 'notesd-other-host' where id = '$CID'" >/dev/null
  api POST "/api/stream/cache/$CID/play" '{}'
  [ "$CODE" = 404 ] || fail "playing the other machine's cache answered HTTP $CODE: $BODY"
  [ "$(jq -r .error <<<"$BODY")" = not_on_this_machine ] || fail "the answer is not not_on_this_machine: $BODY"
  [ "$(jq -r .host <<<"$BODY")" = notesd-other-host ] || fail "the answer does not name the host: $BODY"
  printf 'no_source\n' >"$DIRECT/mode"
  resolves=$(calls_of resolve)
  api POST /api/stream/play "$FILM"
  { [ "$CODE" = 502 ] && [ "$(jq -r .error <<<"$BODY")" = no_source ]; } || fail "a play with only the other machine's cache answered HTTP $CODE: $BODY (wanted 502 no_source: the cache ignored, the title resolved)"
  [ "$(calls_of resolve)" = "$((resolves + 1))" ] || fail "the play did not resolve the title"
  ok "the other machine's cache answered 404 not_on_this_machine (host notesd-other-host); a play of the title ignored it and resolved"
}

for s in "${WANTED[@]}"; do
  case "$s" in
    ready) stage_ready ;;
    downloading) stage_downloading ;;
    other-host) stage_other_host ;;
    *) fail "unknown stage $s" ;;
  esac
done
echo "cache-play: PASS (${WANTED[*]})"
"$V" note "$RUN" "cache-play: PASS (${WANTED[*]})"
