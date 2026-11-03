#!/usr/bin/env bash
# verify.sh: launch, drive and tear down a throwaway notesd for verification.
#
# Every run gets its own database (in one shared Docker Postgres), its own port, data dir and
# CLAUDE_HOME. Nothing touches the live daemon on 7317, Neon, ~/mcp-notes-data or ~/.claude.
# Evidence lives under $VERIFY_HOME/<run>/evidence and survives `down`.
#
#   verify.sh up [--web] [--embed] [--sessions]
#                                       start an instance from the current checkout; prints RUN= and URL=
#                                       --sessions seeds CLAUDE_HOME from tests/fixtures/claude-home
#   verify.sh doctor RUN                is this instance worth driving? (read-only)
#   verify.sh api RUN METHOD PATH [JSON]   HTTP call; request + response saved as evidence
#   verify.sh upload RUN PATH FILE [body]  multipart POST (images, files); saved as evidence
#   verify.sh mcp RUN TOOL [JSON]       MCP tool call over /mcp; saved as evidence
#   verify.sh ui RUN STEPS.mjs          drive the wall with Playwright (video + final screenshot)
#   verify.sh sql RUN "SELECT ..."      read the run's database (read-only transaction)
#   verify.sh note RUN "TEXT"           append a line to the run's evidence log (what you proved)
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
  local web=0 embed=0 sessions=0
  for a in "$@"; do
    case "$a" in
      --web) web=1 ;;
      --embed) embed=1 ;;
      --sessions) sessions=1 ;;
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

  # Real env wins over .env.local, so these pin the instance to the run's own state.
  # OPENROUTER_API_KEY='' turns embeddings off (search reports fallback) unless --embed.
  local -a env=(
    DATABASE_URL="$(db_url "$db")"
    NOTESD_PORT=0
    NOTES_DATA_DIR="$dir/data"
    CLAUDE_HOME="$dir/claude"
    NOTES_WORKTREES_DIR="$dir/worktrees"
    NOTESD_SWARM_SCRIPT="$dir/no-swarm.py"
  )
  [ "$embed" = 1 ] || env+=(OPENROUTER_API_KEY=)
  {
    echo "repo=$root"
    echo "head=$(git -C "$root" rev-parse --short HEAD)"
    echo "dirty=$(git -C "$root" status --porcelain | wc -l)"
    echo "embed=$embed"
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

cmd_note() {
  local dir
  dir="$(run_dir "${1:-}")"
  echo "$(date -Iseconds) ${2:?TEXT}" >>"$dir/evidence/LOG.md"
}

stop_run() {
  local dir=$1 pid
  pid="$(cat "$dir/pid" 2>/dev/null || true)"
  # setsid made the daemon a process-group leader: kill exactly the group `up` started.
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  if [ -f "$dir/db" ] && docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
    psql_run -c "drop database if exists $(cat "$dir/db") with (force)" >/dev/null || true
  fi
  rm -rf "$dir/data" "$dir/claude" "$dir/worktrees" "$dir/pid" "$dir/port" "$dir/db"
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
  note) cmd_note "$@" ;;
  down) cmd_down "$@" ;;
  ls) cmd_ls ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
