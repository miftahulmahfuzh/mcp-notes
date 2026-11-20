#!/usr/bin/env bash
# journey.sh RUN: the Stream side's daily trending list, end to end, on a `verify.sh up --web --trending` run.
# The fake index (scripts/torrent/fake-index.mjs) lists, as apibay's and EZTV's top lists, titles of the fake TMDB:
#   467905 How to Make a Killing  the seeded fixture film       -> listed
#   990001 The Rivals of Amziah King  a hash nobody seeds        -> listed (no swarm is joined); marked
#                                 not interested AFTER the list was built -> leaves at once, back on undo
#   990004 Oldboy                 the owner's watched flag set before the pass -> never listed
#   990003 Bad Apples             a cinema recording (HDCAM)     -> never listed
#   990002 The Dog Stars          in the fixture library partway through (state dropped) -> never listed: started
#   247718 MobLand                the seeded season pack (EZTV)  -> a series, listed
# Every stage drives the real daemon over HTTP, then the page with Playwright. The first failed check stops it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: journey.sh RUN}
DIR="$VERIFY_HOME/$RUN"
[ -f "$DIR/port" ] || { echo "trending: no live run $RUN" >&2; exit 2; }
URL="http://127.0.0.1:$(cat "$DIR/port")"
T="$DIR/torrent"
STAGE=start
BODY=""

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "trending $STAGE: $*"; }
fail() {
  echo "trending: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "trending FAIL at $STAGE: $*" || true
  exit 1
}
CODE=""
# Sets CODE and BODY; call it directly, never inside $( ).
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
get() { curl -sS "$URL/api/movies/trending"; }
ids() { jq -r '[.titles[].id] | sort | join(" ")'; }

FILM_HASH="$(jq -r .info_hash "$T/fixture.json")"
PACK_HASH="$(jq -r .info_hash "$T/pack.json")"
DEAD_HASH="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
row() { jq -nc --arg h "$1" --arg n "$2" --argjson s "$3" --arg i "$4" '{info_hash: $h, name: $n, seeders: $s, size: 1000000000, imdb: $i}'; }

stage listing
jq -n \
  --argjson a "$(row "$FILM_HASH" 'How to Make a Killing (2026) [1080p] [WEBRip]' 9000 tt0467905)" \
  --argjson b "$(row "$DEAD_HASH" 'The Rivals of Amziah King 2026 1080p WEB-DL' 5000 tt0990001)" \
  --argjson c "$(row "cafebabecafebabecafebabecafebabecafebabe" 'Oldboy 2026 1080p WEB-DL' 4000 tt0990004)" \
  --argjson d "$(row "0123456789abcdef0123456789abcdef01234567" 'Bad Apples 2026 HDCAM x264' 3000 tt0990003)" \
  --argjson e "$(row "fedcba9876543210fedcba9876543210fedcba98" 'The Dog Stars 2026 1080p WEB-DL' 2000 tt0990002)" \
  --arg p "$PACK_HASH" \
  '{apibay: {"207": [$a, $b, $c, $d, $e], "208": []}, eztv: [{hash: $p, title: "MobLand S01 720p WEB-DL", seeds: 700, size_bytes: 1000000000, imdb_id: "247718"}]}' \
  >"$T/trending.json"
ok "the fake index lists 5 films and 1 series"

stage before-the-pass
api GET /api/movies/trending; [ "$CODE" = 200 ] || fail "GET /api/movies/trending did not answer 200"
jq -e '.enabled == true and (.titles | length) == 0' <<<"$BODY" >/dev/null || fail "an empty list was expected before the first pass: $BODY"
# The owner has seen Oldboy: a title row with the watched flag, made the way the library makes one.
"$V" exec "$RUN" "insert into movie_titles (id, kind, tmdb_id, title, original_title, year, watched_at) values ('movie-990004','movie',990004,'Oldboy','Oldboy',2026, now()) on conflict (id) do update set watched_at = now()" >/dev/null
ok "an empty list before the pass; Oldboy marked watched"

stage pass
api POST /api/movies/trending/refresh '{}'; [ "$CODE" = 202 ] || fail "the refresh did not answer 202: $BODY"
if ! jq -e '.started == true' <<<"$BODY" >/dev/null; then
  # The automatic first pass (2 min after start) was already running: let it end, then ask for ours, which lists what is in trending.json now.
  for _ in $(seq 1 60); do sleep 1; jq -e '.status.running == false' <<<"$(get)" >/dev/null && break; done
  api POST /api/movies/trending/refresh '{}'
  jq -e '.started == true' <<<"$BODY" >/dev/null || fail "no pass started: $BODY"
fi
for _ in $(seq 1 90); do
  sleep 1
  s="$(get)"
  if jq -e '.status.running == false and .status.last_pass != null and .status.last_pass.finished_at != null' <<<"$s" >/dev/null; then break; fi
done
jq -e '.status.last_pass.finished_at != null' <<<"$s" >/dev/null || fail "the pass did not finish in 90 s: $(jq -c .status <<<"$s")"
echo "$s" >"$DIR/evidence/trending-after-pass.json"
jq -e '.status.last_pass.stopped == "done"' <<<"$s" >/dev/null || fail "the pass stopped with $(jq -c .status.last_pass <<<"$s")"
ok "pass finished: $(jq -c '.status.last_pass | {movies, series, stopped}' <<<"$s")"

stage list
[ "$(ids <<<"$s")" = "movie-467905 movie-990001 tv-247718" ] || fail "wrong titles: $(ids <<<"$s") (Oldboy is watched, The Dog Stars is partway through and Bad Apples is a cinema recording: none may be listed)"
ok "listed: $(ids <<<"$s"); Oldboy (watched), The Dog Stars (started) and Bad Apples (HDCAM) are not"
jq -e '[.titles[] | select(.kind == "movie") | .trending.seeds] == [9000, 5000]' <<<"$s" >/dev/null || fail "films are not in seed order"
jq -e '.titles[] | select(.id == "tv-247718") | .trending.seeds == 700 and .trending.index == "eztv"' <<<"$s" >/dev/null || fail "the series is not listed from eztv with 700 seeds"
ok "films by seeds 9000, 5000; the series from eztv with 700"

stage no-swarm
jq -e '[.titles[].trending | has("probe")] | any | not' <<<"$s" >/dev/null || fail "a title still carries a probe field"
n="$("$V" exec "$RUN" "select count(*) from stream_torrents" 2>/dev/null | grep -E '^ +[0-9]+$' | tr -d ' ')"
[ "${n:-x}" = 0 ] || fail "the pass wrote $n stream_torrents row(s)"
for h in "$FILM_HASH" "$PACK_HASH" "$DEAD_HASH"; do
  [ ! -e "$DIR/data/movies/torrents/$h" ] || fail "the pass left the folder of $h"
done
ok "no probe field, no stream_torrents row and no torrent folder: no swarm was joined"

stage requests
if grep -E '"path":"/(precompiled|api/get-torrents)' "$T/index.jsonl" >/dev/null; then ok "the indexes were asked: $(grep -cE '/precompiled|/api/get-torrents' "$T/index.jsonl") requests, all to the fake index"; else fail "the fake index was never asked"; fi

stage mark-after-build
api POST /api/movies/movie-990001/user '{"not_interested": true}'; [ "$CODE" = 200 ] || fail "not interested was refused: $BODY"
[ "$(ids <<<"$(get)")" = "movie-467905 tv-247718" ] || fail "The Rivals should leave at once: $(ids <<<"$(get)")"
ok "marked not interested after the build: gone from the next read, no new pass"
api POST /api/movies/movie-990001/user '{"not_interested": false}'; [ "$CODE" = 200 ] || fail "undo refused"
[ "$(ids <<<"$(get)")" = "movie-467905 movie-990001 tv-247718" ] || fail "the undo should put it back"
ok "the undo puts it back"

stage page
"$V" ui "$RUN" "$HERE/trending.steps.mjs" >/dev/null || fail "the page steps failed (see the ui transcript in $DIR/evidence)"
ok "the page shows the section, the seed lines and takes a poster off at the click"
echo "trending PASS"
"$V" note "$RUN" "trending PASS"
