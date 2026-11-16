#!/usr/bin/env bash
# codenames.sh RUN: the ten requests the watch codenames were written for
# (.workflows/plan/WATCH_CODENAMES_BRIEF.md), each traced to the MCP tool calls that answer it, on a
# `verify.sh up --discovery --torrent` run. The script stands in for the model: it makes the calls
# the /direct-stream skill names, picks from the answers the way the skill says, and checks what
# came back. Every call and its output is saved as evidence by verify.sh.
#
# TM and TS are `provider: "torrent"`. The loopback fixture is one English film, so one request
# plays for real from it (2: Karate Kid: Legends); for the others the fake index lists nothing, and
# the check is that the answer is `no_source` from the torrent source alone: the title and episode
# chosen, the index asked by the right address, and no cloud resolve. NTM and NTS are
# `provider: "cloud"`: checked both ways at the end (it plays from the fake resolver; and when the
# resolver has nothing, no index is asked). Never a real index, swarm, provider, Chrome or TMDB.
# The first failed check stops it with `codenames: FAIL at <request>`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: codenames.sh RUN}
DIR="$VERIFY_HOME/$RUN"
DIRECT="$DIR/direct"
TOR="$DIR/torrent"
[ -s "$DIRECT/upstream.json" ] || { echo "codenames: $RUN was not started with --discovery" >&2; exit 2; }
grep -q -- '--extra' "/proc/$(cat "$DIR/tmdb.pid")/cmdline" 2>/dev/null || { echo "codenames: $RUN was started without --discovery" >&2; exit 2; }
[ -s "$TOR/index.port" ] || { echo "codenames: $RUN was started without --torrent" >&2; exit 2; }
YEAR="$(date +%Y)"
STAGE=start
OUT=""

stage() { STAGE=$1; echo "== $STAGE"; "$V" note "$RUN" "codenames request $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "codenames $STAGE: $*"; }
fail() {
  echo "codenames: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "codenames FAIL at $STAGE: $*" || true
  exit 1
}
# mcp TOOL JSON: one tool call through verify.sh (saved as evidence); OUT is the tool's JSON answer.
mcp() {
  local raw
  raw="$("$V" mcp "$RUN" "$1" "$2" 2>/dev/null)" || fail "$1 $2 answered an error: $(tail -n +2 <<<"$raw" | head -c 400)"
  OUT="$(tail -n +2 <<<"$raw")"
}
# mcp_error TOOL JSON: the same for a call that must answer an error; OUT is the error's JSON.
mcp_error() {
  local raw
  raw="$("$V" mcp "$RUN" "$1" "$2" 2>/dev/null || true)"
  grep -q '^< ERROR$' <<<"$raw" || fail "$1 $2 did not answer an error (got: $(tail -n +2 <<<"$raw" | head -c 300))"
  OUT="$(sed '1d;/^< ERROR$/d' <<<"$raw")"
}
# want JQ-FILTER WHAT: the filter must be true of OUT.
want() { jq -e "$1" >/dev/null <<<"$OUT" || fail "$2 (got: $(jq -c . <<<"$OUT" 2>/dev/null | head -c 700 || head -c 700 <<<"$OUT"))"; }
# The title key the model would pick: the first listed title not seen and not marked not interested.
pick() { jq -r '[.titles[] | select(.seen | not) | select(.not_interested | not)][0].title_key' <<<"$OUT"; }
resolves() { if [ -f "$DIRECT/calls.jsonl" ]; then jq -s '[.[] | select(.args[0] == "resolve")] | length' "$DIRECT/calls.jsonl"; else echo 0; fi; }
index_asks() { if [ -f "$TOR/index.jsonl" ]; then wc -l <"$TOR/index.jsonl" | tr -d ' '; else echo 0; fi; }
last_index_path() { tail -n 1 "$TOR/index.jsonl" | jq -r .path; }
# The IMDb id the fake TMDB hands out for a title key (tt + the TMDB id padded to 7 digits).
imdb_of() { printf 'tt%07d' "${1#*-}"; }
# torrent_only ARGS-JSON INDEX-PATH WHAT: a play with provider "torrent" while the fake index lists nothing. The
# answer must be no_source from the torrent source alone (index attempts only, no cloud provider), the index must
# have been asked by INDEX-PATH, and no cloud resolve may have run.
torrent_only() {
  local before_resolves before_asks
  before_resolves="$(resolves)"
  before_asks="$(index_asks)"
  echo empty >"$TOR/index-mode"
  mcp_error direct_stream_play "$1"
  want '.error == "no_source" and .started == false and (.attempts[0].provider == "Index: torrentio") and all(.attempts[]; .provider | startswith("Index: "))' "$3: no_source from the torrent source alone (only indexes asked)"
  [ "$(resolves)" = "$before_resolves" ] || fail "$3: a cloud resolve ran for a torrent-only play"
  [ "$(index_asks)" -gt "$before_asks" ] || fail "$3: the torrent index was not asked"
  [ "$(last_index_path)" = "$2" ] || fail "$3: the index was asked by $(last_index_path), not $2"
}

echo hls >"$DIRECT/mode"
# The sites asked when the JSON indexes list nothing (1337x, ext.to; a fake script) list nothing either.
echo empty >"$DIR/torrent-sites/mode"

stage "1 play some chinese action movie TM"
mcp direct_stream_discover '{"kind":"movie","language":"Chinese","genre":"action"}'
want '.filters.language == ["zh","cn"] and .filters.genres == {"movie":[{"id":28,"name":"Action"}]}' "Chinese read as zh and cn, action as the film genre Action"
want '[.titles[] | [.title, .original_language]] == [["The Shadow'"'"'s Edge","zh"],["Iron Lantern","zh"],["Harbour Fists","cn"],["A Legend","zh"],["Panda Plan: The Magical Tribe","zh"]]' "the Mandarin and Cantonese action films, most popular first; not the Chinese drama, not the English action film"
KEY="$(pick)"
torrent_only "{\"title\":\"$KEY\",\"provider\":\"torrent\"}" "/stream/movie/$(imdb_of "$KEY").json" "The Shadow's Edge"
want '.title.title == "The Shadow'"'"'s Edge"' "The Shadow's Edge was the title asked from the torrent source"
ok "discover language Chinese genre action -> $KEY (The Shadow's Edge) -> asked from the torrent source only"

stage "2 TM shadow edge is smooth af. jackie chan's movie before this one"
mcp direct_stream_discover '{"person":"Jackie Chan","role":"cast","kind":"movie","sort":"newest"}'
want '.filters.person.name == "Jackie Chan"' "Jackie Chan"
want '[.titles[] | [.title, .release_date]] == [["Panda Plan: The Magical Tribe","2026-02-17"],["Bay Area Film Concert 2025","2025-09-28"],["The Shadow'"'"'s Edge","2025-08-16"],["Karate Kid: Legends","2025-05-08"],["A Legend","2024-07-05"]]' "his films newest first, each with its full release date"
# The film before The Shadow's Edge: the first released before it where he does not appear as himself.
EDGE="$(jq -r '.titles[] | select(.title == "The Shadow'"'"'s Edge") | .release_date' <<<"$OUT")"
KEY="$(jq -r --arg d "$EDGE" '[.titles[] | select(.release_date < $d) | select((.roles | join(" ")) | test("Self") | not)][0].title_key' <<<"$OUT")"
[ "$KEY" = "movie-1011477" ] || fail "the film before The Shadow's Edge should be Karate Kid: Legends (movie-1011477), got $KEY"
BEFORE="$(resolves)"
echo ok >"$TOR/index-mode"
mcp direct_stream_play "{\"title\":\"$KEY\",\"provider\":\"torrent\"}"
want '.started == true and .title.title == "Karate Kid: Legends" and .play.session.provider == "Torrent" and (.play.session.torrent.info_hash | test("^[0-9a-f]{40}$"))' "Karate Kid: Legends plays from the loopback torrent"
want '([.play.attempts[].provider | split(":")[0]] | (.[0:2] == ["Index","Torrent"]) and all(.[]; . == "Index" or . == "Torrent" or . == "Subtitles"))' "the attempts are the index, the torrent and its subtitle tiers, no cloud provider"
[ "$(resolves)" = "$BEFORE" ] || fail "a cloud resolve ran for a torrent-only play"
ok "discover person newest -> the film of the same year released before it ($KEY, 2025-05-08) -> playing from a torrent, no cloud resolve"

stage "3 continue OP TS"
# Before: the owner once picked One Piece for the name "OP" (asked_as), and finished seasons 1 to 15.
mcp direct_stream_play '{"title":"tv-37854","asked_as":"OP","season":1,"episode":1,"provider":"cloud"}'
want '.started == true and .play.session.provider != "Torrent"' "One Piece S01E01 from a cloud provider (NTS)"
for s in $(seq 1 15); do mcp movies_mark "{\"title\":\"tv-37854\",\"season\":$s,\"watched\":true}"; done
mcp direct_stream_find '{"title":"OP"}'
want '.status == "one" and .matches[0].title_key == "tv-37854"' "OP finds One Piece"
# TMDB's season 16 starts at episode 629: the torrent index counts within the season, so it is asked for 16:1.
torrent_only '{"title":"OP","provider":"torrent"}' "/stream/series/tt0037854:16:1.json" "One Piece"
want '.title.title == "One Piece" and .season == 16 and .episode == 629 and .picked == "next"' "One Piece carries on at S16E629"
ok "OP -> One Piece, carried on at S16E629 (picked next), asked from the torrent index as 16:1 (the episode's place in its season)"

stage "4 a spanish movie called smth like looking through your window TM"
mcp direct_stream_find '{"title":"looking through your window"}'
want '.status == "none"' "no title has the half-remembered name: the model works the real one out"
torrent_only '{"title":"Through My Window","year":2022,"provider":"torrent"}' "/stream/movie/tt0818647.json" "Through My Window"
want '.title.title == "Through My Window" and .title.original_title == "A través de mi ventana"' "Through My Window (A través de mi ventana)"
ok "the half-remembered name finds nothing; played by its real name and year from the torrent source"

stage "5 one of indonesian horror movie released this year TM"
mcp direct_stream_discover "{\"kind\":\"movie\",\"language\":\"Indonesian\",\"genre\":\"horror\",\"year\":$YEAR}"
want '.filters.language == "id" and ([.titles[].title] == ["Night Offering","The House at the End of the Road"])' "the Indonesian horror films of $YEAR; not last year's, not the comedy, not Joko Anwar's older ones"
KEY="$(pick)"
torrent_only "{\"title\":\"$KEY\",\"provider\":\"torrent\"}" "/stream/movie/$(imdb_of "$KEY").json" "Night Offering"
ok "discover Indonesian horror $YEAR -> $KEY (Night Offering) -> asked from the torrent source only"

stage "6 one of thai comedy movie released on 2025 TM"
mcp direct_stream_discover '{"kind":"movie","language":"Thai","genre":"comedy","year":2025}'
want '.filters.language == "th" and ([.titles[].title] == ["The Red Envelope","Gold Rush Gang"])' "the Thai comedies of 2025; not the 2024 one, not the horror"
KEY="$(pick)"
torrent_only "{\"title\":\"$KEY\",\"provider\":\"torrent\"}" "/stream/movie/$(imdb_of "$KEY").json" "The Red Envelope"
ok "discover Thai comedy 2025 -> $KEY (The Red Envelope) -> asked from the torrent source only"

stage "7 one of Kdrama with bloody action genre TS"
mcp direct_stream_discover '{"kind":"tv","language":"Korean","genre":"action","keyword":["gore","bloody","violence","revenge"]}'
want '.filters.genres == {"tv":[{"id":10759,"name":"Action & Adventure"}]} and ([.filters.keywords[].name] == ["gore","bloody","bloody sunday","violence","revenge"]) and (.filters.keywords_dropped == null)' "action read as Action & Adventure for a series; each word as its keyword and the ones that hold it"
want '[.titles[].title] == ["Red Alley"]' "the one Korean action series that carries a keyword; not the action series without one, not the gory drama, not the English one"
KEY="$(pick)"
torrent_only "{\"title\":\"$KEY\",\"provider\":\"torrent\"}" "/stream/series/$(imdb_of "$KEY"):1:1.json" "Red Alley"
want '.season == 1 and .episode == 1 and .picked == "first"' "Red Alley S01E01"
mcp_error direct_stream_discover '{"kind":"tv","language":"Korean","genre":"horror"}'
grep -q '^invalid_input: TMDB has no series genre called "horror"' <<<"$OUT" || fail "a genre series do not have should be refused with the series genres (got: $(head -c 300 <<<"$OUT"))"
ok "discover Korean series, Action & Adventure, any of four keywords -> $KEY (Red Alley) S01E01 from the torrent source only; horror is refused as a series genre"

stage "8 the most recent park bo yeung project TS"
mcp direct_stream_discover '{"person":"park bo yeung","sort":"newest"}'
want '.filters.person == {"id":83036,"name":"Park Bo-young","known_for":"Acting","asked_as":"park bo yeung"} and ([.other_people[].name] == ["Park Bo-yeon"])' "the misspelt name finds Park Bo-young, with the other near name listed"
want '[.titles[] | [.title, .kind]] == [["The Secret Friends Club","tv"],["Gold Land","tv"],["Our Unwritten Seoul","tv"],["Concrete Utopia","movie"]]' "her films and series together, newest first"
# Her most recent project: the newest entry where she does not appear as herself.
KEY="$(jq -r '[.titles[] | select((.roles | join(" ")) | test("Self") | not)][0].title_key' <<<"$OUT")"
[ "$KEY" = "tv-990871" ] || fail "her most recent project should be Gold Land (tv-990871), got $KEY"
torrent_only "{\"title\":\"$KEY\",\"provider\":\"torrent\"}" "/stream/series/$(imdb_of "$KEY"):1:1.json" "Gold Land"
ok "\"park bo yeung\" -> Park Bo-young; newest entry that is not a talk show -> $KEY (Gold Land) S01E01 from the torrent source only"

stage "9 korean mafia movies, one released this year TM"
mcp direct_stream_discover "{\"kind\":\"movie\",\"language\":\"Korean\",\"genre\":\"crime\",\"keyword\":[\"mafia\",\"gangster\",\"organized crime\"],\"year\":$YEAR}"
want '([.filters.keywords[].name] == ["mafia","sicilian mafia","gangster","organized crime"]) and .filters.keywords_dropped == true' "no Korean crime film of $YEAR carries a mafia keyword: the list is without it, and says so"
want '([.titles[].title] == ["Harbor Kings","The Ledger"]) and (.next | contains("NOT filtered"))' "the Korean crime films of $YEAR, to choose from by overview"
# The model reads the overviews: the one about a crime syndicate.
KEY="$(jq -r '[.titles[] | select(.overview | test("syndicate"))][0].title_key' <<<"$OUT")"
[ "$KEY" = "movie-990841" ] || fail "the syndicate film should be Harbor Kings (movie-990841), got $KEY"
torrent_only "{\"title\":\"$KEY\",\"provider\":\"torrent\"}" "/stream/movie/$(imdb_of "$KEY").json" "Harbor Kings"
mcp direct_stream_discover '{"kind":"movie","language":"Korean","keyword":"mafia"}'
want '([.titles[].title] == ["For the Emperor"]) and (.filters.keywords_dropped == null)' "without the year, the keyword finds the one Korean film that carries it"
ok "keywords matched nothing this year (keywords_dropped) -> chosen by overview: $KEY (Harbor Kings) -> asked from the torrent source only"

stage "10 play House of Dragon season 2 TS"
mcp direct_stream_play '{"title":"House of Dragon","season":2,"provider":"torrent"}'
want '.started == false and .skipped_play == "no_match"' "the name as typed is not the title's: the model passes the real title"
torrent_only '{"title":"House of the Dragon","season":2,"provider":"torrent"}' "/stream/series/tt0094997:2:1.json" "House of the Dragon"
want '.season == 2 and .episode == 1 and .picked == "first"' "a season named without an episode starts at its first episode"
mcp movies_mark '{"title":"tv-94997","season":2,"watched":true}'
torrent_only '{"title":"House of the Dragon","season":2,"provider":"torrent"}' "/stream/series/tt0094997:2:1.json" "House of the Dragon"
want '.season == 2 and .episode == 1 and .picked == "first"' "a season already finished starts again at its first episode"
mcp movies_mark '{"title":"tv-94997","season":2,"watched":false}'
mcp direct_stream_play '{"title":"House of the Dragon","season":7,"provider":"torrent"}'
want '.started == false and .skipped_play == "no_such_season" and ([.seasons[].season] == [1,2])' "season 7 does not exist"
ok "season 2 alone -> S02E01 (picked first), asked from the torrent index as 2:1; a season that does not exist starts nothing"

stage "NTM and NTS: cloud only"
echo ok >"$TOR/index-mode"
ASKS="$(index_asks)"
mcp direct_stream_play '{"title":"Through My Window","year":2022,"provider":"cloud"}'
want '.started == true and .play.session.provider != "Torrent" and .play.session.torrent == null' "NTM plays from a cloud provider"
echo no_source >"$DIRECT/mode"
mcp_error direct_stream_play '{"title":"Night Offering","provider":"cloud"}'
want '.error == "no_source" and ([.attempts[].provider | select(startswith("Index:") or startswith("Torrent:"))] == []) and (.next | contains("no torrent was tried"))' "NTM with no cloud source: no_source, and no torrent tried"
[ "$(index_asks)" = "$ASKS" ] || fail "the torrent index was asked on a cloud-only play"
# The same title with no codename goes on to the torrent source, as before (its audio is English, the film Indonesian: dubbed).
mcp_error direct_stream_play '{"title":"Night Offering"}'
want '.error == "no_source" and ([.attempts[].provider] | index("Index: torrentio") != null)' "without a codename the torrent source is still tried after the cloud"
echo hls >"$DIRECT/mode"
echo rows >"$DIR/torrent-sites/mode"
ok "provider cloud plays from the fake resolver; with no cloud source it answers no_source and asks no index, where a play without a codename goes on to the torrent source"

echo "codenames: PASS (10 requests)"
"$V" note "$RUN" "codenames: PASS (10 requests)"
