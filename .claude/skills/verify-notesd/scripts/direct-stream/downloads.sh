#!/usr/bin/env bash
# downloads.sh RUN [story title season cache ...]: downloads asked for on the title page, the Cache page's
# Downloading view and the season story (stream-downloads-season-story phase 9), on a run started with
#   TORRENT_SEED_KBPS=20 verify.sh up --web --torrent
# The loopback seeder at 20 kB/s keeps the fixture film (about 7 MB) downloading for minutes and the season pack
# (two episodes of about 1.2 MB) for about two, long enough to watch the bars move. Every stage drives the real
# daemon over HTTP and the real page with Playwright (scripts/stream/*.steps.mjs); end states are read over HTTP and
# from the page. Nothing reaches a real index, swarm, model or Chrome: the fake index, the loopback seeder, the fake
# resolver and fixture stream host, and NOTESD_MOVIES_STORY_MODEL=off.
#   story   J4 (R6.1): a seeded story of MobLand S01 answers from the store; the season row's book icon opens it
#   title   J1 (R3.1): the film's torrent download runs; its title page shows the head bar rising; then cancelled
#   season  J2 (R3.1): MobLand season 1 from the pack; the season row and its episode rows show bars rising
#   cache   J3 (R4.2): a ready cloud cache of the film beside the running season; the Downloading filter and back
# The first failed check stops it with `downloads: FAIL at <stage>` (exit 1). A download that answers
# `no_peers_here` (no peer on the office network even through WARP: the run read the office SSID, so verify.sh's
# pin NOTESD_STREAM_DOWNLOAD_SSID=verify-home was lost) stops it with `downloads: INCONCLUSIVE` (exit 3). No stage named: all four, in this order, once per fresh run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
STEPS="$HERE/../stream"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: downloads.sh RUN [story|title|season|cache ...]}
shift
WANTED=("$@")
if [ ${#WANTED[@]} -eq 0 ]; then WANTED=(story title season cache); fi
DIR="$VERIFY_HOME/$RUN"
[ -s "$DIR/torrent/pack.json" ] || { echo "downloads: $RUN was not started with --torrent" >&2; exit 2; }
URL="http://127.0.0.1:$(cat "$DIR/port")"
DIRECT="$DIR/direct"
FILM=467905
SERIES=247718
FILM_SEL=".kind == \"movie\" and .tmdb_id == $FILM"
SEASON_SEL=".kind == \"tv\" and .tmdb_id == $SERIES and .season == 1"
STAGE=start
CODE=""
BODY=""
PASSED=()

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "downloads $STAGE: $*"; }
fail() {
  echo "downloads: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "downloads FAIL at $STAGE: $*" || true
  exit 1
}
inconclusive() {
  echo "downloads: INCONCLUSIVE at $STAGE: $*" >&2
  "$V" note "$RUN" "downloads INCONCLUSIVE at $STAGE: $*" || true
  exit 3
}
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
# rows FILTER: the rows of GET /api/stream/downloads the jq filter keeps, as one JSON array (no evidence per poll).
rows() { curl -sS "$URL/api/stream/downloads" | jq -c "[.downloads[] | select($1)]"; }
# wait_title KEY: the title is stored (GET /api/movies/KEY answers 200). A --movies library holds neither fixture
# title on its own, so it is asked for by POST /api/movies/ensure, as a click on a listed title does; at most 60 s.
wait_title() {
  local i kind=${1%%-*} tmdb=${1##*-}
  for i in $(seq 1 60); do
    [ "$(curl -sS -o /dev/null -w '%{http_code}' "$URL/api/movies/$1")" = 200 ] && return 0
    if [ $((i % 10)) = 1 ]; then
      curl -sS -o /dev/null -X POST -H "Origin: $URL" -H 'Content-Type: application/json' \
        -d "{\"kind\":\"$kind\",\"tmdb_id\":$tmdb}" "$URL/api/movies/ensure" || true
    fi
    sleep 1
  done
  fail "$1 is not stored after 60 s of POST /api/movies/ensure"
}
# wait_running FILTER WHAT: polls until a row the filter keeps is running, at most 120 s.
wait_running() {
  local filter=$1 what=$2 r=""
  for _ in $(seq 1 240); do
    r="$(rows "$filter")"
    if [ "$(jq '[.[] | select(.error == "no_peers_here")] | length' <<<"$r")" != 0 ]; then
      inconclusive "$what answered no_peers_here: the run read the office SSID, so verify.sh's SSID pin was lost"
    fi
    if [ "$(jq '[.[] | select(.state == "running")] | length' <<<"$r")" != 0 ]; then echo "$r"; return 0; fi
    if [ "$(jq 'length > 0 and all(.[]; .state == "failed")' <<<"$r")" = true ]; then fail "$what failed: $r"; fi
    sleep 0.5
  done
  fail "$what did not run within 120 s (finished too fast? start the run with TORRENT_SEED_KBPS=20): $r"
}
# cancel FILTER: cancels every queued, running or paused row the filter keeps.
cancel() {
  local id
  for id in $(rows "$1" | jq -r '.[] | select(.state == "queued" or .state == "running" or .state == "paused") | .id'); do
    api DELETE "/api/stream/downloads/$id"
    case "$CODE" in 200|202|204) ;; *) fail "DELETE /api/stream/downloads/$id answered HTTP $CODE: $BODY" ;; esac
  done
}

stage_story() {
  stage story
  wait_title "tv-$SERIES"
  "$V" exec "$RUN" "delete from movie_stories where title_id = 'tv-$SERIES' and season = 1 and episode = 0" >/dev/null
  "$V" exec "$RUN" "insert into movie_stories (title_id, season, episode, text, sections, sources, origin, model, written_at) values (
    'tv-$SERIES', 1, 0, 'Season 1 of MobLand, from the recaps of a verify fixture.',
    '[{\"episode\":1,\"name\":\"Stick or Twist\",\"text\":\"Harry Da Souza is called in when a London crime family loses a son.\",\"found\":true},
      {\"episode\":2,\"name\":\"Eye for an Eye\",\"text\":\"The Harrigans answer the killing and Harry is caught between both sides.\",\"found\":true},
      {\"episode\":3,\"name\":\"Lie Down with Dogs\",\"text\":\"\",\"found\":false}]'::jsonb,
    '[{\"url\":\"https://en.wikipedia.org/wiki/MobLand\",\"title\":\"MobLand - Wikipedia\",\"site\":\"Wikipedia\"}]'::jsonb,
    'web', 'verify-fixture', now())" >/dev/null
  api GET "/api/movies/tv-$SERIES/story?season=1"
  [ "$CODE" = 200 ] || fail "GET the season story answered HTTP $CODE: $BODY"
  [ "$(jq '.story.sections | length' <<<"$BODY")" = 3 ] || fail "the season story does not answer its three sections: $BODY"
  [ "$(jq -r .cached <<<"$BODY")" = true ] || fail "the season story was not answered from the store: $BODY"
  ok "the stored story of MobLand S01 answers three sections from the store (the story model is off on this run)"
  SERIES_ID="tv-$SERIES" "$V" ui "$RUN" "$STEPS/season-story.steps.mjs" || fail "season-story.steps.mjs failed (see the evidence)"
  ok "the season row's story button opens the pop-up with one section per episode"
  PASSED+=(story)
}

stage_title() {
  stage title
  wait_title "movie-$FILM"
  api POST /api/stream/downloads "{\"kind\":\"movie\",\"tmdb_id\":$FILM,\"via\":\"torrent\"}"
  case "$CODE" in 200|202) ;; *) fail "POST /api/stream/downloads for the film answered HTTP $CODE: $BODY" ;; esac
  wait_running "$FILM_SEL" "the film's download" >/dev/null
  ok "the film's torrent download runs"
  TITLE_ID="movie-$FILM" "$V" ui "$RUN" "$STEPS/downloads-title.steps.mjs" || fail "downloads-title.steps.mjs failed (see the evidence)"
  ok "the film's title page shows its head bar rising, read at most 3 s apart"
  cancel "$FILM_SEL"
  [ "$(rows "$FILM_SEL" | jq '[.[] | select(.state == "queued" or .state == "running" or .state == "paused")] | length')" = 0 ] \
    || fail "the film still downloads after DELETE: $(rows "$FILM_SEL")"
  ok "the film's download is cancelled, so the seeder serves the season next"
  PASSED+=(title)
}

stage_season() {
  stage season
  wait_title "tv-$SERIES"
  cancel "$FILM_SEL"
  api POST /api/stream/downloads "{\"kind\":\"tv\",\"tmdb_id\":$SERIES,\"season\":1,\"via\":\"torrent\"}"
  case "$CODE" in 200|202) ;; *) fail "POST /api/stream/downloads for season 1 answered HTTP $CODE: $BODY" ;; esac
  local r
  r="$(wait_running "$SEASON_SEL" "MobLand season 1")"
  [ "$(jq '[.[] | .episode] | (index(1) != null) and (index(2) != null)' <<<"$r")" = true ] \
    || fail "season 1's rows do not hold S01E01 and S01E02: $r"
  ok "MobLand season 1 downloads: $(jq -c '[.[] | {episode, state}]' <<<"$r")"
  SERIES_ID="tv-$SERIES" "$V" ui "$RUN" "$STEPS/downloads-season.steps.mjs" || fail "downloads-season.steps.mjs failed (see the evidence)"
  ok "the season row and the rows of S01E01 and S01E02 show bars, read at most 3 s apart"
  PASSED+=(season)
}

stage_cache() {
  stage cache
  wait_title "movie-$FILM"
  wait_title "tv-$SERIES"
  # On disk and not downloading: a ready cloud cache of the film (the fake resolver and the fixture stream host).
  printf 'hls\n' >"$DIRECT/mode"
  api POST /api/stream/cache "{\"kind\":\"movie\",\"tmdb_id\":$FILM}"
  case "$CODE" in 200|202) ;; *) fail "POST /api/stream/cache for the film answered HTTP $CODE: $BODY" ;; esac
  local id state="" i
  id="$(jq -r .cache.id <<<"$BODY")"
  for i in $(seq 1 360); do
    state="$(curl -sS "$URL/api/stream/cache/$id" | jq -r .state)"
    [ "$state" = ready ] && break
    [ "$state" = failed ] && fail "the film's cloud cache failed: $(curl -sS "$URL/api/stream/cache/$id")"
    sleep 0.25
  done
  [ "$state" = ready ] || fail "the film's cloud cache is $state after 90 s"
  ok "the film has a ready cloud cache ($id): on disk, downloading nothing"
  # Downloading: season 1 (the season stage's, or asked for again here: 200 when it already is).
  cancel "$FILM_SEL"
  api POST /api/stream/downloads "{\"kind\":\"tv\",\"tmdb_id\":$SERIES,\"season\":1,\"via\":\"torrent\"}"
  case "$CODE" in 200|202) ;; *) fail "POST /api/stream/downloads for season 1 answered HTTP $CODE: $BODY" ;; esac
  wait_running "$SEASON_SEL" "MobLand season 1" >/dev/null
  ok "MobLand season 1 still downloads"
  FILM_ID="movie-$FILM" SERIES_ID="tv-$SERIES" "$V" ui "$RUN" "$STEPS/downloads-cache.steps.mjs" \
    || fail "downloads-cache.steps.mjs failed (see the evidence)"
  ok "the Downloading filter lists only MobLand's downloading rows, and a second click brings the film back"
  PASSED+=(cache)
}

for s in "${WANTED[@]}"; do
  case "$s" in
    story) stage_story ;;
    title) stage_title ;;
    season) stage_season ;;
    cache) stage_cache ;;
    *) echo "downloads: unknown stage $s (story, title, season, cache)" >&2; exit 2 ;;
  esac
done
echo "downloads: PASS (${PASSED[*]})"
"$V" note "$RUN" "downloads: PASS (${PASSED[*]})"
