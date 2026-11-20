#!/usr/bin/env bash
# speed.sh RUN [race|subtitles|pending|index ...]: TORRENT_PLAY_SPEED's checks, on a run started with the daemon's own
# subtitle wait:   NOTESD_TORRENT_SUBTITLE_WAIT_MS=1500 verify.sh up --torrent
#   race       the index lists a dead swarm first (900 seeds listed, nobody seeds it) and a live one after it. A play
#              with provider "torrent" starts from the live one in well under the 20 s the dead one's file list is
#              waited for: the dead one's attempt is `skipped` ("still opening when ... was chosen"), the played
#              one's names the peers connected and the rate, and a moment later the daemon holds no torrent but it.
#              The daemon's log names why the dead one lost ("lost: still opening (...) when <live> was chosen"), the
#              dead one has no stream_torrents row (it never sent a file list), and the live one's row has no played_at
#              until the page's first position report, which sets it.
#   heights    two live swarms: a 720p listed first (900 seeds) and a 1080p after it (5 seeds). The 1080p plays, and the
#              720p's attempt and log line say why it lost. (Both come from the one loopback seeder; when only the 720p
#              delivers, 720p playing is right and the stage says so instead of failing.)
#   subtitles  the subtitle service answers each request 4 s late (8 s for a file). The play answers before that with `Subtitles: pending`, no
#              subtitle and subtitle_rev 0; then the session gets "English (Wyzie)", subtitle_rev 1, and the answer
#              to a position report (what the open page reads) carries subtitle_rev 1.
#   pending    the index answers after 9 s and lists six dead swarms, so the play takes about 49 s. While it runs:
#              GET /api/movies/player lists it in `starting` with `busy: true` and no `stream`, and install.sh's
#              check (check_idle, pointed at this run) exits 75 and names it. direct_stream_play over MCP answers
#              after about 45 s with `pending: true`, the stage and the attempts so far; the same call again joins
#              the play and answers no_source with all eight attempts (the last "Torrents: not tried yet"); the daemon's log holds every attempt of the
#              play that started nothing; afterwards `starting` is empty and check_idle exits 0.
#   index      the index fails three plays in a row (one timeout, two HTTP 500): each answers `Index: torrentio`
#              error. The fourth play does not ask it (no new request in the fake index's log): its attempt is
#              `skipped` and says why. Run it last: the index stays left out for 30 minutes of this daemon.
# No stage named: all four, in that order. Ends with `speed: PASS (<stages>)`; the first failed check stops it with
# `speed: FAIL at <stage>`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: speed.sh RUN [race|subtitles|pending|index ...]}
shift
WANTED=("$@")
if [ ${#WANTED[@]} -eq 0 ]; then WANTED=(race heights subtitles pending index); fi
DIR="$VERIFY_HOME/$RUN"
TOR="$DIR/torrent"
SUBS="$TOR/subs"
EV="$DIR/evidence"
[ -s "$TOR/index.port" ] || { echo "speed: $RUN was not started with --torrent" >&2; exit 2; }
ROOT="$(sed -n 's/^repo=//p' "$DIR/meta")"
URL="http://127.0.0.1:$(cat "$DIR/port")"
FIX="$(bash "$HERE/make-subtitle-fixtures.sh" "$VERIFY_HOME/.torrent-subtitle-fixtures")"
STAGE=start
CODE=""
BODY=""

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "torrent speed $STAGE: $*"; }
fail() {
  echo "speed: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "torrent speed FAIL at $STAGE: $*" || true
  exit 1
}
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
mcp() {
  local out
  out="$(cd "$ROOT" && "$V" mcp "$RUN" "$1" "$2" 2>/dev/null || true)"
  BODY="$(sed '1d;/^< ERROR$/d' <<<"$out")"
}
now_ms() { date +%s%3N; }
seed() { # seed NAME: prints the info hash of a fixture torrent the loopback seeder now seeds
  mkdir -p "$TOR/seed"
  [ -d "$TOR/seed/$1" ] || { rm -rf "$TOR/seed/.$1"; cp -r "$FIX/$1" "$TOR/seed/.$1"; mv "$TOR/seed/.$1" "$TOR/seed/$1"; }
  for _ in $(seq 1 120); do [ -s "$TOR/seeded/$1.json" ] && break; sleep 0.25; done
  [ -s "$TOR/seeded/$1.json" ] || fail "the loopback seeder did not seed $1"
  jq -r .info_hash "$TOR/seeded/$1.json"
}
# q SQL: one read-only query against the run's database, tuples only.
q() {
  printf 'begin read only;\n%s;\nrollback;\n' "$1" \
    | docker exec -i mcp-notes-pg-verify psql -X -q -tA -v ON_ERROR_STOP=1 -U postgres -d "$(cat "$DIR/db")" \
    | sed '/^BEGIN$/d;/^ROLLBACK$/d'
}
dead() { printf 'dead%036d' "$1"; } # an info hash nobody seeds
index_asks() { if [ -f "$TOR/index.jsonl" ]; then grep -c '"path":"/stream/' "$TOR/index.jsonl" || true; else echo 0; fi; }
torrent_attempts() { jq -c '[.attempts[] | select(.provider | startswith("Torrent: ")) | [.outcome, .detail]]' <<<"$1"; }
# check_idle: scripts/install.sh's own check, asked of this run instead of the live daemon. Sets IDLE_CODE, IDLE_OUT.
check_idle() {
  set +e
  IDLE_OUT="$(bash -c 'source "$1"; NODE_BIN="$(command -v node)"; PLAYER_URL="$2"; check_idle' _ "$ROOT/scripts/install.sh" "$URL/api/movies/player" 2>&1)"
  IDLE_CODE=$?
  set -e
  printf '$ install.sh check_idle (PLAYER_URL=%s)\nexit %s\n%s\n' "$URL/api/movies/player" "$IDLE_CODE" "$IDLE_OUT" >>"$EV/speed-check-idle.txt"
}

stage_race() {
  stage race
  local live started took body
  live="$(seed bare-service)"
  jq -nc --arg d "$(dead 1)" --arg l "$live" \
    '[{info_hash: $d, name: "1080p.WEB.x264-DEAD", seeds: 900, size_bytes: 1500000}, {info_hash: $l, name: "1080p.WEB.x264-LIVE", seeds: 5, size_bytes: 1500000}]' >"$TOR/candidates.json"
  echo ok >"$TOR/index-mode"
  started=$(now_ms)
  api POST /api/stream/play '{"kind":"movie","tmdb_id":990001,"provider":"torrent"}'
  took=$(( $(now_ms) - started ))
  [ "$CODE" = 200 ] || fail "the play answered $CODE: $BODY"
  body="$BODY"
  printf '%s\n' "$body" >"$EV/speed-race-play.json"
  [ "$(jq -r .session.torrent.info_hash <<<"$body")" = "$live" ] || fail "the session plays $(jq -c .session.torrent <<<"$body"), not the live swarm"
  [ "$took" -lt 15000 ] || fail "the play took $took ms: the dead swarm listed first was waited for"
  [ "$(jq -r '[.attempts[] | select(.provider | endswith("-DEAD"))][0] | [.outcome, (.detail | startswith("still opening when"))] | join(" ")' <<<"$body")" = "skipped true" ] \
    || fail "the dead swarm's attempt is $(torrent_attempts "$body")"
  jq -e '[.attempts[] | select(.provider | endswith("-LIVE"))][0] | .outcome == "resolved" and (.detail | test("5 seeds listed; 1 peer connected, [0-9.]+ Mbps"))' <<<"$body" >/dev/null \
    || fail "the played torrent's attempt does not name its peers and rate: $(torrent_attempts "$body")"
  sleep 2
  api GET /api/stream/torrent
  [ "$(jq -c '[.swarm[].info_hash]' <<<"$BODY")" = "[\"$live\"]" ] || fail "the daemon holds $(jq -c '[.swarm[] | [.info_hash, .users]]' <<<"$BODY"), not the played torrent alone"
  ok "a dead swarm listed first (900 seeds) and a live one (5): the live one played after $took ms, the dead one skipped while still opening, and only the played torrent is in the swarm"
  grep -E "1080p\.WEB\.x264-DEAD \($(dead 1 | cut -c1-8)\) lost: still opening \(.*\) when [^ ]*1080p\.WEB\.x264-LIVE was chosen" "$DIR/daemon.log" >"$EV/speed-race-lost.log" \
    || fail "the daemon's log does not say why the dead swarm lost"
  ok "the daemon's log names why the dead one lost: $(head -1 "$EV/speed-race-lost.log" | sed 's/^.*lost: /lost: /')"
  [ "$(q "select count(*) from stream_torrents where info_hash = '$(dead 1)'")" = 0 ] || fail "the dead swarm, which never sent a file list, has a stream_torrents row"
  [ "$(q "select coalesce(played_at::text, 'null') from stream_torrents where info_hash = '$live'")" = null ] || fail "the live torrent's row is missing or already played before any position report: $(q "select info_hash, played_at from stream_torrents")"
  api POST "/api/stream/sessions/$(jq -r .session.session_id <<<"$body")/position" '{"position_s":1,"duration_s":60}'
  [ "$CODE" = 200 ] || fail "the position report answered $CODE: $BODY"
  [ "$(q "select played_at is not null from stream_torrents where info_hash = '$live'")" = t ] || fail "the first position report did not set played_at"
  q "select info_hash, name, state, played_at from stream_torrents" >"$EV/speed-race-rows.txt"
  ok "no stream_torrents row for the dead swarm; the live one's played_at was null until the page's first position report set it"
  api POST "/api/stream/sessions/$(jq -r .session.session_id <<<"$body")/position" '{"position_s":1,"closed":true}'
}

stage_heights() {
  stage heights
  local h720 h1080 body played
  h720="$(seed bare-quiet)"
  h1080="$(seed bare-hi)"
  jq -nc --arg a "$h720" --arg b "$h1080" \
    '[{info_hash: $a, name: "720p.WEB.x264-LOW", seeds: 900, size_bytes: 1500000}, {info_hash: $b, name: "1080p.WEB.x264-HIGH", seeds: 5, size_bytes: 1500000}]' >"$TOR/candidates.json"
  echo ok >"$TOR/index-mode"
  api POST /api/stream/play '{"kind":"movie","tmdb_id":990004,"provider":"torrent"}'
  [ "$CODE" = 200 ] || fail "the play answered $CODE: $BODY"
  body="$BODY"
  printf '%s\n' "$body" >"$EV/speed-heights-play.json"
  played="$(jq -r .session.torrent.info_hash <<<"$body")"
  grep -E "x264-(LOW|HIGH) \([0-9a-f]{8}\) lost: |preferred height" "$DIR/daemon.log" >"$EV/speed-heights-lost.log" || true
  if [ "$played" = "$h1080" ]; then
    jq -e '[.attempts[] | select(.provider | endswith("-LOW"))][0] | .outcome == "skipped" and (.detail | test("was chosen"))' <<<"$body" >/dev/null \
      || fail "the 720p's attempt does not say it lost to the 1080p: $(torrent_attempts "$body")"
    grep -q "x264-LOW (${h720:0:8}) lost: .*1080p.WEB.x264-HIGH was chosen" "$EV/speed-heights-lost.log" || fail "the daemon's log does not say why the 720p lost"
    ok "720p listed first with 900 seeds, 1080p with 5: the 1080p played; $(grep -o 'lost: .*' "$EV/speed-heights-lost.log" | head -1)"
  elif [ "$played" = "$h720" ]; then
    ok "INCONCLUSIVE: only the 720p's swarm delivered from the loopback seeder, so it played (a swarm that delivers comes before height): $(torrent_attempts "$body")"
  else
    fail "the session plays $(jq -c .session.torrent <<<"$body")"
  fi
  api POST "/api/stream/sessions/$(jq -r .session.session_id <<<"$body")/position" '{"position_s":1,"closed":true}'
}

stage_subtitles() {
  stage subtitles
  local hash started took sid body
  hash="$(seed bare-byid)"
  jq -nc --arg h "$hash" '[{info_hash: $h, name: "1080p.WEB.x264-bare-byid", seeds: 500, size_bytes: 1500000}]' >"$TOR/candidates.json"
  echo ok >"$TOR/index-mode"
  printf 'wyzie\n' >"$SUBS/mode"
  printf '4000\n' >"$SUBS/delay-ms"
  started=$(now_ms)
  api POST /api/stream/play '{"kind":"movie","tmdb_id":990003,"provider":"torrent"}'
  took=$(( $(now_ms) - started ))
  [ "$CODE" = 200 ] || fail "the play answered $CODE: $BODY"
  body="$BODY"
  printf '%s\n' "$body" >"$EV/speed-subtitles-play.json"
  sid="$(jq -r .session.session_id <<<"$body")"
  # Wyzie's list and its file are each 4 s late: a play that waited for them would take more than 8 s.
  [ "$took" -lt 7000 ] || fail "the play took $took ms: it waited for the subtitle service (8 s late in all)"
  jq -e '[.attempts[] | select(.provider == "Subtitles: pending")] | length == 1 and .[0].outcome == "skipped"' <<<"$body" >/dev/null || fail "the answer has no Subtitles: pending attempt: $(jq -c '[.attempts[] | [.provider, .outcome]]' <<<"$body")"
  [ "$(jq -c '[(.session.subtitles | length), .session.subtitle_rev]' <<<"$body")" = "[0,0]" ] || fail "the answer already holds a subtitle: $(jq -c '[.session.subtitles, .session.subtitle_rev]' <<<"$body")"
  ok "the play answered after $took ms with Subtitles: pending, no subtitle yet (the service needs 8 s; the play waited $(jq -r '[.attempts[] | select(.provider == "Subtitles: pending")][0].took_s' <<<"$body") s for it)"
  for _ in $(seq 1 120); do
    BODY="$(curl -sS "$URL/api/stream/sessions/$sid")"
    [ "$(jq -r .subtitle_rev <<<"$BODY")" = 1 ] && break
    sleep 0.25
  done
  printf '%s\n' "$BODY" >"$EV/speed-subtitles-session.json"
  [ "$(jq -r '[(.subtitle_rev | tostring), .subtitles[0].label, .subtitles[0].url] | join(" ")' <<<"$BODY")" = "1 English (Wyzie) /api/stream/torrent/$hash/sub/service-wyzie-7001.vtt" ] \
    || fail "the session's subtitle after the chain is $(jq -c '[.subtitle_rev, .subtitles]' <<<"$BODY")"
  curl -sS "$URL/api/stream/torrent/$hash/sub/service-wyzie-7001.vtt" | grep -q 'Wyzie subtitle line' || fail "the subtitle route does not serve Wyzie's file"
  api POST "/api/stream/sessions/$sid/position" '{"position_s":3,"duration_s":60}'
  [ "$(jq -r .subtitle_rev <<<"$BODY")" = 1 ] || fail "the position report answered $BODY, not subtitle_rev 1"
  grep -q "subtitles of ${hash:0:8} arrived" "$DIR/daemon.log" || fail "the daemon's log does not say the subtitles arrived"
  ok "behind the play the session got English (Wyzie) with subtitle_rev 1, which the answer to the page's position report carries"
  rm -f "$SUBS/delay-ms"
  printf 'ok\n' >"$SUBS/mode"
  api POST "/api/stream/sessions/$sid/position" '{"position_s":3,"closed":true}'
}

stage_pending() {
  stage pending
  local first started took
  jq -nc --arg a "$(dead 11)" --arg b "$(dead 12)" --arg c "$(dead 13)" --arg d "$(dead 14)" --arg e "$(dead 15)" --arg f "$(dead 16)" \
    '[$a, $b, $c, $d, $e, $f] | to_entries | map({info_hash: .value, name: "1080p.WEB.x264-DEAD\(.key + 1)", seeds: (600 - .key), size_bytes: 1500000})' >"$TOR/candidates.json"
  echo slow:9000 >"$TOR/index-mode"
  check_idle
  [ "$IDLE_CODE" = 0 ] || fail "check_idle exited $IDLE_CODE before the play: $IDLE_OUT"
  first="$EV/speed-pending-first.json"
  started=$(now_ms)
  ( cd "$ROOT" && "$V" mcp "$RUN" direct_stream_play '{"title":"movie-990002","provider":"torrent"}' 2>/dev/null | sed '1d;/^< ERROR$/d' >"$first"; echo $(( $(now_ms) - started )) >"$first.ms" ) &
  local caller=$!
  sleep 14
  BODY="$(curl -sS "$URL/api/movies/player")"
  printf '%s\n' "$BODY" >"$EV/speed-pending-player.json"
  [ "$(jq -c '[.stream, .busy, (.starting | length)]' <<<"$BODY")" = "[null,true,1]" ] || fail "GET /api/movies/player during the play is $BODY"
  [ "$(jq -r '.starting[0] | [.title, .provider, (.stage | startswith("opening 3 torrents"))] | join("|")' <<<"$BODY")" = "The Dog Stars (2026)|torrent|true" ] || fail "starting is $(jq -c .starting <<<"$BODY")"
  check_idle
  [ "$IDLE_CODE" = 75 ] || fail "check_idle exited $IDLE_CODE while a play was being started: $IDLE_OUT"
  grep -q 'a play of The Dog Stars (2026) is being started' <<<"$IDLE_OUT" || fail "check_idle did not name the play: $IDLE_OUT"
  ok "while the play is being started: stream null, busy true, starting names it ($(jq -r '.starting[0].stage' <<<"$BODY" | cut -c1-40)...), and install.sh's check exits 75"
  wait "$caller"
  took="$(cat "$first.ms")"
  BODY="$(cat "$first")"
  [ "$(jq -c '[.started, .pending]' <<<"$BODY")" = "[false,true]" ] || fail "the first call answered $BODY"
  [ "$took" -ge 44000 ] && [ "$took" -lt 58000 ] || fail "the first call answered after $took ms, not about 45 s"
  jq -e '(.stage | startswith("opening 3 torrents")) and ([.attempts[] | select(.provider == "Index: torrentio" and .outcome == "resolved")] | length == 1) and ([.attempts[] | select(.outcome == "no_stream")] | length == 3)' <<<"$BODY" >/dev/null \
    || fail "the pending answer does not say where the play stands: $(jq -c '[.stage, [.attempts[] | [.provider, .outcome]]]' <<<"$BODY")"
  ok "direct_stream_play answered after $took ms: pending, stage [$(jq -r .stage <<<"$BODY" | cut -c1-60)...], $(jq '.attempts | length' <<<"$BODY") attempts so far"
  local resolves
  resolves="$(index_asks)"
  mcp direct_stream_play '{"title":"movie-990002","provider":"torrent"}'
  printf '%s\n' "$BODY" >"$EV/speed-pending-second.json"
  [ "$(jq -c '[.error, .started, (.attempts | length), ([.attempts[] | select(.outcome == "no_stream")] | length), .attempts[-1].provider]' <<<"$BODY")" = '["no_source",false,8,6,"Torrents: not tried yet"]' ] || fail "the second call answered $BODY"
  [ "$(index_asks)" = "$resolves" ] || fail "the second call asked the index again: it started a second play"
  grep -q 'play of TMDB movie 990002 (torrent) started nothing after .* s: no_source, 8 attempt(s)' "$DIR/daemon.log" || fail "the daemon's log does not hold the failed play"
  [ "$(grep -c 'direct stream:   attempt Torrent: .*-DEAD[1-6]: no_stream' "$DIR/daemon.log")" = 6 ] || fail "the daemon's log does not hold the six torrent attempts"
  grep 'started nothing\|direct stream:   attempt' "$DIR/daemon.log" >"$EV/speed-pending-daemon-log.txt"
  ok "the same call again joined the play (no new index request) and answered no_source with all 8 attempts (the last Torrents: not tried yet), which the daemon's log holds too"
  BODY="$(curl -sS "$URL/api/movies/player")"
  [ "$(jq -c '[.busy, (.starting | length)]' <<<"$BODY")" = "[false,0]" ] || fail "after the play the player route says $BODY"
  check_idle
  [ "$IDLE_CODE" = 0 ] || fail "check_idle exited $IDLE_CODE after the play: $IDLE_OUT"
  ok "afterwards starting is empty, busy false, and install.sh's check exits 0"
  echo ok >"$TOR/index-mode"
}

stage_index() {
  stage index
  local n mode asks started took
  jq -nc --arg a "$(dead 21)" '[{info_hash: $a, name: "1080p.WEB.x264-DEAD", seeds: 600, size_bytes: 1500000}]' >"$TOR/candidates.json"
  echo empty >"$DIR/torrent-sites/mode"
  n=0
  for mode in hang error error; do
    n=$((n + 1))
    echo "$mode" >"$TOR/index-mode"
    api POST /api/stream/play '{"kind":"movie","tmdb_id":467905,"provider":"torrent"}'
    [ "$CODE" = 502 ] || fail "play $n answered $CODE: $BODY"
    [ "$(jq -r '[.attempts[] | select(.provider == "Index: torrentio")][0].outcome' <<<"$BODY")" = error ] || fail "play $n: the index attempt is $(jq -c .attempts <<<"$BODY")"
    if [ "$mode" = hang ]; then
      jq -e '[.attempts[] | select(.provider == "Index: torrentio")][0] | (.detail | startswith("timed out after")) and .took_s >= 9' <<<"$BODY" >/dev/null || fail "the hanging index did not time out: $(jq -c .attempts <<<"$BODY")"
    fi
  done
  ok "the index failed three plays in a row (a timeout, then two HTTP 500): Index: torrentio error each time"
  echo ok >"$TOR/index-mode"
  asks="$(index_asks)"
  started=$(now_ms)
  api POST /api/stream/play '{"kind":"movie","tmdb_id":467905,"provider":"torrent"}'
  took=$(( $(now_ms) - started ))
  printf '%s\n' "$BODY" >"$EV/speed-index-skipped.json"
  [ "$(jq -r '[.attempts[] | select(.provider == "Index: torrentio")][0] | [.outcome, .detail] | join("|")' <<<"$BODY")" = "skipped|not asked: it failed or timed out 3 times in a row; asked again in 30 min" ] \
    || fail "the fourth play's index attempt is $(jq -c .attempts <<<"$BODY")"
  [ "$(index_asks)" = "$asks" ] || fail "the fourth play asked the index"
  [ "$took" -lt 5000 ] || fail "the fourth play took $took ms"
  ok "the fourth play left the index out (skipped, with the reason), sent it no request and answered after $took ms"
  echo rows >"$DIR/torrent-sites/mode"
}

for s in "${WANTED[@]}"; do
  case "$s" in
    race) stage_race ;;
    heights) stage_heights ;;
    subtitles) stage_subtitles ;;
    pending) stage_pending ;;
    index) stage_index ;;
    *) fail "unknown stage $s" ;;
  esac
done
echo "speed: PASS (${WANTED[*]})"
"$V" note "$RUN" "torrent speed PASS (${WANTED[*]})"
