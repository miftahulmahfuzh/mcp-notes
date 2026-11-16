#!/usr/bin/env bash
# subtitles.sh RUN [files|replay|lone|ass|service|byid|borrow|quiet|prefer|wyzie ...]: TORRENT_STREAM_SOURCE phase 6's
# checks on a `verify.sh up --web --direct-stream --torrent` run. Each stage seeds a fixture torrent on
# loopback, has the fake index list it, plays a title with POST /api/stream/play {provider: "torrent"},
# and reads the session, the subtitle route, the fake subtitle service's request log
# ($SUBS/requests.jsonl) and the fake resolver's calls. Each stage plays a different title, because
# a title played once replays from disk. The first failed check stops it with
# `subtitles: FAIL at <stage>`. No stage named: all, in this order (replay needs files first, wyzie needs
# quiet first: it plays quiet's episode again, which kept no subtitle). The daemon has a fake Wyzie key and
# asks the fake Wyzie Subs (the same fake service) before the add-on in every stage; it lists a file only in
# mode `wyzie`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: subtitles.sh RUN [files|replay|lone|ass|service|byid|borrow|quiet|prefer|wyzie ...]}
shift
WANTED=("$@")
if [ ${#WANTED[@]} -eq 0 ]; then WANTED=(files replay lone ass service byid borrow quiet prefer wyzie); fi
DIR="$VERIFY_HOME/$RUN"
TORRENT="$DIR/torrent"
SUBS="$TORRENT/subs"
DIRECT="$DIR/direct"
[ -s "$SUBS/info.json" ] || { echo "subtitles: $RUN was not started with --torrent" >&2; exit 2; }
[ -s "$DIRECT/upstream.json" ] || { echo "subtitles: $RUN was not started with --direct-stream" >&2; exit 2; }
URL="http://127.0.0.1:$(cat "$DIR/port")"
EV="$DIR/evidence"
FIX="$(bash "$HERE/make-subtitle-fixtures.sh" "$VERIFY_HOME/.torrent-subtitle-fixtures")"
STAGE=start
CODE=""
BODY=""
SID=""

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "torrent subtitles $STAGE: $*"; }
fail() {
  echo "subtitles: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "torrent subtitles FAIL at $STAGE: $*" || true
  exit 1
}
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
# get PATH NAME: GET as the player does; the body is saved as evidence and read into GOT.
get() {
  CODE="$(curl -sS -o "$EV/torrent-sub-$2.body" -w '%{http_code}' "$URL$1")"
  GOT="$(cat "$EV/torrent-sub-$2.body")"
}

# The one place this script meets phases 1 and 3's harness (verify.sh up --torrent):
#  - phase 1's loopback seeder seeds every folder copied into $TORRENT/seed/<name>/ and then writes
#    $TORRENT/seeded/<name>.json = {"info_hash": "<40 hex>", ...};
#  - phase 3's fake index answers every query with $TORRENT/candidates.json,
#    [{info_hash, name, seeds, size_bytes}].
# (Reconciled: these are phase 1's and phase 3's names; the fake index answers each release as `<Title>.<Year>.<name>`.)
seed() { # seed NAME: prints the info hash
  mkdir -p "$TORRENT/seed"
  # Moved in whole (copy to a dot-name, then rename): phase 1's seeder skips dot-names and seeds a folder once.
  [ -d "$TORRENT/seed/$1" ] || { rm -rf "$TORRENT/seed/.$1"; cp -r "$FIX/$1" "$TORRENT/seed/.$1"; mv "$TORRENT/seed/.$1" "$TORRENT/seed/$1"; }
  for _ in $(seq 1 120); do [ -s "$TORRENT/seeded/$1.json" ] && break; sleep 0.25; done
  [ -s "$TORRENT/seeded/$1.json" ] || fail "the loopback seeder did not seed $1"
  jq -r .info_hash "$TORRENT/seeded/$1.json"
}
candidates() { # candidates PREFIX NAME:SEEDS ...
  local prefix=$1 out='[]' pair name seeds hash
  shift
  for pair in "$@"; do
    name=${pair%%:*}
    seeds=${pair##*:}
    hash="$(jq -r .info_hash "$TORRENT/seeded/$name.json")"
    out="$(jq -c --arg h "$hash" --arg n "$prefix.1080p.WEB.x264-$name" --argjson s "$seeds" '. + [{info_hash: $h, name: $n, seeds: $s, size_bytes: 1500000}]' <<<"$out")"
  done
  printf '%s\n' "$out" >"$TORRENT/candidates.json"
}

play() {
  api POST /api/stream/play "$1"
  [ "$CODE" = 200 ] || fail "POST /api/stream/play $1 answered HTTP $CODE: $BODY"
  SID="$(jq -r .session.session_id <<<"$BODY")"
  printf '%s\n' "$BODY" >"$EV/torrent-sub-play-$STAGE.json"
}
sub() { jq -r ".session.subtitles[0].$1 // \"\"" <<<"$BODY"; }
outcome() { jq -r --arg p "Subtitles: $1" '[.attempts[] | select(.provider == $p) | .outcome] | join(",")' <<<"$BODY"; }
requests() { if [ -f "$SUBS/requests.jsonl" ]; then wc -l <"$SUBS/requests.jsonl" | tr -d ' '; else echo 0; fi; }
wyzie_requests() { if [ -f "$SUBS/wyzie-requests.jsonl" ]; then wc -l <"$SUBS/wyzie-requests.jsonl" | tr -d ' '; else echo 0; fi; }
resolves() { if [ -f "$DIRECT/calls.jsonl" ]; then grep -c '"resolve"' "$DIRECT/calls.jsonl" || true; else echo 0; fi; }
page() { # page LINE: the real player page shows the session's subtitle by default
  SESSION_ID="$SID" WANT_LINE="$1" "$V" ui "$RUN" "$HERE/subtitle-page.steps.mjs" >"$EV/torrent-sub-page-$STAGE.txt" 2>&1 \
    || fail "the player page did not show [$1] by default (see $EV/torrent-sub-page-$STAGE.txt)"
  ok "the player page turned the subtitle on by default and showed [$1]"
}
# ohash FILE: the OpenSubtitles hash, computed here independently of the daemon.
ohash() {
  node -e 'const fs=require("fs");const f=process.argv[1];const n=fs.statSync(f).size;const fd=fs.openSync(f,"r");const r=(p)=>{const b=Buffer.alloc(65536);fs.readSync(fd,b,0,65536,p);return b};let s=BigInt(n);for(const b of [r(0),r(n-65536)])for(let i=0;i<65536;i+=8)s=(s+b.readBigUInt64LE(i))&((1n<<64n)-1n);console.log(s.toString(16).padStart(16,"0")+" "+n)' "$1"
}

FILES_HASH=""
stage_files() {
  stage files
  local before wbefore
  FILES_HASH="$(seed with-sub)"
  candidates Film.2010 with-sub:500
  before="$(requests)"
  wbefore="$(wyzie_requests)"
  play '{"kind":"movie","tmdb_id":467905,"provider":"torrent"}'
  [[ "$(sub url)" =~ ^/api/stream/torrent/$FILES_HASH/sub/file-[0-9]+\.vtt$ ]] || fail "the session's subtitle is [$(sub url)], not the torrent's file"
  [ "$(sub lang) $(sub english)" = "en true" ] || fail "the subtitle is [$(sub lang) $(sub english)], not English"
  [ "$(outcome files)" = resolved ] || fail "Subtitles: files is [$(outcome files)]"
  get "$(sub url)" files
  [ "$CODE" = 200 ] || fail "the subtitle route answered $CODE"
  [[ "$GOT" == WEBVTT* ]] && grep -q '00:00:01.000 --> 00:00:30.000' <<<"$GOT" && grep -q 'Torrent subtitle line one' <<<"$GOT" || fail "the served file is not the torrent's .srt as WebVTT"
  [ "$(requests)" = "$before" ] && [ "$(wyzie_requests)" = "$wbefore" ] || fail "a subtitle service was asked although the torrent holds an English file"
  [ -s "$DIR/data/movies/torrents/$FILES_HASH/.notesd-subs/chosen.json" ] || fail "chosen.json was not kept under the torrent folder"
  ok "Film.en.srt in the torrent is the session's English subtitle, served as WebVTT, the service not asked"
  page 'Torrent subtitle line one'
}

stage_replay() {
  stage replay
  [ -n "$FILES_HASH" ] || FILES_HASH="$(jq -r .info_hash "$TORRENT/seeded/with-sub.json")"
  local before wbefore
  before="$(requests)"
  wbefore="$(wyzie_requests)"
  play '{"kind":"movie","tmdb_id":467905,"provider":"torrent"}'
  [ "$(outcome kept)" = resolved ] || fail "Subtitles: kept is [$(outcome kept)] on the second play"
  [ -z "$(outcome files)" ] || fail "the files tier ran again on the second play"
  [[ "$(sub url)" =~ ^/api/stream/torrent/$FILES_HASH/sub/file-[0-9]+\.vtt$ ]] || fail "the second play's subtitle is [$(sub url)]"
  [ "$(requests)" = "$before" ] && [ "$(wyzie_requests)" = "$wbefore" ] || fail "the second play asked a subtitle service"
  ok "a second play answers the kept subtitle and asks nothing"
}

stage_lone() {
  stage lone
  seed lone >/dev/null
  candidates Rivals.2026 lone:500
  play '{"kind":"movie","tmdb_id":990001,"provider":"torrent"}'
  [ "$(jq -c '.session.subtitles | map({lang, label})' <<<"$BODY")" = '[{"lang":null,"label":""}]' ] || fail "the lone subtitle is $(jq -c .session.subtitles <<<"$BODY")"
  get "$(sub url)" lone
  grep -q 'Lone subtitle line' <<<"$GOT" || fail "the served file is not Film.srt"
  ok "the torrent's one subtitle file that names no language is the session's subtitle"
  page 'Lone subtitle line'
}

stage_ass() {
  stage ass
  seed ass >/dev/null
  candidates Dog.Stars.2026 ass:500
  play '{"kind":"movie","tmdb_id":990002,"provider":"torrent"}'
  [ "$(sub label)" = English ] || fail "the ASS subtitle is labelled [$(sub label)]"
  get "$(sub url)" ass
  [[ "$GOT" == WEBVTT* ]] && grep -q -- '-->' <<<"$GOT" && grep -q 'ASS subtitle line' <<<"$GOT" || fail "Film.eng.ass was not converted to WebVTT"
  ok "an English .ass in the torrent is converted with ffmpeg and served as WebVTT"
}

stage_service() {
  stage service
  local before hash first want
  hash="$(seed bare-service)"
  candidates Bad.Apples.2026 bare-service:500
  printf 'ok\n' >"$SUBS/mode"
  before="$(requests)"
  play '{"kind":"movie","tmdb_id":990003,"provider":"torrent"}'
  [ "$(sub url)" = "/api/stream/torrent/$hash/sub/service-9001.vtt" ] || fail "the subtitle is [$(sub url)], not the hash-matched service file"
  [ "$(outcome files)" = no_stream ] && [ "$(outcome service)" = resolved ] || fail "attempts: files=[$(outcome files)] service=[$(outcome service)]"
  first="$(sed -n "$((before + 1))p" "$SUBS/requests.jsonl")"
  read -r want_hash want_size <<<"$(ohash "$FIX/bare-service/Film/Film.mp4")"
  want="videoHash=$want_hash&videoSize=$want_size.json"
  [[ "$(jq -r .path <<<"$first")" =~ ^/subtitles/movie/tt[0-9]+/ ]] && [[ "$(jq -r .path <<<"$first")" == *"$want" ]] || fail "the first request [$(jq -r .path <<<"$first")] does not carry [$want]"
  [[ "$(jq -r .user_agent <<<"$first")" == notesd* ]] || fail "the request's user-agent [$(jq -r .user_agent <<<"$first")] does not say notesd"
  get "$(sub url)" service
  grep -q 'Service subtitle by hash' <<<"$GOT" || fail "the served file is not the hash-matched one"
  ok "no subtitle in the torrent: the service was asked by the file's hash ($want_hash) as notesd and its file is served"
  page 'Service subtitle by hash'
}

stage_byid() {
  stage byid
  local before hash
  hash="$(seed bare-byid)"
  candidates MobLand.S01E01 bare-byid:500
  printf 'id_only\n' >"$SUBS/mode"
  before="$(requests)"
  play '{"kind":"tv","tmdb_id":247718,"season":1,"episode":1,"provider":"torrent"}'
  [ "$(sub url)" = "/api/stream/torrent/$hash/sub/service-9002.vtt" ] || fail "the subtitle is [$(sub url)], not the id-matched file"
  [ "$(sub label)" = 'English (matched by title)' ] || fail "the label is [$(sub label)]"
  sed -n "$((before + 1)),\$p" "$SUBS/requests.jsonl" | jq -r .path >"$EV/torrent-sub-byid-paths.txt"
  sed -n 1p "$EV/torrent-sub-byid-paths.txt" | grep -Eq '^/subtitles/series/tt[0-9]+:1:1/videoHash=' || fail "the first request was not by hash"
  sed -n 2p "$EV/torrent-sub-byid-paths.txt" | grep -Eq '^/subtitles/series/tt[0-9]+:1:1\.json$' || fail "the second request was not by IMDb id alone"
  ok "the hash request failed (500), the IMDb id request answered, its English file is served"
}

stage_borrow() {
  stage borrow
  local hash before
  hash="$(seed bare-borrow)"
  candidates MobLand.S01E02 bare-borrow:500
  printf 'empty\n' >"$SUBS/mode"
  printf 'hls\n' >"$DIRECT/mode"
  before="$(resolves)"
  play '{"kind":"tv","tmdb_id":247718,"season":1,"episode":2,"provider":"torrent"}'
  [ "$(sub url)" = "/api/stream/torrent/$hash/sub/borrow.vtt" ] || fail "the subtitle is [$(sub url)], not the borrowed one"
  [[ "$(sub label)" == 'English ('* ]] || fail "the label [$(sub label)] does not name the provider"
  [ "$(outcome service)" = no_stream ] && [ "$(outcome borrow)" = resolved ] || fail "attempts: service=[$(outcome service)] borrow=[$(outcome borrow)]"
  [ "$(resolves)" = "$((before + 1))" ] || fail "the borrow made $(( $(resolves) - before )) resolves, not one"
  get "$(sub url)" borrow
  grep -q '00:00:01.000 --> 00:00:03.000' <<<"$GOT" && grep -q 'Hello.' <<<"$GOT" || fail "the served file is not the provider's subtitle"
  ok "the service had nothing: one out-of-sight resolve borrowed the cloud provider's English subtitle"
  page 'Hello.'
}

stage_quiet() {
  stage quiet
  seed bare-quiet >/dev/null
  candidates MobLand.S01E03 bare-quiet:500
  printf 'error\n' >"$SUBS/mode"
  printf 'no_chrome\n' >"$DIRECT/mode"
  play '{"kind":"tv","tmdb_id":247718,"season":1,"episode":3,"provider":"torrent"}'
  printf 'hls\n' >"$DIRECT/mode"
  [ "$(jq '.session.subtitles | length' <<<"$BODY")" = 0 ] || fail "a subtitle came from nowhere: $(jq -c .session.subtitles <<<"$BODY")"
  [ "$(outcome service)" = error ] && [ "$(outcome borrow)" = error ] || fail "attempts: service=[$(outcome service)] borrow=[$(outcome borrow)]"
  [ -n "$(jq -r '.session.manifest_url // empty' <<<"$BODY")" ] || fail "the play has no manifest"
  ok "the service down and the borrow failed: both recorded as errors, the play still answers"
}

stage_prefer() {
  stage prefer
  local hi low
  hi="$(seed bare-hi)"
  low="$(seed with-sub-low)"
  candidates Oldboy.2003 bare-hi:900 with-sub-low:100
  play '{"kind":"movie","tmdb_id":990004,"provider":"torrent"}'
  [ "$(jq -r .session.torrent.info_hash <<<"$BODY")" = "$low" ] || fail "the session plays [$(jq -r .session.torrent.info_hash <<<"$BODY")], not the candidate with Film.en.srt ($low; the better-seeded one is $hi)"
  [ "$(sub lang)" = en ] || fail "the preferred torrent's subtitle is [$(sub lang)]"
  ok "of two candidates, the one whose files hold Film.en.srt was tried first over the better-seeded one"
}

# The phase 6 addendum: with a Wyzie key, Wyzie Subs is asked before the add-on. It plays quiet's episode again
# (that play kept no subtitle), with the fake Wyzie listing an English file beside a machine-translated one.
stage_wyzie() {
  stage wyzie
  local before wbefore first detail
  [ -s "$TORRENT/seeded/bare-quiet.json" ] || fail "wyzie needs quiet first (it plays the same episode again)"
  candidates MobLand.S01E03 bare-quiet:500
  printf 'wyzie\n' >"$SUBS/mode"
  printf 'hls\n' >"$DIRECT/mode"
  before="$(requests)"
  wbefore="$(wyzie_requests)"
  play '{"kind":"tv","tmdb_id":247718,"season":1,"episode":3,"provider":"torrent"}'
  printf 'ok\n' >"$SUBS/mode"
  [[ "$(sub url)" =~ ^/api/stream/torrent/[0-9a-f]{40}/sub/service-wyzie-7001\.vtt$ ]] || fail "the subtitle is [$(sub url)], not Wyzie's file"
  [ "$(sub label)" = 'English (Wyzie)' ] || fail "the label is [$(sub label)]"
  [ "$(outcome service)" = resolved ] || fail "Subtitles: service is [$(outcome service)]"
  detail="$(jq -r '[.attempts[] | select(.provider == "Subtitles: service") | .detail] | join(",")' <<<"$BODY")"
  [[ "$detail" == *Wyzie* ]] || fail "the service attempt's detail [$detail] does not name Wyzie"
  first="$(sed -n "$((wbefore + 1))p" "$SUBS/wyzie-requests.jsonl")"
  [ "$(jq -r '[.path, .season, .episode, (.has_key | tostring)] | join(" ")' <<<"$first")" = "/search 1 3 true" ] || fail "the first Wyzie request is [$first]"
  [[ "$(jq -r .id <<<"$first")" =~ ^(tt[0-9]+|247718)$ ]] || fail "the Wyzie request's id is [$(jq -r .id <<<"$first")]"
  [[ "$(jq -r .user_agent <<<"$first")" == notesd* ]] || fail "the Wyzie request's user-agent [$(jq -r .user_agent <<<"$first")] does not say notesd"
  [ "$(requests)" = "$before" ] || fail "the add-on was asked although Wyzie answered"
  get "$(sub url)" wyzie
  grep -q 'Wyzie subtitle line' <<<"$GOT" || fail "the served file is not Wyzie's"
  ! grep -q 'verify-fake-wyzie-key\|fake-wyzie-token' "$DIR/daemon.log" "$EV/torrent-sub-play-wyzie.json" || fail "the Wyzie key or a download token is in the daemon log or the play answer"
  ! grep -rq 'verify-fake-wyzie-key\|fake-wyzie-token' "$DIR/data/movies/torrents" --include=chosen.json || fail "the Wyzie key or a download token was kept in chosen.json"
  ok "with a Wyzie key, Wyzie was asked first (as notesd, the machine-translated entry dropped), its file is served, the add-on not asked, no key or token logged or kept"
}

for s in "${WANTED[@]}"; do
  case "$s" in
    files) stage_files ;;
    replay) stage_replay ;;
    lone) stage_lone ;;
    ass) stage_ass ;;
    service) stage_service ;;
    byid) stage_byid ;;
    borrow) stage_borrow ;;
    quiet) stage_quiet ;;
    prefer) stage_prefer ;;
    wyzie) stage_wyzie ;;
    *) echo "subtitles: unknown stage $s" >&2; exit 2 ;;
  esac
done
echo "subtitles: PASS (${WANTED[*]})"
"$V" note "$RUN" "torrent subtitles PASS (${WANTED[*]})"
