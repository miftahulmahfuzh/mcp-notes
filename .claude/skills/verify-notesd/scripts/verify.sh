#!/usr/bin/env bash
# verify.sh: launch, drive and tear down a throwaway notesd for verification.
#
# Every run gets its own database (in one shared Docker Postgres), its own port, data dir and
# CLAUDE_HOME. Nothing touches the live daemon on 7317, Neon, ~/mcp-notes-data or ~/.claude.
# Evidence lives under $VERIFY_HOME/<run>/evidence and survives `down`.
#
#   verify.sh up [--web] [--embed] [--sessions] [--adversary] [--movies]
#                                       start an instance from the current checkout; prints RUN= and URL=
#                                       --sessions seeds CLAUDE_HOME from tests/fixtures/claude-home
#                                       --adversary turns the Seer reviewer on against a throwaway Seer DB
#                                       built from ${SEER_DIR:-~/seer}/db/migrations (reviews are real, billed)
#                                       --movies turns the Movies library on against a generated video tree,
#                                       a fake TMDB and a fake vlc.exe/curl.exe (scripts/movies/); else it is off
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
  local web=0 embed=0 sessions=0 adversary=0 movies=0
  for a in "$@"; do
    case "$a" in
      --web) web=1 ;;
      --embed) embed=1 ;;
      --sessions) sessions=1 ;;
      --adversary) adversary=1 ;;
      --movies) movies=1 ;;
      *) die "up: unknown flag $a" ;;
    esac
  done
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
    # The fake powershell.exe: notesd runs it to put VLC's window in front. It logs the call and finds no window.
    printf '#!/bin/sh\necho "$(date -Is) $#" >>"%s"\necho "{\\"found\\":false}"\n' "$dir/movies/vlc/powershell.log" >"$dir/movies/bin/powershell.exe"
    chmod +x "$dir/movies/bin/vlc.exe" "$dir/movies/bin/curl.exe" "$dir/movies/bin/powershell.exe"
    setsid node "$HERE/movies/fake-tmdb.mjs" --data "$HERE/movies/tmdb.json" \
      --port-file "$dir/movies/tmdb.port" --log "$dir/movies/tmdb.log" </dev/null >"$dir/movies/tmdb.out" 2>&1 &
    echo $! >"$dir/tmdb.pid"
    for _ in $(seq 1 40); do [ -s "$dir/movies/tmdb.port" ] && break; sleep 0.25; done
    [ -s "$dir/movies/tmdb.port" ] || die "--movies: the fake TMDB did not start (log: $dir/movies/tmdb.out; verify.sh down $run)"
    tmdb_port="$(cat "$dir/movies/tmdb.port")"
  fi

  # Real env wins over .env.local, so these pin the instance to the run's own state.
  # OPENROUTER_API_KEY='' turns embeddings off (search reports fallback) unless --embed.
  # NOTESD_ADVERSARY=off unless --adversary: a throwaway daemon never reviews the owner's real Seer.
  local -a env=(
    DATABASE_URL="$(db_url "$db")"
    NOTESD_PORT=0
    NOTES_DATA_DIR="$dir/data"
    CLAUDE_HOME="$dir/claude"
    NOTES_WORKTREES_DIR="$dir/worktrees"
    NOTESD_SWARM_SCRIPT="$dir/no-swarm.py"
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
  {
    echo "repo=$root"
    echo "head=$(git -C "$root" rev-parse --short HEAD)"
    echo "dirty=$(git -C "$root" status --porcelain | wc -l)"
    echo "embed=$embed"
    echo "adversary=$adversary"
    echo "movies=$movies"
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
  if [ "$movies" = 1 ]; then echo "MOVIES=$dir/movies"; fi
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
  if [ -f "$dir/db" ] && docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
    psql_run -c "drop database if exists $(cat "$dir/db") with (force)" >/dev/null || true
  fi
  if [ -f "$dir/seer_db" ] && docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
    psql_run -c "drop database if exists $(cat "$dir/seer_db") with (force)" >/dev/null || true
  fi
  rm -rf "$dir/data" "$dir/claude" "$dir/worktrees" "$dir/seer" "$dir/movies" "$dir/pid" "$dir/port" "$dir/db" "$dir/seer_db" "$dir/tmdb.pid"
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
  *) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
