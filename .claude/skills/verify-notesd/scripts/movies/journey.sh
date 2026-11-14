#!/usr/bin/env bash
# journey.sh RUN [--no-ui]: the Movies feature map's whole chain on a `verify.sh up --web --movies` run.
# Each stage drives a real surface (HTTP, MCP, the fake VLC, the wall), checks the end state through
# HTTP, MCP or the run's database (read-only), and logs it to the run's evidence LOG.md. The first
# failed check stops it with `journey: FAIL at <stage>`. No model call. Run from the checkout under test.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: journey.sh RUN [--no-ui]}
UI=1
if [ "${2:-}" = --no-ui ]; then UI=0; fi
DIR="$VERIFY_HOME/$RUN"
[ -d "$DIR/movies/library" ] || { echo "journey: $RUN was not started with --movies" >&2; exit 2; }
DB="$(cat "$DIR/db")"
LIB="$DIR/movies/library"
LAUNCHES="$DIR/movies/vlc/launches.jsonl"
COMMANDS="$DIR/movies/vlc/commands.jsonl"
IMG_BASE="http://127.0.0.1:$(cat "$DIR/movies/tmdb.port")/t/p/"
SERIES="$LIB/Videos/Mobland S01 WEB-DL 1080p x265 6CH [Pahe.in]"
E01_NAME='MobLand.S01E01.Stick.or.Twist.1080p.WEB-DL.x265.6CH-Pahe.in.mkv'
E02_NAME='MobLand.S01E02.Eye.for.an.Eye.1080p.WEB-DL.x265.6CH-Pahe.in.mkv'
E03_NAME='MobLand.S01E03.Lie.Down.with.Dogs.1080p.WEB-DL.x265.6CH-Pahe.in.mkv'
STAGE=start
STAGES=0
CODE=""
BODY=""
MCP=""

stage() { STAGE=$1; STAGES=$((STAGES + 1)); echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "movies journey $STAGE: $*"; }
fail() {
  echo "journey: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "movies journey FAIL at $STAGE: $*" || true
  exit 1
}
# q SQL: the query's value(s) from the run's database, in a read-only transaction.
q() {
  printf 'begin read only;\n%s;\nrollback;\n' "$1" \
    | docker exec -i mcp-notes-pg-verify psql -X -q -tA -v ON_ERROR_STOP=1 -U postgres -d "$DB" \
    | sed '/^BEGIN$/d;/^ROLLBACK$/d'
}
# wait_q SQL WANT [SECONDS]: poll until the query prints WANT.
wait_q() {
  local sql=$1 want=$2 secs=${3:-30} got="" i
  for ((i = 0; i < secs * 2; i++)); do
    got="$(q "$sql")"
    if [ "$got" = "$want" ]; then return 0; fi
    sleep 0.5
  done
  fail "waited ${secs}s for [$sql] = [$want], last [$got]"
}
# api METHOD PATH [JSON]: through verify.sh (evidence saved); sets CODE and BODY.
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
need_2xx() { [[ $CODE == 2* ]] || fail "$1 answered HTTP $CODE: $BODY"; }
# sync_until SQL WANT: ask for a library pass every 10 s until the query prints WANT (2 min at most).
sync_until() {
  local sql=$1 want=$2 got="" i j
  for ((i = 0; i < 12; i++)); do
    api POST /api/movies/sync
    for ((j = 0; j < 20; j++)); do
      got="$(q "$sql")"
      if [ "$got" = "$want" ]; then return 0; fi
      sleep 0.5
    done
  done
  fail "after 12 passes [$sql] = [$got], wanted [$want]"
}
# mcp TOOL JSON: through verify.sh (evidence saved); sets MCP to the tool's JSON text.
mcp() {
  local out
  out="$("$V" mcp "$RUN" "$@" 2>/dev/null || true)"
  MCP="$(sed '1d' <<<"$out")"
}
jqb() { jq -e "$@" >/dev/null 2>&1; }
fid() { q "select id from movie_files where name = '$1' order by id desc limit 1"; }
launches() { if [ -f "$LAUNCHES" ]; then wc -l <"$LAUNCHES"; else echo 0; fi; }
# wait_launch NAME_PART COUNT_BEFORE: a new fake VLC launch whose file contains NAME_PART.
wait_launch() {
  local i
  for ((i = 0; i < 40; i++)); do
    if [ "$(launches)" -gt "$2" ] && tail -1 "$LAUNCHES" | jqb --arg w "$1" '(.file // "") | contains($w)'; then return 0; fi
    sleep 0.5
  done
  fail "no fake VLC launch on $1"
}
vlc() { "$V" vlc "$RUN" "$@" >/dev/null 2>&1 || fail "verify.sh vlc $*"; }
# expect_state TITLE_ID FILE_ID STATE: the title's detail reports that state for that file.
expect_state() {
  local got
  api GET "/api/movies/$1"
  need_2xx "GET /api/movies/$1"
  got="$(jq -r --arg id "$2" '[.. | objects | select(has("state") and (((.file_id // .id) | tostring) == $id)) | .state][0] // "none"' <<<"$BODY")"
  [ "$got" = "$3" ] || fail "file $2 of $1 is $got, wanted $3"
  ok "file $2 of $1 is $3"
}
in_range() { [ -n "$1" ] && [ "$1" != null ] && awk -v v="$1" 'BEGIN { exit !(v + 0 >= 295 && v + 0 <= 320) }'; }

"$V" doctor "$RUN" >/dev/null || fail "verify.sh doctor $RUN failed"

stage "1 sync: the generated tree becomes a library"
sync_until "select count(*) from movie_files where deleted_at is null and status = 'matched'" 6
ok "6 present files matched (dots, underscores in Done, year in folder, 3 episodes)"
[ "$(q "select status || ':' || coalesce(reason, '') from movie_files where name like 'WhatsApp Video%'")" = "unmatched:too_short" ] \
  || fail "the 20 s clip is not unmatched:too_short"
ok "the 20 s clip under Done/docker_es is unmatched:too_short"
[ "$(q "select count(*) from movie_files where title_id = 'tv-247718' and season = 1 and episode in (1, 2, 3) and deleted_at is null")" = 3 ] \
  || fail "the MobLand files are not one title with season and episode"
[ "$(q "select count(*) from movie_episodes where title_id = 'tv-247718' and season = 1")" = 3 ] || fail "MobLand episode titles missing"
ok "the season folder is one title tv-247718: S01E01-E03 files and 3 episode rows"
[ "$(q "select count(*) from movie_title_companies tc join movie_companies c on c.id = tc.company_id where tc.title_id = 'movie-990001' and c.name = 'Blumhouse Productions'")" = 1 ] \
  || fail "studio row missing"
[ "$(q "select count(*) from movie_credits where title_id = 'movie-467905' and role = 'cast' and character is not null")" -ge 2 ] || fail "cast with characters missing"
[ "$(q "select count(*) from movie_credits where title_id = 'movie-467905' and role = 'director'")" -ge 1 ] || fail "director missing"
ok "studios, cast with characters and directors stored"
[ "$(q "select count(*) from movie_files where name like 'The_Rivals_of_Amziah_King%' and done_at is not null")" = 1 ] || fail "file found in Done has no done signal"
ok "the film found inside Done has a done signal"
wait_q "select (count(*) >= 2)::text from movie_plays p join movie_files f on f.id = p.file_id where p.source = 'vlc_recents' and f.deleted_at is not null and f.title_id in ('movie-990002', 'movie-990003')" true 60
[ "$(q "select max(p.position_s)::int from movie_plays p join movie_files f on f.id = p.file_id where f.title_id = 'movie-990002' and p.source = 'vlc_recents'")" = 4210 ] \
  || fail "The Dog Stars recents position is not 4210 s"
ok "VLC recents: two gone films became deleted files with observations (The Dog Stars at 4210 s)"
grep -q ' GET /3/' "$DIR/movies/tmdb.log" || fail "the fake TMDB saw no request"
ok "metadata came from the fake TMDB ($(grep -c ' GET /3/' "$DIR/movies/tmdb.log") requests)"

stage "2 posters: every title has a poster URL that loads without the files"
api GET /api/movies
need_2xx "GET /api/movies"
n="$(jq --arg b "$IMG_BASE" '[.. | objects | .poster_url? | select(type == "string" and startswith($b))] | length' <<<"$BODY")"
[ "$n" -ge 4 ] || fail "only $n poster_url values point at the image base: $BODY"
poster="$(jq -r --arg b "$IMG_BASE" '[.. | objects | .poster_url? | select(type == "string" and startswith($b))][0]' <<<"$BODY")"
[ "$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$poster")" = "200 image/png" ] || fail "poster $poster does not load"
ok "$n titles carry a poster_url on the image base; $poster loads as image/png"

stage "3 user state: watched, stars and a review note"
api POST /api/movies/movie-467905/user '{"watched":true,"rating":4,"review":"Verify review: tight, mean and funny."}'
need_2xx "POST /api/movies/movie-467905/user"
[ "$(q "select rating || ' ' || (watched_at is not null)::text from movie_titles where id = 'movie-467905'")" = "4 true" ] || fail "rating/watched not stored"
[ "$(q "select count(*) from notes n join movie_titles t on t.review_note_id = n.id where t.id = 'movie-467905' and n.body like '%Verify review: tight, mean and funny.%' and 'movie' = any(n.tags) and n.deleted_at is null")" = 1 ] \
  || fail "the review is not a live #movie note linked to the title"
ok "rating 4 and watched stored; review is note $(q "select review_note_id from movie_titles where id = 'movie-467905'") tagged #movie"

stage "4 play: Play starts VLC from the start, polls progress, exit closes the play"
E01="$(fid "$E01_NAME")"
n="$(launches)"
api POST "/api/movies/files/$E01/play" '{}'
need_2xx "POST play S01E01"
wait_launch "S01E01" "$n"
start="$(tail -1 "$LAUNCHES" | jq -r '.start_time')"
[ "${start%.*}" -le 1 ] || fail "S01E01 started at $start s, wanted the start"
ok "fake vlc.exe launched on $(tail -1 "$LAUNCHES" | jq -r .file) at ${start}s"
tail -1 "$LAUNCHES" | jqb '.argv | index("--fullscreen")' || fail "the launch has no --fullscreen"
for _ in $(seq 1 20); do [ -s "$DIR/movies/vlc/powershell.log" ] && break; sleep 0.25; done
[ -s "$DIR/movies/vlc/powershell.log" ] || fail "notesd never asked Windows to put VLC in front"
ok "VLC launched --fullscreen and notesd asked Windows to put its window in front"
wait_q "select count(*) from movie_plays where file_id = $E01 and source = 'live' and ended_at is null" 1 20
vlc at 912
wait_q "select (coalesce(max(position_s), 0) >= 900)::text from movie_plays where file_id = $E01 and source = 'live'" true 20
ok "position polled into the open play event (>= 900 of 960 s)"
vlc quit
wait_q "select count(*) from movie_plays where file_id = $E01 and source = 'live' and ended_at is not null and position_s >= 900" 1 30
ok "VLC exit closed the play event at its last position"
expect_state tv-247718 "$E01" finished

stage "5 continue MobLand: the next present episode starts"
n="$(launches)"
mcp movies_continue '{"title":"MobLand"}'
jqb '.action == "started"' <<<"$MCP" || fail "movies_continue {title: MobLand}: $MCP"
wait_launch "S01E02" "$n"
E02="$(fid "$E02_NAME")"
ok "movies_continue started S01E02"
wait_q "select count(*) from movie_plays where file_id = $E02 and source = 'live' and ended_at is null" 1 20
vlc at 300
wait_q "select (coalesce(max(position_s), 0) >= 300)::text from movie_plays where file_id = $E02 and source = 'live'" true 20
vlc quit
wait_q "select count(*) from movie_plays where file_id = $E02 and source = 'live' and ended_at is null" 0 30
expect_state tv-247718 "$E02" in_progress

stage "6 continue (no title): the newest play resumes where it stopped"
n="$(launches)"
mcp movies_continue '{}'
jqb '.action == "resumed"' <<<"$MCP" || fail "movies_continue {}: $MCP"
wait_launch "S01E02" "$n"
launched_at="$(tail -1 "$LAUNCHES" | jq -r '.at')"
start="$(tail -1 "$LAUNCHES" | jq -r '.start_time')"
seek=""
sleep 3
if [ -f "$COMMANDS" ]; then
  seek="$(jq -r --arg t "$launched_at" 'select(.command == "seek" and .at >= $t) | .val' "$COMMANDS" | tail -1)"
fi
in_range "$start" || in_range "$seek" || fail "resumed at start-time $start / seek ${seek:-none}, wanted about 300 s"
ok "VLC resumed S01E02 at about 300 s (start-time $start, seek ${seek:-none})"
vlc quit
wait_q "select count(*) from movie_plays where file_id = $E02 and source = 'live' and ended_at is null" 0 30

stage "7 delete and move: a deleted episode keeps its row, a moved film is not deleted"
E03="$(fid "$E03_NAME")"
OLD="$(fid 'Oldboy.mkv')"
rm "$SERIES/$E03_NAME"
mv "$LIB/Telegram Desktop/Oldboy (2003)" "$LIB/Videos/Done/"
sync_until "select count(*) from movie_files where id = $E03 and deleted_at is not null" 1
ok "S01E03 file marked deleted"
sync_until "select count(*) from movie_files where id = $OLD and deleted_at is null and done_at is not null and path like '%/Videos/Done/Oldboy (2003)/Oldboy.mkv'" 1
ok "Oldboy moved Telegram Desktop -> Videos/Done: same row, new path, done signal, not deleted"
[ "$(q "select count(*) from movie_titles where id = 'tv-247718'")" = 1 ] || fail "the title went with its file"
expect_state tv-247718 "$E03" removed_unwatched
expect_state movie-990004 "$OLD" finished

stage "8 continue MobLand again: the next episode is missing"
api POST "/api/movies/files/$E02/watched" '{"watched":true}'
need_2xx "POST watched S01E02"
expect_state tv-247718 "$E02" finished
n="$(launches)"
mcp movies_continue '{"title":"MobLand"}'
jqb '.action == "missing" and ((.missing | tostring) | test("\"episode\":3|S01E03"))' <<<"$MCP" || fail "movies_continue: $MCP"
sleep 2
[ "$(launches)" = "$n" ] || fail "movies_continue started VLC although the episode is missing"
ok "movies_continue answers missing S01E03 and starts nothing"

stage "9 another machine's file: available false, play refused"
"$V" exec "$RUN" "insert into movie_files (title_id, host, path, name, size, duration_s, status, source, first_seen_at, last_seen_at, updated_at) values ('movie-467905', 'verify-other-host', '/mnt/c/Users/other/Videos/How.to.Make.a.Killing.2026.mkv', 'How.to.Make.a.Killing.2026.mkv', 1234, 960, 'matched', 'scan', now(), now(), now())" >/dev/null 2>&1 \
  || fail "seeding the other host's file failed"
OTHER="$(q "select id from movie_files where host = 'verify-other-host'")"
api GET /api/movies/movie-467905
need_2xx "GET /api/movies/movie-467905"
jqb --arg id "$OTHER" '[.. | objects | select(((.file_id // .id) | tostring) == $id) | .available][0] == false' <<<"$BODY" \
  || fail "file $OTHER is not available:false: $BODY"
n="$(launches)"
api POST "/api/movies/files/$OTHER/play" '{}'
{ [[ $CODE == 4* ]] && grep -q not_on_this_machine <<<"$BODY"; } || fail "play of another host's file answered $CODE $BODY"
[ "$(launches)" = "$n" ] || fail "VLC started for another host's file"
ok "the other host's file is available:false; play answers $CODE not_on_this_machine"

stage "10 unmatched: the clip is listed with its reason; assigning moves it into the library"
JUNK="$(q "select id from movie_files where name like 'WhatsApp Video%' and deleted_at is null")"
api GET /api/movies/unmatched
need_2xx "GET /api/movies/unmatched"
jqb --arg id "$JUNK" '[.. | objects | select(((.file_id // .id) | tostring) == $id and .reason == "too_short")] | length == 1' <<<"$BODY" \
  || fail "clip $JUNK is not listed as too_short: $BODY"
api POST "/api/movies/files/$JUNK/assign" '{"kind":"movie","tmdb_id":990003}'
need_2xx "POST assign"
wait_q "select status || ' ' || coalesce(title_id, '') from movie_files where id = $JUNK" "matched movie-990003" 10
api GET /api/movies/unmatched
jqb --arg id "$JUNK" '[.. | objects | select(((.file_id // .id) | tostring) == $id)] | length == 0' <<<"$BODY" || fail "the clip is still unmatched: $BODY"
ok "clip $JUNK assigned to movie-990003 and gone from the unmatched list"

stage "11 MCP reads: person, company, history, one title"
mcp movies_person '{"name":"Margaret Qualley"}'
jqb '([.. | objects | select((.tmdb_id // .id) == 467905 or .title_id? == "movie-467905") | .seen][0] == true)
     and ([.. | objects | select((.tmdb_id // .id) == 990201 or .title_id? == "movie-990201") | .seen][0] == false)' <<<"$MCP" \
  || fail "movies_person: $MCP"
ok "movies_person marks How to Make a Killing seen and Kinds of Kindness not seen"
mcp movies_list '{"company":"Blumhouse"}'
jqb 'tostring | test("movie-990001")' <<<"$MCP" || fail "movies_list {company: Blumhouse}: $MCP"
ok "movies_list by company finds the Blumhouse film"
mcp movies_history '{"title":"MobLand"}'
jqb 'tostring | test("Eye for an Eye|\"episode\":2")' <<<"$MCP" || fail "movies_history: $MCP"
ok "movies_history lists the S01E02 plays"
mcp movies_get '{"title":"tv-247718"}'
jqb --arg id "$E03" '[.. | objects | select(((.file_id // .id) | tostring) == $id)] | length >= 1' <<<"$MCP" || fail "movies_get lacks the deleted S01E03 file: $MCP"
ok "movies_get returns the series with its deleted file"

if [ "$UI" = 1 ]; then
  stage "12 wall: poster grid, then the MobLand page with its deleted episode"
  "$V" ui "$RUN" "$HERE/ui-library.mjs" >/dev/null 2>&1 || fail "the wall drive failed; read the newest *-ui-ui-library.txt in $DIR/evidence"
  ok "grid of loaded posters; MobLand page with episodes, cast and characters, one deleted flag"
fi

"$V" vlc "$RUN" args >/dev/null 2>&1 || true
echo "journey: PASS ($STAGES stages)"
"$V" note "$RUN" "movies journey PASS ($STAGES stages)"
