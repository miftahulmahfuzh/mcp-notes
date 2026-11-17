#!/usr/bin/env bash
# ahead.sh RUN: the next episode, fetched while this one plays (src/directStream/ahead.ts), on a
# `verify.sh up --direct-stream` run. It plays an episode of the fake TMDB's series through the fake
# resolver, reports two minutes of playing as the player page does (one report every 5 s, so it takes
# a little over two minutes), and reads the end state over HTTP and from the daemon's log: the next
# episode is in this host's stream cache, marked `auto`, and a film fetches nothing.
# The first failed check stops it with `ahead: FAIL`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: ahead.sh RUN}
DIR="$VERIFY_HOME/$RUN"
DIRECT="$DIR/direct"
[ -s "$DIRECT/upstream.json" ] || { echo "ahead: $RUN was not started with --direct-stream" >&2; exit 2; }
URL="http://127.0.0.1:$(cat "$DIR/port")"
SERIES=${AHEAD_SERIES:-247718}

ok() { echo "   ok  $*"; "$V" note "$RUN" "stream ahead: $*"; }
fail() {
  echo "ahead: FAIL: $*" >&2
  "$V" note "$RUN" "stream ahead FAIL: $*" || true
  exit 1
}
post() { curl -sS -X POST -H 'content-type: application/json' -H "Origin: $URL" -d "$2" "$URL$1"; }
caches() { curl -sS "$URL/api/stream/cache" | jq -c "[.caches[] | select(.tmdb_id == $1) | {season, episode, state, auto}]"; }

printf 'hls\n' >"$DIRECT/mode"
rm -f "$DIRECT/token_uses" "$DIRECT/fail_once" "$DIRECT/delay_ms"

echo "== a film"
film="$(post /api/stream/play '{"kind":"movie","tmdb_id":550}' | jq -r '.session.session_id // empty')"
[ -n "$film" ] || fail "the film did not play"
echo "== an episode"
play="$(post /api/stream/play "{\"kind\":\"tv\",\"tmdb_id\":$SERIES,\"season\":1,\"episode\":1}")"
sid="$(jq -r '.session.session_id // empty' <<<"$play")"
[ -n "$sid" ] || fail "the episode did not play: $play"
next="$(jq -c '.session.next_episode' <<<"$play")"
[ "$next" != null ] || fail "the session names no next episode: $play"
ok "S01E01 of series $SERIES plays (session ${sid:0:6}), and names its next episode $next"

echo "== two minutes of playing, a report every 5 s"
for i in $(seq 0 25); do
  post "/api/stream/sessions/$film/position" "{\"position_s\":$((i * 5)),\"duration_s\":8000,\"paused\":false}" >/dev/null
  post "/api/stream/sessions/$sid/position" "{\"position_s\":$((i * 5)),\"duration_s\":1500,\"paused\":false}" >/dev/null
  if [ "$i" = 12 ]; then
    [ "$(caches "$SERIES")" = "[]" ] || fail "something was cached after one minute: $(caches "$SERIES")"
    ok "after one minute nothing is fetched"
  fi
  sleep 5
done

want_season="$(jq -r .season <<<"$next")"
want_episode="$(jq -r .episode <<<"$next")"
for _ in $(seq 1 120); do
  got="$(caches "$SERIES")"
  [ "$(jq -r --argjson s "$want_season" --argjson e "$want_episode" '[.[] | select(.season == $s and .episode == $e and .state == "ready" and .auto == true)] | length' <<<"$got")" = 1 ] && break
  sleep 0.5
done
[ "$(jq 'length' <<<"$got")" = 1 ] || fail "expected one cache of the series, the next episode: $got"
[ "$(jq -r '.[0].state' <<<"$got")" = ready ] || fail "the next episode's cache is not ready: $got"
ok "the next episode is in this host's stream cache: $got"
[ "$(caches 550)" = "[]" ] || fail "the film fetched something: $(caches 550)"
ok "the film fetched nothing"
grep -q "stream ahead: caching TMDB tv $SERIES S0*${want_season}E0*${want_episode} while TMDB tv $SERIES S01E01 plays" "$DIR/daemon.log" || fail "the daemon's log has no 'stream ahead: caching' line"
ok "the daemon logged: $(grep -o 'stream ahead: .*' "$DIR/daemon.log" | head -1)"

echo "== the next episode plays from the cache"
again="$(post "/api/stream/sessions/$sid/episode" '{"to":"next"}')"
if [ "$(jq -r '.cached.state // empty' <<<"$again")" = ready ]; then
  ok "the next button answers the cached episode with no resolve (cached.state ready)"
else
  fail "the next episode did not play from the cache: $again"
fi
echo "ahead: PASS"
