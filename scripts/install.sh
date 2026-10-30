#!/usr/bin/env bash
# Install or refresh notesd as a systemd user service, register it with Claude Code as the
# `notes` MCP server (user scope), and link the /n skill into ~/.claude/skills/n.
#
# Idempotent: run it again after every pull. The unit runs code from the checkout this script
# lives in, so run it from the checkout you want the daemon to use (normally ~/mcp-notes).
#
# Env overrides:
#   NODE_BIN        absolute path to a Node >= 22 binary (default: `node` on PATH, then
#                   ~/tools/node-v22.23.1-linux-x64/bin/node)
#   CLAUDE_BIN      path to the claude CLI (default: `claude` on PATH, then next to node)
#   NOTES_DATA_DIR  data dir (default: ~/mcp-notes-data)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
UNIT_NAME="notesd.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_TEMPLATE="$REPO_DIR/deploy/notesd.service"
SKILL_SRC="$REPO_DIR/claude/skills/n"
SKILLS_DIR="$HOME/.claude/skills"
SKILL_DST="$SKILLS_DIR/n"
DATA_DIR="${NOTES_DATA_DIR:-$HOME/mcp-notes-data}"
PORT=7317
HEALTH_URL="http://127.0.0.1:$PORT/health"
MCP_URL="http://localhost:$PORT/mcp"
DEFAULT_NODE="$HOME/tools/node-v22.23.1-linux-x64/bin/node"
HEALTH_WAIT_SECONDS=30

log()  { printf '==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

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
}

check_preconditions() {
  command -v curl >/dev/null || die "curl is required."
  command -v systemctl >/dev/null || die "systemctl not found: systemd is required (WSL: [boot] systemd=true in /etc/wsl.conf)."
  systemctl --user show-environment >/dev/null 2>&1 \
    || die "cannot reach the systemd user manager (systemctl --user). Is systemd enabled in this distro?"
  [[ -f "$UNIT_TEMPLATE" ]] || die "missing $UNIT_TEMPLATE."
  [[ -f "$SKILL_SRC/SKILL.md" ]] || die "missing $SKILL_SRC/SKILL.md."
  [[ -f "$REPO_DIR/package-lock.json" ]] || die "missing $REPO_DIR/package-lock.json."
  local p
  for p in "$REPO_DIR" "$NODE_BIN" "$NODE_DIR" "$DATA_DIR"; do
    [[ "$p" != *'|'* && "$p" != *'&'* && "$p" != *'\'* ]] \
      || die "path contains a character the unit renderer cannot handle (| & \\): $p"
  done
  if [[ -e "$SKILL_DST" && ! -L "$SKILL_DST" ]]; then
    die "$SKILL_DST exists and is not a symlink. Move it away, then re-run (refusing to clobber a real directory)."
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

install_unit() {
  local rendered
  rendered="$(mktemp)"
  sed -e "s|@NODE_BIN@|$NODE_BIN|g" \
      -e "s|@NODE_DIR@|$NODE_DIR|g" \
      -e "s|@REPO_DIR@|$REPO_DIR|g" \
      -e "s|@DATA_DIR@|$DATA_DIR|g" \
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
  if [[ -L "$SKILL_DST" ]]; then
    log "replacing skill symlink $SKILL_DST -> $SKILL_SRC"
  else
    log "linking skill $SKILL_DST -> $SKILL_SRC"
  fi
  ln -sfn "$SKILL_SRC" "$SKILL_DST"
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
  printf 'skill: %s -> %s\n' "$SKILL_DST" "$(readlink "$SKILL_DST")"
  printf 'linger: %s\n' "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo unknown)"
  printf 'unit runs: %s/dist/main.js\n' "$REPO_DIR"
  if [[ "$REPO_DIR" == "$HOME/.worktrees/"* ]]; then
    warn "the unit and the skill point at a worktree ($REPO_DIR). After the branch lands, re-run: cd ~/mcp-notes && git pull && scripts/install.sh"
  fi
  printf 'Windows side (keeps WSL up at logon): see docs/INSTALL.md, scripts/windows/install-wsl-keepalive.ps1\n'
  (( ok == 1 )) || die "verification failed."
  printf 'OK\n'
}

main() {
  resolve_node
  resolve_claude
  check_preconditions
  install_deps
  build
  make_data_dir
  install_unit
  enable_linger
  wait_for_health
  register_mcp
  link_skill
  verify
}

main "$@"
