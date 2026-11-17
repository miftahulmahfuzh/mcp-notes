#!/usr/bin/env bash
# Install or refresh notesd as a systemd user service, register it with Claude Code as the
# `notes` MCP server (user scope), link the /n skill into ~/.claude/skills/n, and register the
# six mcp-notes Claude Code hooks in ~/.claude/settings.json: notes-capture (Stop, saves /n
# exchanges to the chat history), notes-link (PostToolUse on the notes write tools, links each
# note written in a session to that session's node), notes-paste (PreToolUse on similar_images, uploads a pasted
# image), notes-prompt (UserPromptSubmit on /n prompts, stores the session's pasted images and
# names their ids), notes-session (SessionStart, reports the session to the session graph and
# tells it its node id) and notes-spawn (PreToolUse on Bash, records a hand-rolled tmux `claude`
# launch so the child links to its parent). It also raises Claude Code's cleanupPeriodDays so
# the transcripts the session graph ingests are not deleted after 30 days.
# It also installs Whisper for the torrent source's last subtitle tier: a Python virtual
# environment in <data dir>/whisper/venv with faster-whisper, and the model .env.local names
# (NOTESD_TORRENT_WHISPER_MODEL, default small), unless .env.local turns torrents or Whisper off.
#
# Idempotent: run it again after every pull. The unit runs code from the checkout this script
# lives in, so run it from the checkout you want the daemon to use (normally ~/mcp-notes).
#
# It never restarts the daemon under a film: when the running daemon says it is busy
# (GET /api/movies/player `busy`: a VLC play it follows, a stream on screen, or a stream play
# still being started), nothing is built or restarted and the script exits 75.
#
# Flags:
#   --skip-hooks    do not touch ~/.claude/settings.json (same as NOTES_SKIP_HOOKS=1)
#   --check-idle    only ask the daemon: exit 0 when nothing is playing or starting (or no
#                   daemon answers), 75 when it is busy, with what is; nothing is changed
#   --wait          when busy, wait until the daemon is idle (asked every 20 s, at most
#                   NOTES_INSTALL_WAIT_SECONDS, default 6 hours), then install
#   --force         install and restart even when busy (same as NOTES_INSTALL_FORCE=1)
#
# Env overrides:
#   NODE_BIN        absolute path to a Node >= 22 binary (default: `node` on PATH, then
#                   ~/tools/node-v22.23.1-linux-x64/bin/node)
#   CLAUDE_BIN      path to the claude CLI (default: `claude` on PATH, then next to node). The
#                   unit gets its real path (readlink -f) as NOTESD_CLAUDE_BIN for the chat bar.
#   NOTES_DATA_DIR  data dir (default: ~/mcp-notes-data)
#   SKIP_CHAT_CHECK set to 1 to skip the chat smoke check in the verification (offline runs)
#   NOTES_SKIP_HOOKS set to 1 to leave ~/.claude/settings.json alone
#   NOTES_PASTE_STRATEGY  `deny` registers the paste hook in its fallback mode (see
#                   claude/hooks/notes-paste.mjs); default `updatedInput`
#   NOTES_INSTALL_FORCE  set to 1 to restart even while something plays or starts (--force)
#   NOTES_INSTALL_WAIT_SECONDS  how long --wait waits for the daemon to be idle (default 21600)
#   NOTES_CLAUDE_RETENTION_DAYS  minimum cleanupPeriodDays (default 3650, ten years); a higher
#                   value already in settings.json is kept
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
UNIT_NAME="notesd.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_TEMPLATE="$REPO_DIR/deploy/notesd.service"
SKILLS_SRC_DIR="$REPO_DIR/claude/skills"
SKILLS_DIR="$HOME/.claude/skills"
SKILL_NAMES=(n migrate check-seer-adversarial-nightly redo v j trace-vlc-bug pahe idlix lk21 flicksy create-streaming-skill direct-stream update-cloud-source report-stream-bug)
DATA_DIR="${NOTES_DATA_DIR:-$HOME/mcp-notes-data}"
PORT=7317
HEALTH_URL="http://127.0.0.1:$PORT/health"
PLAYER_URL="http://127.0.0.1:$PORT/api/movies/player"
MOVIES_DB_CONTAINER=mcp-notes-pg-movies
MOVIES_DB_IMAGE=pgvector/pgvector:pg16
MOVIES_DB_PORT=55437
MOVIES_DB_NAME=mcp_notes_movies
MOVIES_DB_PASSWORD=mcpnotes
# EX_TEMPFAIL: the daemon is busy (something plays or is being started); try again later.
BUSY_EXIT=75
FORCE="${NOTES_INSTALL_FORCE:-0}"
WAIT_IDLE=0
CHECK_IDLE_ONLY=0
WAIT_IDLE_SECONDS="${NOTES_INSTALL_WAIT_SECONDS:-21600}"
WAIT_IDLE_EVERY=20
# 9 readings 20 s apart: three minutes, longer than a play takes to resolve.
OLD_DAEMON_QUIET_CHECKS=9
CHAT_URL="http://127.0.0.1:$PORT/api/chat"
MCP_URL="http://localhost:$PORT/mcp"
DEFAULT_NODE="$HOME/tools/node-v22.23.1-linux-x64/bin/node"
CLAUDE_CREDENTIALS="$HOME/.claude/.credentials.json"
HEALTH_WAIT_SECONDS=30
# A little above the daemon's default CHAT_TIMEOUT_MS (180 s), so the daemon's own timeout fires first.
CHAT_SMOKE_SECONDS=200
# Notes-only and read-only: it exercises the SDK child, the login and the notes MCP tools, no web.
CHAT_SMOKE_MESSAGE='Install check. Call the notes tags tool once, then reply with only the number of tags it returned. Use no other tool.'
HOOKS_DIR="$REPO_DIR/claude/hooks"
HOOKS_HELPER="$REPO_DIR/scripts/claude-hooks.mjs"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
SKIP_HOOKS="${NOTES_SKIP_HOOKS:-0}"
PASTE_STRATEGY="${NOTES_PASTE_STRATEGY:-updatedInput}"
RETENTION_DAYS="${NOTES_CLAUDE_RETENTION_DAYS:-3650}"
ENV_LOCAL="$REPO_DIR/.env.local"
WHISPER_PACKAGE="faster-whisper==1.2.1"
WHISPER_SCRIPT="$REPO_DIR/claude/streaming/torrent/whisper.py"

log()  { printf '==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

parse_args() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --skip-hooks) SKIP_HOOKS=1 ;;
      --force) FORCE=1 ;;
      --wait) WAIT_IDLE=1 ;;
      --check-idle) CHECK_IDLE_ONLY=1 ;;
      -h|--help)
        sed -n '2,45p' "${BASH_SOURCE[0]}"
        exit 0
        ;;
      *) die "unknown argument: $arg (try --help)" ;;
    esac
  done
}

resolve_node() {
  local n="${NODE_BIN:-}"
  if [[ -z "$n" ]]; then n="$(command -v node || true)"; fi
  if [[ -z "$n" && -x "$DEFAULT_NODE" ]]; then n="$DEFAULT_NODE"; fi
  [[ -n "$n" && -x "$n" ]] || die "node not found. Set NODE_BIN=/absolute/path/to/node (Node 22)."
  n="$(readlink -f "$n")"
  local major
  major="$("$n" -p 'process.versions.node.split(".")[0]')"
  (( major >= 22 )) || die "notesd needs Node >= 22; $n is $("$n" -v)."
  NODE_BIN="$n"
  NODE_DIR="$(dirname "$n")"
  NPM_BIN="$NODE_DIR/npm"
  [[ -x "$NPM_BIN" ]] || die "npm not found next to node at $NPM_BIN."
  # npm's shebang is `#!/usr/bin/env node`: make it find this node.
  export PATH="$NODE_DIR:$PATH"
}

resolve_claude() {
  local c="${CLAUDE_BIN:-}"
  if [[ -z "$c" ]]; then c="$(command -v claude || true)"; fi
  if [[ -z "$c" && -x "$NODE_DIR/claude" ]]; then c="$NODE_DIR/claude"; fi
  [[ -n "$c" && -x "$c" ]] || die "claude CLI not found. Set CLAUDE_BIN=/path/to/claude."
  CLAUDE_BIN="$c"
  # The daemon's Agent SDK spawns this file directly. The unit gets the real path so it depends
  # on neither the unit's minimal PATH nor the bin/claude symlink.
  CLAUDE_REAL="$(readlink -f "$c")"
  [[ -f "$CLAUDE_REAL" && -x "$CLAUDE_REAL" ]] \
    || die "claude resolves to $CLAUDE_REAL, which is not an executable file. Set CLAUDE_BIN=/path/to/claude."
}

check_preconditions() {
  command -v curl >/dev/null || die "curl is required."
  command -v systemctl >/dev/null || die "systemctl not found: systemd is required (WSL: [boot] systemd=true in /etc/wsl.conf)."
  systemctl --user show-environment >/dev/null 2>&1 \
    || die "cannot reach the systemd user manager (systemctl --user). Is systemd enabled in this distro?"
  [[ -f "$UNIT_TEMPLATE" ]] || die "missing $UNIT_TEMPLATE."
  local sk
  for sk in "${SKILL_NAMES[@]}"; do
    [[ -f "$SKILLS_SRC_DIR/$sk/SKILL.md" ]] || die "missing $SKILLS_SRC_DIR/$sk/SKILL.md."
  done
  [[ -f "$REPO_DIR/package-lock.json" ]] || die "missing $REPO_DIR/package-lock.json."
  local hk
  for hk in "$HOOKS_DIR/notes-capture.mjs" "$HOOKS_DIR/notes-paste.mjs" "$HOOKS_DIR/notes-prompt.mjs" \
            "$HOOKS_DIR/notes-session.mjs" "$HOOKS_DIR/notes-spawn.mjs" "$HOOKS_HELPER"; do
    [[ -f "$hk" ]] || die "missing $hk."
  done
  [[ "$PASTE_STRATEGY" == "updatedInput" || "$PASTE_STRATEGY" == "deny" ]] \
    || die "NOTES_PASTE_STRATEGY must be updatedInput or deny (got $PASTE_STRATEGY)."
  local p
  for p in "$REPO_DIR" "$NODE_BIN" "$NODE_DIR" "$DATA_DIR" "$CLAUDE_REAL" "$HOME"; do
    [[ "$p" != *'|'* && "$p" != *'&'* && "$p" != *'\'* ]] \
      || die "path contains a character the unit renderer cannot handle (| & \\): $p"
  done
  for sk in "${SKILL_NAMES[@]}"; do
    if [[ -e "$SKILLS_DIR/$sk" && ! -L "$SKILLS_DIR/$sk" ]]; then
      die "$SKILLS_DIR/$sk exists and is not a symlink. Move it away, then re-run (refusing to clobber a real directory)."
    fi
  done
}

# Warn only: the login may live somewhere this check does not know about. The chat smoke check
# in verify() is the real test.
check_claude_login() {
  if [[ -f "$CLAUDE_CREDENTIALS" ]]; then
    log "claude login found: $CLAUDE_CREDENTIALS"
  else
    warn "no $CLAUDE_CREDENTIALS. The chat bar's Claude brain runs on your Claude Code login: run \`claude\` once and /login. If your login is stored elsewhere, ignore this; the chat check below decides."
  fi
}

# Warn only: a missing .env.local makes the daemon fail its health check later anyway, with the
# reason in the journal. This says why up front, and whether the GLM fallback is configured.
check_env_file() {
  local f="$REPO_DIR/.env.local"
  if [[ ! -e "$f" ]]; then
    warn "missing $f. The daemon reads DATABASE_URL (and LLM_* for the chat bar's GLM fallback) from it. In a worktree: ln -s ~/mcp-notes/.env.local $f"
    return 0
  fi
  if ! grep -qE '^LLM_BASE_URL=.+' "$f" || ! grep -qE '^LLM_API_KEY=.+' "$f" || ! grep -qE '^LLM_MODEL=.+' "$f"; then
    warn "$f has no complete LLM_BASE_URL / LLM_API_KEY / LLM_MODEL: the chat bar's GLM fallback is off."
  fi
}

install_deps() {
  cd "$REPO_DIR"
  if [[ ! -d node_modules ]] || [[ package-lock.json -nt node_modules/.package-lock.json ]]; then
    log "npm ci"
    "$NPM_BIN" ci
  else
    log "node_modules up to date, skipping npm ci"
  fi
}

build() {
  cd "$REPO_DIR"
  log "npm run build"
  "$NPM_BIN" run build
  [[ -f "$REPO_DIR/dist/main.js" ]] || die "build did not produce $REPO_DIR/dist/main.js."
}

make_data_dir() {
  log "data dir $DATA_DIR"
  mkdir -p "$DATA_DIR"
}

# This machine's own Postgres for the movie_* and stream_* tables (MOVIES_DATABASE_URL): a Docker
# container with a named volume that Docker starts again after a reboot. The daemon migrates it at
# start and copies the shared database's movie tables into it once. Idempotent; any failure warns and
# returns, and the movie tables then stay in the shared database. A MOVIES_DATABASE_URL already in
# .env.local that names another database is the owner's and is left alone.
install_movies_db() {
  local url="postgres://postgres:$MOVIES_DB_PASSWORD@127.0.0.1:$MOVIES_DB_PORT/$MOVIES_DB_NAME" current state i
  [[ -f "$ENV_LOCAL" ]] || return 0
  if is_off "$(env_local_value NOTESD_MOVIES)"; then
    return 0
  fi
  current="$(env_local_value MOVIES_DATABASE_URL)"
  if [[ -n "$current" && "$current" != "$url" ]]; then
    log "movies database: .env.local names its own MOVIES_DATABASE_URL, leaving it alone"
    return 0
  fi
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    warn "movies database: docker is not usable here, so the movie tables stay in the shared database. Install Docker and re-run, or set MOVIES_DATABASE_URL in $ENV_LOCAL to a Postgres on this machine."
    return 0
  fi
  if ! state="$(docker inspect -f '{{.State.Running}}' "$MOVIES_DB_CONTAINER" 2>/dev/null)"; then
    log "movies database: creating container $MOVIES_DB_CONTAINER (127.0.0.1:$MOVIES_DB_PORT)"
    docker run -d --name "$MOVIES_DB_CONTAINER" --restart unless-stopped \
      -e POSTGRES_PASSWORD="$MOVIES_DB_PASSWORD" -e POSTGRES_DB="$MOVIES_DB_NAME" \
      -p "127.0.0.1:$MOVIES_DB_PORT:5432" -v "$MOVIES_DB_CONTAINER:/var/lib/postgresql/data" \
      "$MOVIES_DB_IMAGE" >/dev/null || { warn "movies database: could not create $MOVIES_DB_CONTAINER; the movie tables stay in the shared database."; return 0; }
  elif [[ "$state" != "true" ]]; then
    log "movies database: starting container $MOVIES_DB_CONTAINER"
    docker start "$MOVIES_DB_CONTAINER" >/dev/null || { warn "movies database: could not start $MOVIES_DB_CONTAINER."; return 0; }
  fi
  for i in $(seq 1 60); do
    if docker exec "$MOVIES_DB_CONTAINER" pg_isready -U postgres -d "$MOVIES_DB_NAME" >/dev/null 2>&1; then
      if [[ -z "$current" ]]; then
        log "movies database: adding MOVIES_DATABASE_URL to $ENV_LOCAL"
        printf '\n# The movie and stream tables live in a database on this machine (scripts/install.sh).\nMOVIES_DATABASE_URL=%s\n' "$url" >> "$ENV_LOCAL"
      fi
      log "movies database: $MOVIES_DB_CONTAINER is ready"
      return 0
    fi
    sleep 1
  done
  warn "movies database: $MOVIES_DB_CONTAINER did not become ready; the movie tables stay in the shared database until the next run."
}

# The last value of NAME in .env.local (quotes stripped), or nothing. The daemon reads the same file.
env_local_value() {
  [[ -f "$ENV_LOCAL" ]] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_LOCAL" | tail -n 1 \
    | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# True for the words the daemon reads as off.
is_off() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    off|0|false|no) return 0 ;;
    *) return 1 ;;
  esac
}

# A Python 3.9+ that can make a virtual environment. Ubuntu's own python3 has no ensurepip until
# python3-venv is installed; that is tried with sudo -n, never with a password prompt.
whisper_base_python() {
  local py
  for py in "$(command -v python3 || true)" "$HOME/miniconda3/bin/python3" /usr/bin/python3; do
    [[ -n "$py" && -x "$py" ]] || continue
    if "$py" -c 'import sys, ensurepip, venv; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
      printf '%s\n' "$py"
      return 0
    fi
  done
  if [[ -x /usr/bin/python3 ]] && sudo -n apt-get install -y python3-venv >/dev/null 2>&1 \
     && /usr/bin/python3 -c 'import ensurepip, venv' >/dev/null 2>&1; then
    printf '%s\n' /usr/bin/python3
    return 0
  fi
  return 1
}

# Whisper for the torrent source's last subtitle tier (src/directStream/torrent/subtitles/whisper.ts).
# Idempotent: a venv that already has WHISPER_PACKAGE is kept, and the model is downloaded once.
# Any failure warns and returns: the daemon then starts without a Whisper tier and says so.
install_whisper() {
  if is_off "$(env_local_value NOTESD_TORRENT)" || is_off "$(env_local_value NOTESD_TORRENT_WHISPER)"; then
    log "Whisper: torrents or Whisper are off in $ENV_LOCAL, skipping"
    return 0
  fi
  local dir model venv py base ready
  dir="$(env_local_value NOTESD_TORRENT_WHISPER_DIR)"
  dir="${dir:-$DATA_DIR/whisper}"
  model="$(env_local_value NOTESD_TORRENT_WHISPER_MODEL)"
  model="${model:-small}"
  venv="$dir/venv"
  py="$venv/bin/python"
  mkdir -p "$dir/models" "$dir/hf"
  if [[ -x "$py" ]] && "$py" -I -c 'import importlib.metadata as m, sys; sys.exit(0 if m.version("faster-whisper") == sys.argv[1] else 1)' "${WHISPER_PACKAGE#*==}" >/dev/null 2>&1; then
    log "Whisper: $WHISPER_PACKAGE already in $venv"
  else
    if ! base="$(whisper_base_python)"; then
      warn "Whisper: no Python 3.9+ here can make a virtual environment (Ubuntu: python3-venv). Torrent sessions get no Whisper subtitles until one can."
      return 0
    fi
    log "Whisper: virtual environment $venv (from $base), pip install $WHISPER_PACKAGE"
    if ! "$base" -m venv --clear "$venv" >/dev/null 2>&1 \
       || ! "$py" -m pip install --quiet --disable-pip-version-check "$WHISPER_PACKAGE"; then
      warn "Whisper: could not install $WHISPER_PACKAGE into $venv. Torrent sessions get no Whisper subtitles; re-run to try again."
      return 0
    fi
  fi
  log "Whisper: model $model in $dir/models (downloaded once: about 460 MB for small)"
  if ready="$(HF_HOME="$dir/hf" HF_HUB_DISABLE_TELEMETRY=1 "$py" -I "$WHISPER_SCRIPT" --model "$model" --threads 2 --models-dir "$dir/models" --download-only 2>/dev/null | tail -n 1)" \
     && [[ "$ready" != *'"ready": false'* ]]; then
    log "Whisper: ready ${ready}"
  else
    warn "Whisper: model $model could not be loaded (${ready:-no answer}). The daemon downloads it on the first Whisper play instead."
  fi
}

# What the running daemon is busy with, one line per thing, or nothing when it is idle. No daemon,
# an older daemon without `busy`, or an answer that is not JSON all count as idle: there is no
# play to protect that this script could know of.
busy_reasons() {
  local body
  body="$(curl -fsS --max-time 5 "$PLAYER_URL" 2>/dev/null)" || return 0
  printf '%s' "$body" | "$NODE_BIN" -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      let p;
      try { p = JSON.parse(raw); } catch { return; }
      if (p === null || typeof p !== "object") return;
      const out = [];
      if (p.current) out.push(`VLC is open on ${p.current.name ?? "a file"} (${p.current.state ?? "playing"})`);
      if (p.stream) out.push(`a stream is on screen from ${p.stream.provider ?? "a provider"} (${p.stream.state ?? "playing"}, ${p.stream.title_id ?? ""})`);
      for (const s of Array.isArray(p.starting) ? p.starting : []) {
        out.push(`a play of ${s.title ?? "a title"} is being started since ${s.since ?? "?"}: ${s.stage ?? "starting"}`);
      }
      if (out.length === 0 && p.busy === true) out.push("the daemon says it is busy");
      process.stdout.write(out.join("\n"));
    });' 2>/dev/null || true
}

# Exits BUSY_EXIT when the daemon is busy, unless --force; with --wait, waits for it to be idle.
guard_idle() {
  local reasons waited=0
  reasons="$(busy_reasons)"
  if [[ -z "$reasons" ]]; then
    return 0
  fi
  if [[ "$FORCE" == "1" ]]; then
    warn "restarting although the daemon is busy (--force):"
    printf '%s\n' "$reasons" | sed 's/^/  /' >&2
    return 0
  fi
  if [[ "$WAIT_IDLE" != "1" ]]; then
    printf 'BUSY: notesd is not restarted, because:\n' >&2
    printf '%s\n' "$reasons" | sed 's/^/  /' >&2
    printf 'Nothing was changed. Run it again when the film is over, with --wait to wait for that, or with --force to restart anyway (exit %s).\n' "$BUSY_EXIT" >&2
    exit "$BUSY_EXIT"
  fi
  log "waiting until notesd is idle (at most ${WAIT_IDLE_SECONDS}s):"
  printf '%s\n' "$reasons" | sed 's/^/  /'
  # A daemon from before `starting` shows nothing while a play is being resolved (up to about 150 s), so with one
  # the wait goes on until it has looked idle OLD_DAEMON_QUIET_CHECKS times in a row.
  local quiet=0 need=1
  while :; do
    if [[ -z "$reasons" ]]; then
      quiet=$(( quiet + 1 ))
      need=1
      if ! daemon_lists_starting; then need="$OLD_DAEMON_QUIET_CHECKS"; fi
      if (( quiet >= need )); then break; fi
    else
      quiet=0
    fi
    if (( waited >= WAIT_IDLE_SECONDS )); then
      printf 'BUSY: notesd was still busy after %ss; nothing was restarted (exit %s).\n' "$waited" "$BUSY_EXIT" >&2
      exit "$BUSY_EXIT"
    fi
    sleep "$WAIT_IDLE_EVERY"
    waited=$(( waited + WAIT_IDLE_EVERY ))
    reasons="$(busy_reasons)"
  done
  log "notesd is idle after ${waited}s"
}

# True when the running daemon's answer lists the plays being started (or no daemon answers at all).
daemon_lists_starting() {
  local body
  body="$(curl -fsS --max-time 5 "$PLAYER_URL" 2>/dev/null)" || return 0
  printf '%s' "$body" | "$NODE_BIN" -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      try { process.exit(Array.isArray(JSON.parse(raw).starting) ? 0 : 1); } catch { process.exit(0); }
    });' 2>/dev/null
}

# --check-idle: the one question, and nothing else.
check_idle() {
  FORCE=0
  WAIT_IDLE=0
  guard_idle
  log "notesd is idle: nothing is playing or being started"
}

install_unit() {
  local rendered
  rendered="$(mktemp)"
  sed -e "s|@NODE_BIN@|$NODE_BIN|g" \
      -e "s|@NODE_DIR@|$NODE_DIR|g" \
      -e "s|@REPO_DIR@|$REPO_DIR|g" \
      -e "s|@DATA_DIR@|$DATA_DIR|g" \
      -e "s|@CLAUDE_BIN@|$CLAUDE_REAL|g" \
      -e "s|@HOME_DIR@|$HOME|g" \
      "$UNIT_TEMPLATE" > "$rendered"
  if grep -q '@[A-Z_]*@' "$rendered"; then
    rm -f "$rendered"
    die "unrendered placeholder left in the unit; check $UNIT_TEMPLATE."
  fi
  mkdir -p "$UNIT_DIR"
  if cmp -s "$rendered" "$UNIT_DIR/$UNIT_NAME"; then
    log "unit unchanged: $UNIT_DIR/$UNIT_NAME"
  else
    log "installing unit: $UNIT_DIR/$UNIT_NAME"
    install -m 0644 "$rendered" "$UNIT_DIR/$UNIT_NAME"
  fi
  rm -f "$rendered"
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT_NAME" >/dev/null
  # Asked again: the build above took minutes, and a play may have been asked for meanwhile.
  guard_idle
  log "restarting $UNIT_NAME"
  systemctl --user restart "$UNIT_NAME"
}

enable_linger() {
  local linger
  linger="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
  if [[ "$linger" == "yes" ]]; then
    log "linger already enabled for $USER"
    return
  fi
  log "loginctl enable-linger $USER"
  if loginctl enable-linger "$USER" 2>/dev/null; then return; fi
  if sudo -n loginctl enable-linger "$USER" 2>/dev/null; then return; fi
  warn "could not enable linger without a password. Run: sudo loginctl enable-linger $USER"
}

wait_for_health() {
  log "waiting for $HEALTH_URL"
  local i
  for (( i = 0; i < HEALTH_WAIT_SECONDS; i++ )); do
    if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  journalctl --user -u "$UNIT_NAME" -n 50 --no-pager >&2 || true
  die "notesd did not answer $HEALTH_URL within ${HEALTH_WAIT_SECONDS}s (log above)."
}

register_mcp() {
  log "registering MCP server 'notes' at user scope -> $MCP_URL"
  "$CLAUDE_BIN" mcp remove --scope user notes >/dev/null 2>&1 || true
  "$CLAUDE_BIN" mcp add --scope user --transport http notes "$MCP_URL"
}

link_skill() {
  mkdir -p "$SKILLS_DIR"
  local sk src dst
  for sk in "${SKILL_NAMES[@]}"; do
    src="$SKILLS_SRC_DIR/$sk"
    dst="$SKILLS_DIR/$sk"
    if [[ -L "$dst" ]]; then
      log "replacing skill symlink $dst -> $src"
    else
      log "linking skill $dst -> $src"
    fi
    ln -sfn "$src" "$dst"
  done
}

# Merge the six hook entries into ~/.claude/settings.json (user scope: every repo). Everything
# else in the file is kept; a copy of the original is kept once at settings.json.bak-notes-hooks.
# A failure here warns and leaves the file alone: the daemon install is not undone for it.
register_hooks() {
  if [[ "$SKIP_HOOKS" == 1 ]]; then
    log "skipping Claude Code hooks (--skip-hooks / NOTES_SKIP_HOOKS=1)"
    return 0
  fi
  log "registering the six Claude Code hooks (notes-capture, notes-link, notes-paste, notes-prompt, notes-session, notes-spawn) in $CLAUDE_SETTINGS"
  "$NODE_BIN" "$HOOKS_HELPER" install \
    --settings "$CLAUDE_SETTINGS" \
    --node "$NODE_BIN" \
    --hooks-dir "$HOOKS_DIR" \
    --paste-strategy "$PASTE_STRATEGY" \
    || warn "could not update $CLAUDE_SETTINGS; /n exchanges will not be captured and sessions will not be linked. Fix the file and re-run, or pass --skip-hooks."
}

# Claude Code deletes transcripts older than cleanupPeriodDays (default 30) at startup. The session
# graph ingests them into Postgres, but a session that was never ingested (daemon down for a month,
# the other laptop) would be lost, so keep them for at least RETENTION_DAYS. A higher value is kept;
# uninstall does not lower it. Same backup and atomic write as register_hooks; --skip-hooks skips it.
raise_retention() {
  if [[ "$SKIP_HOOKS" == 1 ]]; then
    log "skipping cleanupPeriodDays (--skip-hooks / NOTES_SKIP_HOOKS=1)"
    return 0
  fi
  if [[ ! "$RETENTION_DAYS" =~ ^[1-9][0-9]{0,5}$ ]]; then
    warn "NOTES_CLAUDE_RETENTION_DAYS must be a positive integer (got $RETENTION_DAYS); cleanupPeriodDays left alone."
    return 0
  fi
  log "keeping Claude Code transcripts for at least $RETENTION_DAYS days (cleanupPeriodDays in $CLAUDE_SETTINGS)"
  "$NODE_BIN" "$HOOKS_HELPER" retention --settings "$CLAUDE_SETTINGS" --min-days "$RETENTION_DAYS" \
    || warn "could not update cleanupPeriodDays in $CLAUDE_SETTINGS; Claude Code keeps transcripts for its default 30 days."
}


# One real chat message through the installed daemon. Success = the SSE stream's last event is
# `done`. The brain that answered is printed; anything but claude is a warning (GLM answering
# means the Claude login or usage limit failed and the fallback worked).
chat_smoke() {
  if [[ "${SKIP_CHAT_CHECK:-}" == 1 ]]; then
    printf 'POST %s: skipped (SKIP_CHAT_CHECK=1)\n' "$CHAT_URL"
    return 0
  fi
  local body resp last done_data brain err
  body="$(printf '{"message":"%s"}' "$CHAT_SMOKE_MESSAGE")"
  resp="$(curl -sS -N --max-time "$CHAT_SMOKE_SECONDS" \
    -H 'content-type: application/json' -H 'accept: text/event-stream' \
    --data-binary "$body" "$CHAT_URL" 2>&1)" || true
  last="$(printf '%s\n' "$resp" | sed -n 's/^event: *//p' | tail -n 1)"
  if [[ "$last" == "done" ]]; then
    done_data="$(printf '%s\n' "$resp" | sed -n '/^event: *done/{n;s/^data: *//p;}' | tail -n 1)"
    brain="$(printf '%s' "$done_data" | grep -o '"brain":"[a-z]*"' | cut -d'"' -f4 || true)"
    printf 'POST %s: done, brain=%s\n' "$CHAT_URL" "${brain:-<none>}"
    if [[ "$brain" != "claude" ]]; then
      warn "the chat check was answered by ${brain:-no brain (the stub?)}, not claude. Check the login and: journalctl --user -u $UNIT_NAME -n 50"
    fi
    return 0
  fi
  err="$(printf '%s\n' "$resp" | sed -n '/^event: *error/{n;s/^data: *//p;}' | tail -n 1)"
  if [[ -z "$err" ]]; then err="$(printf '%s' "$resp" | tail -c 300)"; fi
  printf 'POST %s: FAILED (last event: %s; %s)\n' "$CHAT_URL" "${last:-<none>}" "$err"
  return 1
}

verify() {
  local ok=1 active health mcp_line
  printf '\n--- verification ---\n'
  active="$(systemctl --user is-active "$UNIT_NAME" 2>&1 || true)"
  printf 'systemctl --user is-active %s: %s\n' "$UNIT_NAME" "$active"
  [[ "$active" == "active" ]] || ok=0
  if health="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>&1)"; then
    printf 'GET %s: %s\n' "$HEALTH_URL" "$health"
  else
    printf 'GET %s: FAILED (%s)\n' "$HEALTH_URL" "$health"
    ok=0
  fi
  mcp_line="$("$CLAUDE_BIN" mcp list 2>&1 | grep -E '^notes: ' || true)"
  printf 'claude mcp list: %s\n' "${mcp_line:-<notes not listed>}"
  [[ "$mcp_line" == *Connected* ]] || ok=0
  printf 'chat bar claude: %s (%s)\n' "$CLAUDE_REAL" "$("$CLAUDE_REAL" --version 2>/dev/null || echo 'version unknown')"
  chat_smoke || ok=0
  for sk in "${SKILL_NAMES[@]}"; do
    printf 'skill: %s -> %s\n' "$SKILLS_DIR/$sk" "$(readlink "$SKILLS_DIR/$sk")"
  done
  if [[ "$SKIP_HOOKS" == 1 ]]; then
    printf 'claude hooks: skipped\n'
  else
    "$NODE_BIN" "$HOOKS_HELPER" status --settings "$CLAUDE_SETTINGS" 2>&1 | sed 's/^/claude hook: /' || true
  fi
  printf 'linger: %s\n' "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo unknown)"
  printf 'unit runs: %s/dist/main.js\n' "$REPO_DIR"
  if [[ "$REPO_DIR" == "$HOME/.worktrees/"* ]]; then
    warn "the unit, the skill and the hooks point at a worktree ($REPO_DIR). After the branch lands, re-run: cd ~/mcp-notes && git pull && scripts/install.sh"
  fi
  printf 'Windows side (keeps WSL up at logon): see docs/guide/install.md, scripts/windows/install-wsl-keepalive.ps1\n'
  (( ok == 1 )) || die "verification failed."
  printf 'OK\n'
}

main() {
  parse_args "$@"
  resolve_node
  if [[ "$CHECK_IDLE_ONLY" == "1" ]]; then
    check_idle
    exit 0
  fi
  # Before the build: it rewrites dist/ under the running daemon.
  guard_idle
  resolve_claude
  check_preconditions
  check_claude_login
  check_env_file
  install_deps
  build
  make_data_dir
  install_movies_db
  install_whisper
  install_unit
  enable_linger
  wait_for_health
  register_mcp
  link_skill
  register_hooks
  raise_retention
  verify
}

# Run only when executed; `source scripts/install.sh` (the tests) just defines the functions.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
