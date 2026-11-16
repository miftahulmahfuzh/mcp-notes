#!/usr/bin/env bash
# torrent.sh RUN [fallback|named|replay|dubbed|pack|off ...]: torrent phase 3's journeys on a throwaway daemon.
# On a `verify.sh up --web --torrent` run (phase 1's loopback fixture torrent, the fake index, the fake resolver):
#   fallback  the fake resolver answers no_source; POST /api/stream/play of How to Make a Killing (TMDB movie 467905)
#             answers 200 from the torrent: provider Torrent, manifest_url the fixture's file route, attempts = the
#             cloud's, then "Index: torrentio", then "Torrent: <release>" resolved (then its "Subtitles: <tier>"
#             attempts); exactly one more resolve ran.
#   named     direct_stream_play over MCP with provider "torrent" for The Dog Stars (movie-990002) while the fake
#             resolver would answer (mode hls): started true, provider Torrent, no resolve ran, one more open naming
#             the session's page, and bytes 0-99 of manifest_url answer 206 with exactly 100 bytes.
#             The session id is kept in $RUN/torrent-journey/sid for torrent-play.steps.mjs.
#   replay    waits until the fixture is whole on disk, closes every session this script made (a closed position
#             report), waits until the daemon holds no peer of it, sets the fake index to answer HTTP 500, and plays
#             467905 again: 200 with no "Index: "/"Torrent: " attempt, torrent.state ready, no new index request, no
#             new resolve, still no peer, and the daemon's log says "from disk".
#   dubbed    Oldboy (TMDB movie 990004, original language ko) with provider torrent: 502 no_source, and its torrent
#             attempt is dubbed (the fixture's audio is English).
#   pack      MobLand (TMDB tv 247718) S01E02 with provider torrent: the session's torrent.file_index is the pack's
#             S01E02 file (phase 1's pack.json lists the files) and manifest_url ends in /f/<that index>.
# On a `verify.sh up --direct-stream` run (torrents off):
#   off       provider torrent answers 503 torrent_off and runs no resolve; a play without provider on a no_source
#             resolver answers 502 no_source whose attempts name no index and no torrent.
# No stage named: fallback named replay dubbed pack on a --torrent run, off otherwise. Ends with
# `torrent: PASS (<stages>)`; the first failed check stops it with `torrent: FAIL at <stage>`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: torrent.sh RUN [fallback|named|replay|dubbed|pack|off ...]}
shift
WANTED=("$@")
DIR="$VERIFY_HOME/$RUN"
DIRECT="$DIR/direct"
TOR="$DIR/torrent"
J="$DIR/torrent-journey"
[ -s "$DIRECT/upstream.json" ] || { echo "torrent: $RUN was not started with --direct-stream" >&2; exit 2; }
if [ ${#WANTED[@]} -eq 0 ]; then
  if [ -s "$TOR/index.port" ]; then WANTED=(fallback named replay dubbed pack); else WANTED=(off); fi
fi
ROOT="$(sed -n 's/^repo=//p' "$DIR/meta")"
URL="http://127.0.0.1:$(cat "$DIR/port")"
mkdir -p "$J"
STAGE=start
CODE=""
BODY=""

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "torrent journey $STAGE: $*"; }
fail() {
  echo "torrent: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "torrent journey FAIL at $STAGE: $*" || true
  exit 1
}
# api METHOD PATH [JSON]: through verify.sh (evidence saved, same-origin Origin sent); sets CODE and BODY.
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
# mcp TOOL JSON: through verify.sh (evidence saved); sets BODY to the tool's JSON answer.
mcp() {
  local out
  out="$(cd "$ROOT" && "$V" mcp "$RUN" "$1" "$2" 2>/dev/null || true)"
  BODY="$(sed '1d;/^< ERROR$/d' <<<"$out")"
}
calls_of() { if [ -f "$DIRECT/calls.jsonl" ]; then jq -s --arg v "$1" '[.[] | select(.args[0] == $v)] | length' "$DIRECT/calls.jsonl"; else echo 0; fi; }
index_asks() { if [ -f "$TOR/index.jsonl" ]; then wc -l <"$TOR/index.jsonl" | tr -d ' '; else echo 0; fi; }
need_torrent() { [ -s "$TOR/index.port" ] || fail "$RUN was not started with --torrent"; }
keep_sid() { echo "$1" >"$J/sid"; echo "$1" >>"$J/sids"; }
HASH() { jq -r .info_hash "$TOR/fixture.json"; }
peers() { curl -sS "$URL/api/stream/torrent/$(HASH)" | jq -r '.peers // 0'; }

for s in "${WANTED[@]}"; do
  case "$s" in
    fallback)
      stage fallback
      need_torrent
      echo no_source >"$DIRECT/mode"
      echo ok >"$TOR/index-mode"
      before=$(calls_of resolve)
      api POST /api/stream/play '{"kind":"movie","tmdb_id":467905}'
      [ "$CODE" = 200 ] || fail "play answered $CODE: $BODY"
      [ "$(jq -r .session.provider <<<"$BODY")" = Torrent ] || fail "provider is $(jq -r .session.provider <<<"$BODY")"
      [ "$(jq -r .session.torrent.info_hash <<<"$BODY")" = "$(HASH)" ] || fail "torrent is $(jq -c .session.torrent <<<"$BODY")"
      [[ "$(jq -r .session.manifest_url <<<"$BODY")" == "/api/stream/torrent/$(HASH)/f/"* ]] || fail "manifest_url is $(jq -r .session.manifest_url <<<"$BODY")"
      order="$(jq -r '[.attempts[] | (if (.provider | startswith("Index: ")) then "I" elif (.provider | startswith("Torrent: ")) then "T" elif (.provider | startswith("Subtitles: ")) then "S" else "C" end)] | join("")' <<<"$BODY")"
      [[ "$order" =~ ^C+I+T+S*$ ]] || fail "attempts are not cloud, then index, then torrent: $(jq -c '[.attempts[] | [.provider, .outcome]]' <<<"$BODY")"
      [ "$(jq -r '[.attempts[] | select(.provider | startswith("Torrent: "))][-1].outcome' <<<"$BODY")" = resolved ] || fail "the last torrent attempt did not resolve"
      [ "$(calls_of resolve)" = $((before + 1)) ] || fail "expected exactly one cloud resolve"
      keep_sid "$(jq -r .session.session_id <<<"$BODY")"
      ok "no_source fell through to the torrent $(HASH); attempts $order"
      ;;
    named)
      stage named
      need_torrent
      echo hls >"$DIRECT/mode"
      before=$(calls_of resolve)
      opens=$(calls_of open)
      mcp direct_stream_play '{"title":"movie-990002","provider":"torrent"}'
      [ "$(jq -r .started <<<"$BODY")" = true ] || fail "direct_stream_play did not start: $BODY"
      [ "$(jq -r .play.session.provider <<<"$BODY")" = Torrent ] || fail "provider is $(jq -r .play.session.provider <<<"$BODY")"
      [ "$(calls_of resolve)" = "$before" ] || fail "a cloud resolve ran for a play that named the torrent provider"
      [ "$(calls_of open)" = $((opens + 1)) ] || fail "the player page was not opened"
      sid="$(jq -r .play.session.session_id <<<"$BODY")"
      jq -e --arg sid "$sid" 'select(.args[0] == "open") | select(.args[1] | endswith("/stream/" + $sid))' "$DIRECT/calls.jsonl" >/dev/null || fail "no open named /stream/$sid"
      manifest="$(jq -r .play.session.manifest_url <<<"$BODY")"
      code="$(curl -sS -o "$J/range.bin" -w '%{http_code}' -H 'Range: bytes=0-99' "$URL$manifest")"
      [ "$code" = 206 ] && [ "$(wc -c <"$J/range.bin" | tr -d ' ')" = 100 ] || fail "bytes 0-99 of $manifest answered $code with $(wc -c <"$J/range.bin") bytes"
      keep_sid "$sid"
      ok "provider torrent played $manifest (206, 100 bytes), no resolve, the page opened"
      ;;
    replay)
      stage replay
      need_torrent
      for _ in $(seq 1 120); do [ "$(curl -sS "$URL/api/stream/torrent/$(HASH)" | jq -r .state)" = ready ] && break; sleep 1; done
      [ "$(curl -sS "$URL/api/stream/torrent/$(HASH)" | jq -r .state)" = ready ] || fail "the fixture is not whole on disk after 120 s"
      while read -r sid; do
        [ -n "$sid" ] && api POST "/api/stream/sessions/$sid/position" '{"position_s":5,"closed":true}'
      done <"$J/sids"
      for _ in $(seq 1 30); do [ "$(peers)" = 0 ] && break; sleep 1; done
      [ "$(peers)" = 0 ] || fail "the daemon still has $(peers) peer(s) of the fixture after every session closed"
      echo error >"$TOR/index-mode"
      echo no_source >"$DIRECT/mode"
      asks=$(index_asks)
      before=$(calls_of resolve)
      api POST /api/stream/play '{"kind":"movie","tmdb_id":467905}'
      [ "$CODE" = 200 ] || fail "the second play answered $CODE: $BODY"
      [ "$(jq '[.attempts[] | select(.provider | test("^(Index|Torrent): "))] | length' <<<"$BODY")" = 0 ] || fail "attempts name an index or a torrent: $(jq -c .attempts <<<"$BODY")"
      [ "$(jq -r .session.torrent.state <<<"$BODY")" = ready ] || fail "torrent is $(jq -c .session.torrent <<<"$BODY")"
      [ "$(index_asks)" = "$asks" ] || fail "an index was asked"
      [ "$(calls_of resolve)" = "$before" ] || fail "a cloud resolve ran"
      sleep 3
      [ "$(peers)" = 0 ] || fail "the replay joined the swarm ($(peers) peers)"
      grep -q "from the torrent .*from disk" "$DIR/daemon.log" || fail "the daemon's log has no 'from disk' play"
      keep_sid "$(jq -r .session.session_id <<<"$BODY")"
      echo ok >"$TOR/index-mode"
      ok "the second play came from disk: no index or torrent attempt, state ready, no index request, no resolve, no peer"
      ;;
    dubbed)
      stage dubbed
      need_torrent
      echo no_source >"$DIRECT/mode"
      echo ok >"$TOR/index-mode"
      api POST /api/stream/play '{"kind":"movie","tmdb_id":990004,"provider":"torrent"}'
      [ "$CODE" = 502 ] && [ "$(jq -r .error <<<"$BODY")" = no_source ] || fail "Oldboy answered $CODE: $BODY"
      [ "$(jq -r '[.attempts[] | select(.provider | startswith("Torrent: "))][0].outcome' <<<"$BODY")" = dubbed ] || fail "the torrent attempt is not dubbed: $(jq -c .attempts <<<"$BODY")"
      ok "Oldboy (ko): $(jq -r '[.attempts[] | select(.provider | startswith("Torrent: "))][0].detail' <<<"$BODY")"
      ;;
    pack)
      stage pack
      need_torrent
      [ -s "$TOR/pack.json" ] || fail "phase 1's --torrent mode wrote no pack.json"
      want="$(jq -r '[.files[] | select(.path | test("S01E02"; "i"))][0].index' "$TOR/pack.json")"
      api POST /api/stream/play '{"kind":"tv","tmdb_id":247718,"season":1,"episode":2,"provider":"torrent"}'
      [ "$CODE" = 200 ] || fail "MobLand S01E02 answered $CODE: $BODY"
      [ "$(jq -r .session.torrent.file_index <<<"$BODY")" = "$want" ] || fail "file_index is $(jq -r .session.torrent.file_index <<<"$BODY"), the S01E02 file is $want"
      [[ "$(jq -r .session.manifest_url <<<"$BODY")" == */f/"$want" ]] || fail "manifest_url is $(jq -r .session.manifest_url <<<"$BODY")"
      keep_sid "$(jq -r .session.session_id <<<"$BODY")"
      ok "the pack's S01E02 file (index $want) plays"
      ;;
    off)
      stage off
      [ ! -s "$TOR/index.port" ] || fail "$RUN is a --torrent run; off needs a plain --direct-stream run"
      before=$(calls_of resolve)
      api POST /api/stream/play '{"kind":"movie","tmdb_id":467905,"provider":"torrent"}'
      [ "$CODE" = 503 ] && [ "$(jq -r .error <<<"$BODY")" = torrent_off ] || fail "provider torrent answered $CODE: $BODY"
      [ "$(calls_of resolve)" = "$before" ] || fail "a resolve ran"
      echo no_source >"$DIRECT/mode"
      api POST /api/stream/play '{"kind":"movie","tmdb_id":467905}'
      [ "$CODE" = 502 ] && [ "$(jq -r .error <<<"$BODY")" = no_source ] || fail "the plain play answered $CODE: $BODY"
      [ "$(jq '[.attempts[] | select(.provider | test("^(Index|Torrent): "))] | length' <<<"$BODY")" = 0 ] || fail "attempts name an index or a torrent: $(jq -c .attempts <<<"$BODY")"
      ok "torrent_off, and no_source without any index or torrent attempt"
      ;;
    *) fail "unknown stage $s" ;;
  esac
done
echo "torrent: PASS (${WANTED[*]})"
"$V" note "$RUN" "torrent journey PASS (${WANTED[*]})"
