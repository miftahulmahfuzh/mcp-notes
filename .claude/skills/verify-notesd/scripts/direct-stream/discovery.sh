#!/usr/bin/env bash
# discovery.sh RUN: the ten requests direct_stream_discover was built for
# (docs/plans/2026-11-16-direct-stream-discovery-brief.md), each traced to the MCP tool calls that
# answer it, on a `verify.sh up --discovery` run. The script stands in for the model: it makes the
# calls the /direct-stream skill names, picks from the answers the way the skill says, and checks
# what came back. Every call and its output is saved as evidence by verify.sh. Plays go to the fake
# resolver (tests/fixtures/direct-stream/fake-cli.mjs): no Chrome, no provider, no TMDB.
# The first failed check stops it with `discovery: FAIL at <request>`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: discovery.sh RUN}
DIR="$VERIFY_HOME/$RUN"
[ -s "$DIR/direct/upstream.json" ] || { echo "discovery: $RUN was not started with --discovery" >&2; exit 2; }
grep -q -- '--extra' "/proc/$(cat "$DIR/tmdb.pid")/cmdline" 2>/dev/null || { echo "discovery: $RUN was started without --discovery" >&2; exit 2; }
YEAR="$(date +%Y)"
STAGE=start
OUT=""

stage() { STAGE=$1; echo "== $STAGE"; "$V" note "$RUN" "discovery request $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "discovery $STAGE: $*"; }
fail() {
  echo "discovery: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "discovery FAIL at $STAGE: $*" || true
  exit 1
}
# mcp TOOL JSON: one tool call through verify.sh (saved as evidence); OUT is the tool's JSON answer.
mcp() {
  local raw
  raw="$("$V" mcp "$RUN" "$1" "$2" 2>/dev/null)" || fail "$1 $2 answered an error: $(tail -n +2 <<<"$raw" | head -c 400)"
  OUT="$(tail -n +2 <<<"$raw")"
}
# want JQ-FILTER WHAT: the filter must be true of OUT.
want() { jq -e "$1" >/dev/null <<<"$OUT" || fail "$2 (got: $(jq -c . <<<"$OUT" | head -c 600))"; }
# The title key the model would pick: the first listed title not seen and not marked not interested.
pick() { jq -r '[.titles[] | select(.seen | not) | select(.not_interested | not)][0].title_key' <<<"$OUT"; }
# play JSON: direct_stream_play must start, on the fake resolver.
play() {
  mcp direct_stream_play "$1"
  want '.started == true and (.play.session.session_id | type == "string")' "direct_stream_play $1 did not start"
}
calls() { wc -l <"$DIR/direct/calls.jsonl" 2>/dev/null | tr -d ' ' || echo 0; }

stage "1 spanish series released this year, pick one"
mcp direct_stream_discover "{\"kind\":\"tv\",\"language\":\"Spanish\",\"year\":$YEAR}"
want '.filters.language == "es" and ([.titles[].title_key] == ["tv-990702","tv-990701"])' "the two Spanish series of $YEAR, most popular first, and not the 2024 one or the English one"
KEY="$(pick)"
play "{\"title\":\"$KEY\"}"
want '.title.title == "Open City" and .season == 1 and .episode == 1 and .picked == "first"' "Open City S01E01"
ok "discover -> $KEY (Open City / Ciudad Abierta) -> S01E01 started"

stage "2 a johnny depp movie, the more recent the better"
mcp direct_stream_discover '{"person":"Johnny Depp","role":"cast","kind":"movie","sort":"newest"}'
want '.filters.person.name == "Johnny Depp" and (.other_people | map(.name) == ["Johnny Deppman"])' "Johnny Depp picked, the other listed"
want '[.titles[].title] == ["Day Drinker","Jeanne du Barry","Pirates of the Caribbean: The Curse of the Black Pearl"]' "his released films newest first, without the 2027 one"
KEY="$(pick)"
play "{\"title\":\"$KEY\"}"
want '.title.title == "Day Drinker"' "Day Drinker"
ok "discover newest first -> $KEY (Day Drinker, 2026) started; the unreleased film was left out"

stage "3 resume one piece from episode 730"
play '{"title":"one piece","absolute_episode":730}'
want '.season == 16 and .episode == 730 and .picked == "absolute" and .absolute_episode == 730' "One Piece S16E730"
ok "absolute episode 730 -> season 16, episode 730 started"

stage "4 rewatch penguin"
mcp direct_stream_find '{"title":"the penguin"}'
want '.status == "one" and .matches[0].kind == "tv"' "The Penguin found as a series"
play '{"title":"the penguin","kind":"tv","season":1,"episode":1}'
want '.title.title == "The Penguin" and .season == 1 and .episode == 1' "The Penguin S01E01"
ok "The Penguin S01E01 started (a rewatch names season 1, episode 1)"

stage "5 the most recent Shudder movie"
mcp direct_stream_discover '{"kind":"movie","service":"Shudder","sort":"newest"}'
want '.filters.service == {"id":99,"name":"Shudder"} and .filters.region == "US" and (.other_services | map(.name) == ["Shudder Amazon Channel"])' "Shudder picked over its Amazon channel"
want '[.titles[].title] == ["Night Shift at the Morgue","The Cellar Door"]' "Shudder films newest first, without the one out in December"
KEY="$(pick)"
play "{\"title\":\"$KEY\"}"
want '.title.title == "Night Shift at the Morgue"' "Night Shift at the Morgue"
ok "discover service Shudder newest -> $KEY started"

stage "6 Blumhouse's movies released this year, play one"
mcp direct_stream_discover "{\"company\":\"Blumhouse\",\"kind\":\"movie\",\"year\":$YEAR}"
want '.filters.company.name == "Blumhouse Productions" and (.other_companies | map(.name) == ["Blumhouse Television"])' "Blumhouse Productions picked, Blumhouse Television listed"
want '([.titles[].title] | (index("Mercy Line") == 0) and (index("The Quiet Floor") != null) and (index("Last Year'"'"'s Haunting") == null)) and all(.titles[]; .release_date[0:4] == "'"$YEAR"'")' "the Blumhouse films of $YEAR, most popular first, not last year's"
KEY="$(pick)"
OUT_LIST="$OUT"
play "{\"title\":\"$KEY\"}"
want '.title.title == "Mercy Line"' "Mercy Line"
ok "discover company Blumhouse $YEAR -> listed $(jq .count <<<"$OUT_LIST"), $KEY (Mercy Line) started"

stage "7 one of Nolan's movies"
mcp direct_stream_discover '{"person":"Christopher Nolan","role":"director","kind":"movie"}'
want '[.titles[].title] == ["Interstellar","Oppenheimer","Inception"] and (.titles[0].roles == ["Director"])' "Nolan's films as director, most popular first"
KEY="$(pick)"
play "{\"title\":\"$KEY\"}"
ok "discover director Christopher Nolan -> $KEY (Interstellar) started"

stage "8 watched House of the Dragon season 1 last year, start season 2"
mcp direct_stream_find '{"title":"house of the dragon"}'
want '.status == "one" and .matches[0].title_key == "tv-94997" and .matches[0].movie_id == null' "House of the Dragon found on TMDB, not stored yet"
mcp movies_mark '{"title":"tv-94997","season":1,"watched":true}'
want '.title == "House of the Dragon" and .season == {"season":1,"watched":true,"episodes":10,"changed":10,"finished":10} and .watched_at == null' "season 1's ten episodes marked, the series not"
[ "$("$V" sql "$RUN" "select count(*) from movie_episode_marks where title_id = 'tv-94997' and season = 1" 2>/dev/null | grep -E '^ *[0-9]+$' | tr -d ' ')" = 10 ] || fail "movie_episode_marks does not hold 10 rows for season 1"
play '{"title":"tv-94997","season":2,"episode":1}'
want '.season == 2 and .episode == 1' "S02E01"
# The same without naming the episode: the pick starts after the season marked finished. Asked before
# S02E01 has a play row, the fake player page never reports a position, so nothing was played.
mcp direct_stream_play '{"title":"house of the dragon"}'
want '.started == true and .season == 2 and .episode == 1 and .picked == "next"' "a series named without an episode starts at S02E01 after the mark"
ok "find -> movies_mark season 1 (stored from TMDB, 10 marks) -> S02E01 started; unnamed pick is also S02E01"

stage "9 a Joko Anwar movie, play one"
mcp direct_stream_discover '{"person":"Joko Anwar","role":"director","kind":"movie"}'
want '[.titles[] | [.title, .original_language]] == [["Satan'"'"'s Slaves","id"],["Grave Torture","id"]]' "Joko Anwar's films, Indonesian"
KEY="$(pick)"
BEFORE="$(calls)"
play "{\"title\":\"$KEY\"}"
tail -n +"$((BEFORE + 1))" "$DIR/direct/calls.jsonl" | jq -e 'select(.args[0] == "resolve") | .args | index("--audio-lang") as $i | .[$i + 1] == "id"' >/dev/null \
  || fail "the resolve did not carry --audio-lang id"
ok "discover director Joko Anwar -> $KEY started, resolved with --audio-lang id (original language only)"

stage "10 James Gunn's superman"
mcp direct_stream_play '{"title":"superman"}'
want '.started == false and .skipped_play == "several_matches" and ([.candidates[].year] | sort == [1978,2025])' "two Supermans, nothing started without a year"
mcp direct_stream_discover '{"person":"James Gunn","role":"director","kind":"movie"}'
want '[.titles[] | [.title, .release_date[0:4]]] == [["Superman","2025"]]' "James Gunn directed the 2025 one"
play '{"title":"superman","year":2025}'
want '.title.tmdb_id == 1061474' "Superman (2025)"
ok "two titles called Superman start nothing; the person names the 2025 one; it started"

stage "marks"
mcp movies_mark '{"title":"tv-94997","not_interested":true}'
want '.not_interested == true' "not interested set"
mcp direct_stream_discover '{"kind":"tv","year_from":2022,"year_to":2022}'
want '.titles | map(select(.title_key == "tv-94997"))[0] | (.not_interested == true and .in_library == true and .stream.verified == true and (.movie_id | test("^M-")))' "House of the Dragon listed as stored, not interested, with a verified source"
mcp movies_mark '{"title":"tv-94997","not_interested":false}'
want '.not_interested == false' "not interested cleared"
mcp direct_stream_play '{"title":"one piece","absolute_episode":5000}'
want '.started == false and .skipped_play == "no_such_episode" and .episodes == 746' "One Piece has no episode 5000"
ok "not interested set, shown by discover, cleared; an episode number past the end starts nothing"

echo "discovery: PASS (10 requests)"
"$V" note "$RUN" "discovery: PASS (10 requests)"
