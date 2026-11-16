#!/usr/bin/env bash
# verify.sh: launch, drive and tear down a throwaway notesd for verification.
#
# Every run gets its own database (in one shared Docker Postgres), its own port, data dir and
# CLAUDE_HOME. Nothing touches the live daemon on 7317, Neon, ~/mcp-notes-data or ~/.claude.
# Evidence lives under $VERIFY_HOME/<run>/evidence and survives `down`.
#
#   verify.sh up [--web] [--embed] [--sessions] [--adversary] [--movies] [--direct-stream] [--discovery] [--prober] [--torrent]
#                                       start an instance from the current checkout; prints RUN= and URL=
#                                       --sessions seeds CLAUDE_HOME from tests/fixtures/claude-home
#                                       --adversary turns the Seer reviewer on against a throwaway Seer DB
#                                       built from ${SEER_DIR:-~/seer}/db/migrations (reviews are real, billed)
#                                       --movies turns the Movies library on against a generated video tree,
#                                       a fake TMDB and a fake vlc.exe/curl.exe (scripts/movies/); else it is off
#                                       --direct-stream turns direct streaming on (implies --movies) against a
#                                       fake resolver and a fixture stream host (tests/fixtures/direct-stream/);
#                                       without it NOTESD_DIRECT_STREAM=off is pinned
#                                       --discovery (implies --direct-stream) adds scripts/movies/tmdb-discovery.json
#                                       to the fake TMDB: people, studios, streaming services and the titles
#                                       direct_stream_discover and absolute episode numbers are proven on
#                                       (with --torrent: direct-stream/codenames.sh, the watch codenames)
#                                       --prober (needs --direct-stream) turns the stream prober on, a pass every
#                                       5 s; the fake powershell.exe reports $MOVIES/idle_ms (0: someone is
#                                       typing). --prober=off: the prober setting unset. Without either the prober
#                                       is pinned off.
#                                       --torrent (implies --direct-stream) turns torrents on against a loopback
#                                       seeder of a generated film and pack (scripts/torrent/; TORRENT_FIXTURE_FILE=
#                                       <path> seeds that file as the film); without it NOTESD_TORRENT=off is pinned
#   verify.sh doctor RUN                is this instance worth driving? (read-only)
#   verify.sh api RUN METHOD PATH [JSON]   HTTP call; request + response saved as evidence
#   verify.sh upload RUN PATH FILE [body]  multipart POST (images, files); saved as evidence
#   verify.sh mcp RUN TOOL [JSON]       MCP tool call over /mcp; saved as evidence
#   verify.sh ui RUN STEPS.mjs          drive the wall with Playwright (video + final screenshot)
#   verify.sh sql RUN "SELECT ..."      read the run's database (read-only transaction)
#   verify.sh exec RUN [--seer] "SQL"   WRITE to the run's throwaway notes DB (or its Seer DB); saved as evidence
#   verify.sh note RUN "TEXT"           append a line to the run's evidence log (what you proved)
#   verify.sh vlc RUN args|status|commands|at SECONDS|quit
#                                       drive a --movies run's fake VLC; saved as evidence
#   verify.sh down RUN|--all            stop what `up` started, drop its DB; evidence stays
#   verify.sh ls                        runs with state, pid and evidence count
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
PG_CONTAINER=mcp-notes-pg-verify
PG_IMAGE=pgvector/pgvector:pg16
PG_PORT=55436
PG_PASSWORD=mcpnotes

die() { echo "verify: $*" >&2; exit 1; }

repo_root() { git rev-parse --show-toplevel 2>/dev/null || die "run from inside an mcp-notes checkout"; }

run_dir() {
  local run=${1:-}
  [ -n "$run" ] || die "missing RUN id (see: verify.sh ls)"
  [ -d "$VERIFY_HOME/$run" ] || die "no run $run under $VERIFY_HOME"
  echo "$VERIFY_HOME/$run"
}

db_url() { echo "postgres://postgres:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/$1"; }

# Numbered evidence file: evidence/NN-<kind>-<slug>.<ext>
next_evidence() {
  local dir=$1/evidence kind=$2 slug=$3 ext=$4 n
  n=$(find "$dir" -maxdepth 1 -type f -name '[0-9][0-9]-*.txt' | wc -l)
  printf '%s/%02d-%s-%s.%s' "$dir" $((n + 1)) "$kind" "$(printf %s "$slug" | tr -c 'a-zA-Z0-9_.-' '_' | cut -c1-40)" "$ext"
}

ensure_pg() {
  command -v docker >/dev/null || die "docker is not on PATH"
  local state
  if ! state="$(docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null)"; then state=missing; fi
  case "$state" in
    true) ;;
    false) docker start "$PG_CONTAINER" >/dev/null ;;
    missing)
      docker run -d --name "$PG_CONTAINER" -e POSTGRES_PASSWORD="$PG_PASSWORD" \
        -p "127.0.0.1:$PG_PORT:5432" "$PG_IMAGE" >/dev/null ;;
  esac
  for _ in $(seq 1 60); do
    docker exec "$PG_CONTAINER" pg_isready -q -h 127.0.0.1 -U postgres >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "$PG_CONTAINER did not become ready in 60s"
}

psql_run() { docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -X -q -U postgres "$@"; }

cmd_up() {
  local web=0 embed=0 sessions=0 adversary=0 movies=0 direct=0 discovery=0 prober="" torrent=0
  for a in "$@"; do
    case "$a" in
      --web) web=1 ;;
      --embed) embed=1 ;;
      --sessions) sessions=1 ;;
      --adversary) adversary=1 ;;
      --movies) movies=1 ;;
      --direct-stream) direct=1; movies=1 ;;
      --discovery) discovery=1; direct=1; movies=1 ;;
      --torrent) torrent=1; direct=1; movies=1 ;;
      --prober) prober=on ;;
      --prober=on|--prober=off) prober="${a#--prober=}" ;;
      *) die "up: unknown flag $a" ;;
    esac
  done
  [ -z "$prober" ] || [ "$direct" = 1 ] || die "up: --prober needs --direct-stream (direct streaming on, its fake resolver, the fake TMDB and fake powershell.exe)"
  local root run dir db
  root="$(repo_root)"
  [ -f "$root/package.json" ] && grep -q '"name": "mcp-notes"' "$root/package.json" || die "$root is not an mcp-notes checkout"
  [ -x "$root/node_modules/.bin/tsx" ] || die "no node_modules in $root; run npm ci there first"
  if [ "$web" = 1 ] || [ ! -f "$root/web/dist/index.html" ]; then
    echo "verify: building web/ ($root)" >&2
    (cd "$root" && npm run -s build:web >/dev/null) || die "web build failed"
  fi

  run="$(date +%m%d-%H%M%S)-$$"
  dir="$VERIFY_HOME/$run"
  db="v_$(echo "$run" | tr -- '-' '_')"
  mkdir -p "$dir/evidence" "$dir/data" "$dir/claude/projects" "$dir/claude/sessions"
  [ "$sessions" = 1 ] && cp -r "$root/tests/fixtures/claude-home/." "$dir/claude/"

  ensure_pg
  psql_run -c "create database $db" >/dev/null
  echo "$db" >"$dir/db"
  (cd "$root" && DATABASE_URL="$(db_url "$db")" node --input-type=module -e "
    import pg from 'pg'
    import { drizzle } from 'drizzle-orm/node-postgres'
    import { migrate } from 'drizzle-orm/node-postgres/migrator'
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    await pool.end()
  ") || die "migration failed (db $db kept for inspection; verify.sh down $run)"

  # --adversary: a throwaway Seer DB from the Seer checkout's own migrations; never the real one.
  local seer_src="${SEER_DIR:-$HOME/seer}"
  if [ "$adversary" = 1 ]; then
    [ -d "$seer_src/db/migrations" ] || die "--adversary: no Seer migrations at $seer_src/db/migrations (set SEER_DIR)"
    local sdb f
    sdb="s_$(echo "$run" | tr -- '-' '_')"
    psql_run -c "create database $sdb" >/dev/null
    echo "$sdb" >"$dir/seer_db"
    for f in "$seer_src"/db/migrations/*.sql; do
      psql_run -d "$sdb" <"$f" >/dev/null || die "--adversary: Seer migration $(basename "$f") failed (verify.sh down $run)"
    done
    mkdir -p "$dir/seer/engine/data"
    {
      echo "DATABASE_URL_UNPOOLED=$(db_url "$sdb")"
      if [ -f "$HOME/seer/.env.local" ]; then
        grep -E '^(FINNHUB_API_KEY|MASSIVE_API_KEY|SEC_CONTACT_EMAIL)=' "$HOME/seer/.env.local" || true
      fi
    } >"$dir/seer/.env.local"
    chmod 600 "$dir/seer/.env.local"
    if [ -f "$seer_src/engine/data/ticker_cik.csv" ]; then cp "$seer_src/engine/data/ticker_cik.csv" "$dir/seer/engine/data/"; fi
  fi

  # --movies: a generated library, a fake TMDB and a fake VLC pair, all under the run dir. Never the
  # owner's folders, TMDB or VLC: the live .env.local names the real roots, so the env below overrides them.
  local tmdb_port=""
  if [ "$movies" = 1 ]; then
    command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || die "--movies: ffmpeg and ffprobe must be on PATH"
    command -v wslpath >/dev/null || echo "verify: --movies without wslpath: Play will answer player_unavailable" >&2
    "$HERE/movies/make-fixtures.sh" "$VERIFY_HOME/.movies-fixture" || die "--movies: building the fixture library failed"
    mkdir -p "$dir/movies/bin" "$dir/movies/vlc"
    cp -a "$VERIFY_HOME/.movies-fixture/library" "$dir/movies/library"
    cp "$HERE/movies/vlc-qt-interface.ini" "$dir/movies/vlc-qt-interface.ini"
    local node_bin
    node_bin="$(command -v node)"
    printf '#!/bin/sh\nexec "%s" "%s" vlc --state "%s" -- "$@"\n' "$node_bin" "$HERE/movies/fake-vlc.mjs" "$dir/movies/vlc" >"$dir/movies/bin/vlc.exe"
    printf '#!/bin/sh\nexec "%s" "%s" curl --state "%s" -- "$@"\n' "$node_bin" "$HERE/movies/fake-vlc.mjs" "$dir/movies/vlc" >"$dir/movies/bin/curl.exe"
    # The fake powershell.exe: notesd runs it to put VLC's window in front (it finds no window) and,
    # with --prober, to read Windows' idle time, which it takes from movies/idle_ms (0: someone is typing).
    echo 0 >"$dir/movies/idle_ms"
    cat >"$dir/movies/bin/powershell.exe" <<EOF
#!/bin/sh
echo "\$(date -Is) \$#" >>"$dir/movies/vlc/powershell.log"
idle=\$(cat "$dir/movies/idle_ms" 2>/dev/null || echo 0)
echo "{\"found\":false,\"idle_ms\":\$idle}"
EOF
    chmod +x "$dir/movies/bin/vlc.exe" "$dir/movies/bin/curl.exe" "$dir/movies/bin/powershell.exe"
    # --discovery: the fake TMDB also knows the titles, people, studios and services of tmdb-discovery.json.
    local tmdb_extra=()
    if [ "$discovery" = 1 ]; then tmdb_extra=(--extra "$HERE/movies/tmdb-discovery.json"); fi
    setsid node "$HERE/movies/fake-tmdb.mjs" --data "$HERE/movies/tmdb.json" "${tmdb_extra[@]}" \
      --port-file "$dir/movies/tmdb.port" --log "$dir/movies/tmdb.log" </dev/null >"$dir/movies/tmdb.out" 2>&1 &
    echo $! >"$dir/tmdb.pid"
    for _ in $(seq 1 40); do [ -s "$dir/movies/tmdb.port" ] && break; sleep 0.25; done
    [ -s "$dir/movies/tmdb.port" ] || die "--movies: the fake TMDB did not start (log: $dir/movies/tmdb.out; verify.sh down $run)"
    tmdb_port="$(cat "$dir/movies/tmdb.port")"
  fi
  # --direct-stream: a fixture stream host and a fake resolver from tests/fixtures/direct-stream/. Never a
  # provider and never the streaming Chrome: the real resolver opens the owner's Chrome on Windows.
  if [ "$direct" = 1 ]; then
    mkdir -p "$dir/direct"
    # The torrent sites script's stand-in keeps its mode and calls here (tests/fixtures/direct-stream/fake-torrent-sites.mjs).
    mkdir -p "$dir/torrent-sites"
    setsid node "$root/tests/fixtures/direct-stream/upstream.mjs" --info "$dir/direct/upstream.json" \
      --log "$dir/direct/upstream.jsonl" --state "$dir/direct" </dev/null >"$dir/direct/upstream.out" 2>&1 &
    echo $! >"$dir/upstream.pid"
    for _ in $(seq 1 40); do [ -s "$dir/direct/upstream.json" ] && break; sleep 0.25; done
    [ -s "$dir/direct/upstream.json" ] || die "--direct-stream: the fixture stream host did not start (log: $dir/direct/upstream.out; verify.sh down $run)"
  fi
  # --torrent: a loopback seeder of a generated film and season pack (scripts/torrent/). Never a real swarm:
  # the daemon gets NOTESD_TORRENT_DISCOVERY=off (no DHT, no tracker) and the seeder as its only peer.
  # TORRENT_FIXTURE_FILE=<path> seeds that one file as the film (no subtitle file beside it).
  local seed_port=""
  if [ "$torrent" = 1 ]; then
    local fixture film_name film
    fixture="$("$HERE/torrent/make-fixture.sh" "$VERIFY_HOME/.torrent-fixture")" || die "--torrent: building the fixture torrents failed"
    film_name=Fixture.Film.2026.1080p.WEB-DL.x264-NOTESD
    film="$fixture/$film_name"
    mkdir -p "$dir/torrent"
    if [ -n "${TORRENT_FIXTURE_FILE:-}" ]; then
      [ -f "$TORRENT_FIXTURE_FILE" ] || die "--torrent: TORRENT_FIXTURE_FILE=$TORRENT_FIXTURE_FILE is not a file"
      film="$dir/torrent/custom/$film_name"
      mkdir -p "$film"
      cp "$TORRENT_FIXTURE_FILE" "$film/$film_name.${TORRENT_FIXTURE_FILE##*.}"
    fi
    setsid node "$HERE/torrent/seed.mjs" seed --film "$film" --pack "$fixture/Fixture.Show.S01.1080p.WEB-DL.x264-NOTESD" \
      --state "$dir/torrent" --upload-kbps 200 </dev/null >"$dir/torrent/seeder.out" 2>&1 &
    echo $! >"$dir/seeder.pid"
    for _ in $(seq 1 80); do [ -s "$dir/torrent/fixture.json" ] && [ -s "$dir/torrent/pack.json" ] && break; sleep 0.25; done
    [ -s "$dir/torrent/pack.json" ] || die "--torrent: the loopback seeder did not start (log: $dir/torrent/seeder.out; verify.sh down $run)"
    seed_port="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).port)' "$dir/torrent/fixture.json")"
  fi
  # --torrent (torrent phase 3): a fake Torrentio that lists the seeded fixture(s). Never a real index.
  if [ "$torrent" = 1 ]; then
    local index_extra=()
    if [ "$discovery" = 1 ]; then index_extra=(--extra "$HERE/movies/tmdb-discovery.json"); fi
    setsid node "$HERE/torrent/fake-index.mjs" --fixtures "$dir/torrent" --titles "$HERE/movies/tmdb.json" "${index_extra[@]}" \
      --port-file "$dir/torrent/index.port" --log "$dir/torrent/index.jsonl" </dev/null >"$dir/torrent/index.out" 2>&1 &
    echo $! >"$dir/torrent-index.pid"
    for _ in $(seq 1 40); do [ -s "$dir/torrent/index.port" ] && break; sleep 0.25; done
    [ -s "$dir/torrent/index.port" ] || die "--torrent: the fake index did not start (log: $dir/torrent/index.out; verify.sh down $run)"
    # Torrent phase 6: a fake subtitle service in the shape of Stremio's OpenSubtitles add-on, which also
    # answers as Wyzie Subs (/search) for a fake key; never the real ones.
    mkdir -p "$dir/torrent/subs"
    setsid node "$HERE/torrent/fake-subs.mjs" --state "$dir/torrent/subs" --info "$dir/torrent/subs/info.json" \
      --wyzie-key verify-fake-wyzie-key </dev/null >"$dir/torrent/subs/out.log" 2>&1 &
    echo $! >"$dir/subs.pid"
    for _ in $(seq 1 40); do [ -s "$dir/torrent/subs/info.json" ] && break; sleep 0.25; done
    [ -s "$dir/torrent/subs/info.json" ] || die "--torrent: the fake subtitle service did not start (log: $dir/torrent/subs/out.log; verify.sh down $run)"
  fi

  # Real env wins over .env.local, so these pin the instance to the run's own state.
  # OPENROUTER_API_KEY='' turns embeddings off (search reports fallback) unless --embed.
  # NOTESD_ADVERSARY=off unless --adversary: a throwaway daemon never reviews the owner's real Seer.
  mkdir -p "$dir/tmux"
  local -a env=(
    DATABASE_URL="$(db_url "$db")"
    NOTESD_PORT=0
    NOTES_DATA_DIR="$dir/data"
    CLAUDE_HOME="$dir/claude"
    NOTES_WORKTREES_DIR="$dir/worktrees"
    NOTESD_SWARM_SCRIPT="$dir/no-swarm.py"
    # A throwaway daemon never writes into the owner's stream cache folder (.env.local may name one).
    NOTESD_STREAM_CACHE_DIR="$dir/data/movies/stream-cache"
    # A throwaway daemon never writes into the owner's torrent folder either.
    NOTESD_TORRENT_DIR="$dir/data/movies/torrents"
    # Every run's tmux is the recording fake: the report button and resume never open a window in
    # the owner's tmux. TMUX_FAKE (printed below) is where its calls.log and switches live.
    NOTESD_TMUX_BIN="$HERE/stream/fake-tmux.sh"
    NOTESD_FAKE_TMUX_DIR="$dir/tmux"
  )
  [ "$embed" = 1 ] || env+=(OPENROUTER_API_KEY=)
  if [ "$adversary" = 1 ]; then
    env+=(NOTESD_ADVERSARY=on SEER_DIR="$dir/seer" ADVERSARY_POLL_MS="${ADVERSARY_POLL_MS:-5000}")
  else
    env+=(NOTESD_ADVERSARY=off)
  fi
  # NOTESD_MOVIES=off unless --movies: a throwaway daemon never scans the owner's video folders,
  # calls TMDB or starts VLC. --movies points every path and binary at the run's own fakes; the
  # filename fallback is pinned off so nothing is billed.
  if [ "$movies" = 1 ]; then
    env+=(
      NOTESD_MOVIES=on
      "NOTESD_MOVIES_ROOTS=$dir/movies/library/Videos:$dir/movies/library/Telegram Desktop"
      NOTESD_MOVIES_DONE_DIRS=Done
      NOTESD_MOVIES_SCAN_MS=3600000
      NOTESD_MOVIES_MIN_SECONDS=900
      NOTESD_MOVIES_FALLBACK_MODEL=off
      # No story is ever written (a billed model call) on a throwaway daemon; a stored one still opens.
      NOTESD_MOVIES_STORY_MODEL=off
      TMDB_API_READ_ACCESS_TOKEN=verify-fake-token
      TMDB_API_KEY=
      "TMDB_API_BASE=http://127.0.0.1:$tmdb_port/3"
      "TMDB_IMAGE_BASE=http://127.0.0.1:$tmdb_port/t/p"
      "NOTESD_FFPROBE_BIN=$(command -v ffprobe)"
      "NOTESD_VLC_BIN=$dir/movies/bin/vlc.exe"
      "NOTESD_CURL_EXE=$dir/movies/bin/curl.exe"
      "NOTESD_VLC_INI=$dir/movies/vlc-qt-interface.ini"
      NOTESD_VLC_HTTP_PORT=47318
      NOTESD_VLC_POLL_MS=1000
      # Phase 9: never sample the owner's real vlc.exe into verify evidence; no launch flags from .env.local.
      NOTESD_VLC_HEALTH_MS=0
      NOTESD_VLC_EXTRA_ARGS=
      # Never raise or touch a real Windows window from a verify run.
      "NOTESD_POWERSHELL_EXE=$dir/movies/bin/powershell.exe"
    )
  else
    env+=(NOTESD_MOVIES=off)
  fi
  # NOTESD_DIRECT_STREAM=off unless --direct-stream: a --movies run never runs the real resolver.
  # Under --direct-stream the resolver is the fake, unless the caller set NOTESD_DIRECT_STREAM_CLI
  # (phase 6's playcheck wrapper, run only when the owner expects the streaming Chrome to move).
  if [ "$direct" = 1 ]; then
    env+=(
      NOTESD_DIRECT_STREAM=on
      # Never the real anime index (api.ani.zip): a Japanese fixture title would ask it.
      NOTESD_ANIME_MAP_URL=off
      # Never a billed look at a fixture stream's picture (src/directStream/picture.ts).
      NOTESD_STREAM_PICTURE_MODEL=off
      "NOTESD_DIRECT_STREAM_CLI=${NOTESD_DIRECT_STREAM_CLI:-$root/tests/fixtures/direct-stream/fake-cli.mjs}"
      "DIRECT_STREAM_FAKE_DIR=$dir/direct"
      # Never the real torrent sites script: it drives the owner's streaming Chrome on Windows.
      "NOTESD_TORRENT_SITES_CLI=$root/tests/fixtures/direct-stream/fake-torrent-sites.mjs"
      "TORRENT_SITES_FAKE_DIR=$dir/torrent-sites"
      "TORRENT_SITES_FIXTURE=$dir/torrent/fixture.json"
    )
  else
    env+=(NOTESD_DIRECT_STREAM=off)
  fi
  # NOTESD_TORRENT=off unless --torrent: a throwaway daemon never joins a real swarm. --torrent turns discovery
  # off (no DHT, no tracker), names the loopback seeder as every torrent's peer and caps upload at 64 kB/s.
  if [ "$torrent" = 1 ]; then
    env+=(NOTESD_TORRENT=on NOTESD_TORRENT_DISCOVERY=off "NOTESD_TORRENT_PEERS=127.0.0.1:$seed_port" NOTESD_TORRENT_UPLOAD_KBPS=64 NOTESD_TORRENT_KEEP_DAYS=7)
  else
    env+=(NOTESD_TORRENT=off)
  fi
  # Torrent phase 3: the finder asks only the fake index on a --torrent run, and no index at all otherwise.
  if [ "$torrent" = 1 ]; then
    env+=(
      "NOTESD_TORRENT_TORRENTIO_URL=http://127.0.0.1:$(cat "$dir/torrent/index.port")"
      NOTESD_TORRENT_APIBAY_URL=off NOTESD_TORRENT_EZTV_URL=off NOTESD_TORRENT_YTS_URL=off NOTESD_TORRENT_MIN_SEEDS=1
    )
  else
    env+=(NOTESD_TORRENT_TORRENTIO_URL=off NOTESD_TORRENT_APIBAY_URL=off NOTESD_TORRENT_EZTV_URL=off NOTESD_TORRENT_YTS_URL=off)
  fi
  # Torrent phase 5: the remux runs with this machine's ffmpeg; NOTESD_TORRENT_REMUX=off from the caller passes through.
  if [ "$torrent" = 1 ]; then
    env+=(
      "NOTESD_TORRENT_REMUX=${NOTESD_TORRENT_REMUX:-on}"
      # The subtitle journeys (subtitles.sh, synced.sh, codenames.sh) read a play's subtitle in its answer, so the
      # play waits for the whole chain here. torrent/speed.sh needs the daemon's own wait: start its run with
      # NOTESD_TORRENT_SUBTITLE_WAIT_MS=1500.
      "NOTESD_TORRENT_SUBTITLE_WAIT_MS=${NOTESD_TORRENT_SUBTITLE_WAIT_MS:-40000}"
    )
  fi
  # Torrent phase 6: a throwaway daemon never asks the real subtitle services (.env.local may hold the owner's
  # WYZIE_API_KEY). --torrent points both at the fake one, with a fake key.
  if [ "$torrent" = 1 ]; then
    local subs_origin
    subs_origin="$(jq -r .origin "$dir/torrent/subs/info.json")"
    env+=("NOTESD_TORRENT_SUBTITLE_URL=$subs_origin" "NOTESD_TORRENT_WYZIE_URL=$subs_origin" WYZIE_API_KEY=verify-fake-wyzie-key)
  else
    env+=(NOTESD_TORRENT_SUBTITLE_URL=off NOTESD_TORRENT_WYZIE_URL=off WYZIE_API_KEY=)
  fi
  # NOTESD_STREAM_PROBER=off unless --prober: a throwaway daemon never probes on its own. --prober=off
  # leaves the setting blank, which is how "unset" reaches the daemon (the real environment wins over
  # .env.local). Direct streaming itself is --direct-stream (fake resolver).
  case "$prober" in
    on) env+=(NOTESD_STREAM_PROBER=on NOTESD_STREAM_PROBE_MS=5000) ;;
    off) env+=(NOTESD_STREAM_PROBER=) ;;
    *) env+=(NOTESD_STREAM_PROBER=off) ;;
  esac
  # NOTESD_STREAMING=off always, and no flag turns it on: streaming_find / streaming_play would run
  # the real claude/streaming/cli.mjs, which plays a film full screen in the owner's streaming Chrome.
  env+=(NOTESD_STREAMING=off)
  {
    echo "repo=$root"
    echo "head=$(git -C "$root" rev-parse --short HEAD)"
    echo "dirty=$(git -C "$root" status --porcelain | wc -l)"
    echo "embed=$embed"
    echo "adversary=$adversary"
    echo "movies=$movies"
    echo "direct_stream=$direct"
    echo "prober=${prober:-pinned_off}"
    echo "torrent=$torrent"
    [ "$adversary" = 1 ] && echo "seer_migrations=$seer_src"
  } >"$dir/meta"

  # setsid leads its own process group (so `down` kills exactly this tree), and every fd is
  # redirected so no caller's pipe stays open behind the daemon.
  cd "$root"
  setsid env "${env[@]}" node_modules/.bin/tsx src/main.ts </dev/null >"$dir/daemon.log" 2>&1 &
  echo $! >"$dir/pid"
  local port=""
  for _ in $(seq 1 60); do
    port="$(sed -nE 's#.*listening on http://127\.0\.0\.1:([0-9]+).*#\1#p' "$dir/daemon.log" | head -1)"
    [ -n "$port" ] && break
    kill -0 "$(cat "$dir/pid")" 2>/dev/null || { tail -20 "$dir/daemon.log" >&2; die "daemon exited during startup (verify.sh down $run)"; }
    sleep 0.5
  done
  [ -n "$port" ] || die "daemon did not report a port in 30s (log: $dir/daemon.log)"
  echo "$port" >"$dir/port"
  curl -fsS "http://127.0.0.1:$port/health" >/dev/null || die "health check failed on $port"
  echo "RUN=$run"
  echo "URL=http://127.0.0.1:$port"
  echo "EVIDENCE=$dir/evidence"
  echo "LOG=$dir/daemon.log"
  echo "TMUX_FAKE=$dir/tmux"
  if [ "$movies" = 1 ]; then echo "MOVIES=$dir/movies"; fi
  if [ "$direct" = 1 ]; then echo "DIRECT=$dir/direct"; fi
  if [ "$torrent" = 1 ]; then echo "TORRENT=$dir/torrent"; fi
  if [ "$torrent" = 1 ]; then echo "SUBS=$dir/torrent/subs"; fi
}

cmd_doctor() {
  local dir pid port ok=1
  dir="$(run_dir "${1:-}")"
  pid="$(cat "$dir/pid" 2>/dev/null || true)"
  port="$(cat "$dir/port" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "process  ok   pid $pid"; else echo "process  FAIL not running"; ok=0; fi
  if [ -n "$port" ] && curl -fsS -m 3 "http://127.0.0.1:$port/health" | grep -q notesd; then
    echo "health   ok   http://127.0.0.1:$port"
  else
    echo "health   FAIL http://127.0.0.1:${port:-?}/health"; ok=0
  fi
  local owner
  owner="$(ss -ltnpH "sport = :${port:-0}" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)"
  if [ -n "$owner" ] && [ "$(ps -o pgid= -p "$owner" | tr -d ' ')" = "$pid" ]; then
    echo "port     ok   owned by this run (pid $owner)"
  elif [ -n "$owner" ]; then
    echo "port     FAIL :$port belongs to pid $owner, not this run"; ok=0
  fi
  if psql_run -d "$(cat "$dir/db")" -tAc "select count(*) from notes" >/dev/null 2>&1; then echo "database ok   $(cat "$dir/db")"; else echo "database FAIL $(cat "$dir/db")"; ok=0; fi
  if [ -f "$dir/tmdb.pid" ]; then
    if kill -0 "$(cat "$dir/tmdb.pid")" 2>/dev/null && curl -fsS -m 3 "http://127.0.0.1:$(cat "$dir/movies/tmdb.port")/health" >/dev/null; then
      echo "tmdb     ok   fake TMDB on :$(cat "$dir/movies/tmdb.port")"
    else
      echo "tmdb     FAIL fake TMDB is not answering"; ok=0
    fi
  fi
  sed 's/^/meta     /' "$dir/meta"
  local root
  root="$(sed -n 's/^repo=//p' "$dir/meta")"
  if [ "$(git -C "$root" rev-parse --short HEAD)" != "$(sed -n 's/^head=//p' "$dir/meta")" ]; then
    echo "code     WARN HEAD moved since up; restart (down + up) if the change is server-side"
  fi
  grep -iE "error|unhandled" "$dir/daemon.log" | tail -3 | sed 's/^/log      /' || true
  [ "$ok" = 1 ] || exit 1
}

cmd_api() {
  local dir method path body out code
  dir="$(run_dir "${1:-}")"; method=${2:?METHOD}; path=${3:?PATH}; body=${4:-}
  out="$(next_evidence "$dir" api "$method$path" txt)"
  local -a args=(-sS -o "$out.body" -w '%{http_code} %{content_type}' -X "$method" "http://127.0.0.1:$(cat "$dir/port")$path")
  # Same-origin routes (bin, reveal, resume) check Origin; the wall sends its own.
  args+=(-H "Origin: http://127.0.0.1:$(cat "$dir/port")")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data "$body")
  local meta ctype
  meta="$(curl "${args[@]}")"
  code=${meta%% *}; ctype=${meta#* }
  {
    echo "> $method $path"; [ -n "$body" ] && echo "> $body"; echo "< HTTP $code $ctype"
    if [[ $ctype =~ json|text|event-stream ]] || [ ! -s "$out.body" ]; then
      cat "$out.body"; echo
      rm -f "$out.body"
    else
      # Binary (images, downloads): keep the bytes beside the transcript, print what they are.
      mv "$out.body" "${out%.txt}.bin"
      echo "[binary $(wc -c <"${out%.txt}.bin") bytes, sha256 $(sha256sum "${out%.txt}.bin" | cut -c1-16): ${out%.txt}.bin]"
    fi
  } >"$out"
  cat "$out"
  echo "[evidence: $out]" >&2
}

cmd_upload() {
  local dir path file body out code
  dir="$(run_dir "${1:-}")"; path=${2:?PATH}; file=${3:?FILE}; body=${4:-}
  [ -f "$file" ] || die "no such file: $file"
  out="$(next_evidence "$dir" upload "$(basename "$file")" txt)"
  local -a args=(-sS -o "$out.body" -w '%{http_code}' -X POST "http://127.0.0.1:$(cat "$dir/port")$path"
    -H "Origin: http://127.0.0.1:$(cat "$dir/port")" -F "file=@$file")
  [ -n "$body" ] && args+=(-F "body=$body")
  code="$(curl "${args[@]}")"
  { echo "> POST $path file=$file${body:+ body=$body}"; echo "< HTTP $code"; cat "$out.body"; echo; } >"$out"
  rm -f "$out.body"
  cat "$out"
  echo "[evidence: $out]" >&2
}

cmd_mcp() {
  local dir tool args out
  dir="$(run_dir "${1:-}")"; tool=${2:?TOOL}; args=${3:-'{}'}
  out="$(next_evidence "$dir" mcp "$tool" txt)"
  node "$HERE/mcp.mjs" "http://127.0.0.1:$(cat "$dir/port")/mcp" "$tool" "$args" | tee "$out"
  echo "[evidence: $out]" >&2
}

cmd_ui() {
  local dir steps
  dir="$(run_dir "${1:-}")"; steps=${2:?STEPS.mjs}
  [ -f "$steps" ] || die "no such steps file: $steps"
  (cd "$(sed -n 's/^repo=//p' "$dir/meta")" && node "$HERE/ui.mjs" "http://127.0.0.1:$(cat "$dir/port")" "$(realpath "$steps")" "$dir/evidence")
}

cmd_sql() {
  local dir out
  dir="$(run_dir "${1:-}")"
  out="$(next_evidence "$dir" sql query txt)"
  { echo "> ${2:?SQL}"; printf 'begin read only;\n%s;\nrollback;\n' "$2" | psql_run -d "$(cat "$dir/db")" 2>&1; } | tee "$out"
  echo "[evidence: $out]" >&2
}

cmd_exec() {
  local dir db target=notes out
  dir="$(run_dir "${1:-}")"; shift
  if [ "${1:-}" = --seer ]; then target=seer; shift; fi
  if [ "$target" = seer ]; then
    [ -f "$dir/seer_db" ] || die "exec --seer: this run was not started with --adversary"
    db="$(cat "$dir/seer_db")"
  else
    db="$(cat "$dir/db")"
  fi
  out="$(next_evidence "$dir" "exec-$target" query txt)"
  { echo "> [$target] ${1:?SQL}"; printf '%s;\n' "$1" | psql_run -d "$db" 2>&1; } | tee "$out"
  echo "[evidence: $out]" >&2
}

cmd_note() {
  local dir
  dir="$(run_dir "${1:-}")"
  echo "$(date -Iseconds) ${2:?TEXT}" >>"$dir/evidence/LOG.md"
}

cmd_vlc() {
  local dir out
  dir="$(run_dir "${1:-}")"; shift
  [ -d "$dir/movies/vlc" ] || die "vlc: this run was not started with --movies"
  out="$(next_evidence "$dir" vlc "${*:-args}" txt)"
  node "$HERE/movies/fake-vlc.mjs" control --state "$dir/movies/vlc" "$@" | tee "$out"
  echo "[evidence: $out]" >&2
}

stop_run() {
  local dir=$1 pid f
  pid="$(cat "$dir/pid" 2>/dev/null || true)"
  # setsid made the daemon a process-group leader: kill exactly the group `up` started.
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  # --movies: the fake VLCs were started detached by the daemon, the fake TMDB by `up`; keep their records.
  if [ -d "$dir/movies" ]; then
    for f in "$dir"/movies/vlc/*.pid; do
      if [ -f "$f" ]; then kill -TERM "$(cat "$f")" 2>/dev/null || true; fi
    done
    if [ -f "$dir/movies/tmdb.log" ]; then cp "$dir/movies/tmdb.log" "$dir/evidence/movies-tmdb-requests.log"; fi
    if [ -f "$dir/movies/vlc/launches.jsonl" ]; then cp "$dir/movies/vlc/launches.jsonl" "$dir/evidence/movies-vlc-launches.jsonl"; fi
    if [ -f "$dir/movies/vlc/commands.jsonl" ]; then cp "$dir/movies/vlc/commands.jsonl" "$dir/evidence/movies-vlc-commands.jsonl"; fi
  fi
  if [ -f "$dir/tmdb.pid" ]; then
    kill -TERM -- "-$(cat "$dir/tmdb.pid")" 2>/dev/null || kill -TERM "$(cat "$dir/tmdb.pid")" 2>/dev/null || true
  fi
  # --direct-stream: the fixture stream host was started by `up`; keep its request log and the fake resolver's calls.
  if [ -f "$dir/upstream.pid" ]; then
    kill -TERM -- "-$(cat "$dir/upstream.pid")" 2>/dev/null || kill -TERM "$(cat "$dir/upstream.pid")" 2>/dev/null || true
  fi
  if [ -f "$dir/direct/upstream.jsonl" ]; then cp "$dir/direct/upstream.jsonl" "$dir/evidence/direct-upstream-requests.jsonl"; fi
  if [ -f "$dir/direct/calls.jsonl" ]; then cp "$dir/direct/calls.jsonl" "$dir/evidence/direct-resolver-calls.jsonl"; fi
  if [ -f "$dir/torrent-sites/calls.jsonl" ]; then cp "$dir/torrent-sites/calls.jsonl" "$dir/evidence/torrent-sites-calls.jsonl"; fi
  # --torrent: the loopback seeder was started by `up`; keep its log.
  if [ -f "$dir/seeder.pid" ]; then
    kill -TERM -- "-$(cat "$dir/seeder.pid")" 2>/dev/null || kill -TERM "$(cat "$dir/seeder.pid")" 2>/dev/null || true
  fi
  if [ -f "$dir/torrent/seeder.jsonl" ]; then cp "$dir/torrent/seeder.jsonl" "$dir/evidence/torrent-seeder.jsonl"; fi
  # --torrent: the fake index was started by `up`; keep its request log.
  if [ -f "$dir/torrent-index.pid" ]; then
    kill -TERM -- "-$(cat "$dir/torrent-index.pid")" 2>/dev/null || kill -TERM "$(cat "$dir/torrent-index.pid")" 2>/dev/null || true
    rm -f "$dir/torrent-index.pid"
  fi
  if [ -f "$dir/torrent/index.jsonl" ]; then cp "$dir/torrent/index.jsonl" "$dir/evidence/torrent-index-requests.jsonl"; fi
  # --torrent: the fake subtitle service was started by `up`; keep its request logs.
  if [ -f "$dir/subs.pid" ]; then
    kill -TERM -- "-$(cat "$dir/subs.pid")" 2>/dev/null || kill -TERM "$(cat "$dir/subs.pid")" 2>/dev/null || true
    rm -f "$dir/subs.pid"
  fi
  if [ -f "$dir/torrent/subs/requests.jsonl" ]; then cp "$dir/torrent/subs/requests.jsonl" "$dir/evidence/torrent-subtitle-requests.jsonl"; fi
  if [ -f "$dir/torrent/subs/wyzie-requests.jsonl" ]; then cp "$dir/torrent/subs/wyzie-requests.jsonl" "$dir/evidence/torrent-wyzie-requests.jsonl"; fi
  if [ -f "$dir/db" ] && docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
    psql_run -c "drop database if exists $(cat "$dir/db") with (force)" >/dev/null || true
  fi
  if [ -f "$dir/seer_db" ] && docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
    psql_run -c "drop database if exists $(cat "$dir/seer_db") with (force)" >/dev/null || true
  fi
  rm -rf "$dir/data" "$dir/claude" "$dir/worktrees" "$dir/seer" "$dir/movies" "$dir/pid" "$dir/port" "$dir/db" "$dir/seer_db" "$dir/tmdb.pid" "$dir/torrent" "$dir/seeder.pid"
  echo "verify: stopped $(basename "$dir"); evidence kept in $dir/evidence ($(find "$dir/evidence" -type f | wc -l) files)"
}

cmd_down() {
  if [ "${1:-}" = --all ]; then
    for d in "$VERIFY_HOME"/*/; do [ -f "$d/pid" ] && stop_run "${d%/}"; done
    return 0
  fi
  stop_run "$(run_dir "${1:-}")"
}

cmd_ls() {
  [ -d "$VERIFY_HOME" ] || return 0
  for d in "$VERIFY_HOME"/*/; do
    d=${d%/}
    local state=stopped
    [ -f "$d/pid" ] && kill -0 "$(cat "$d/pid")" 2>/dev/null && state="up :$(cat "$d/port" 2>/dev/null)"
    printf '%-22s %-12s %3s evidence  %s\n' "$(basename "$d")" "$state" "$(find "$d/evidence" -type f | wc -l)" "$(sed -n 's/^repo=//p' "$d/meta" 2>/dev/null)"
  done
}

sub=${1:-}; shift || true
case "$sub" in
  up) cmd_up "$@" ;;
  doctor) cmd_doctor "$@" ;;
  api) cmd_api "$@" ;;
  upload) cmd_upload "$@" ;;
  mcp) cmd_mcp "$@" ;;
  ui) cmd_ui "$@" ;;
  sql) cmd_sql "$@" ;;
  exec) cmd_exec "$@" ;;
  note) cmd_note "$@" ;;
  vlc) cmd_vlc "$@" ;;
  down) cmd_down "$@" ;;
  ls) cmd_ls ;;
  *) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
