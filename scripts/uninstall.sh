#!/usr/bin/env bash
# Undo scripts/install.sh on the WSL side: stop and remove the notesd user unit, unregister the
# `notes` MCP server (user scope), remove the /n skill symlink, and remove the five hook entries
# (notes-capture, notes-paste, notes-prompt, notes-session, notes-spawn) from
# ~/.claude/settings.json (every other setting and hook is kept). Keeps the data dir
# (~/mcp-notes-data), linger, the hooks' outbox, pasted-image memos and logs
# (~/.local/state/notes-capture), settings.json.bak-notes-hooks, and the raised cleanupPeriodDays
# (lowering it would let Claude Code delete the transcript history; edit it by hand if you mean
# it). The Windows keepalive task is removed by scripts/windows/install-wsl-keepalive.ps1 -Uninstall.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
UNIT_NAME="notesd.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SKILL_DST="$HOME/.claude/skills/n"
DATA_DIR="${NOTES_DATA_DIR:-$HOME/mcp-notes-data}"
DEFAULT_CLAUDE="$HOME/tools/node-v22.23.1-linux-x64/bin/claude"
DEFAULT_NODE="$HOME/tools/node-v22.23.1-linux-x64/bin/node"
HOOKS_HELPER="$REPO_DIR/scripts/claude-hooks.mjs"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

log()  { printf '==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

remove_unit() {
  if [[ -f "$UNIT_DIR/$UNIT_NAME" ]]; then
    log "stopping and disabling $UNIT_NAME"
    systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/$UNIT_NAME"
    systemctl --user daemon-reload
    systemctl --user reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true
  else
    log "no unit at $UNIT_DIR/$UNIT_NAME"
  fi
}

remove_mcp() {
  local claude_bin="${CLAUDE_BIN:-$(command -v claude || true)}"
  if [[ -z "$claude_bin" && -x "$DEFAULT_CLAUDE" ]]; then claude_bin="$DEFAULT_CLAUDE"; fi
  if [[ -n "$claude_bin" ]]; then
    log "removing MCP server 'notes' (user scope)"
    "$claude_bin" mcp remove --scope user notes >/dev/null 2>&1 || log "'notes' was not registered"
  else
    warn "claude CLI not found; remove the MCP server by hand: claude mcp remove --scope user notes"
  fi
}

remove_skill() {
  if [[ -L "$SKILL_DST" ]]; then
    log "removing skill symlink $SKILL_DST"
    rm -f "$SKILL_DST"
  elif [[ -e "$SKILL_DST" ]]; then
    warn "$SKILL_DST is not a symlink; left alone"
  fi
}

unregister_hooks() {
  if [[ ! -f "$CLAUDE_SETTINGS" ]]; then
    log "no $CLAUDE_SETTINGS; no hooks to remove"
    return 0
  fi
  local node_bin="${NODE_BIN:-$(command -v node || true)}"
  if [[ -z "$node_bin" && -x "$DEFAULT_NODE" ]]; then node_bin="$DEFAULT_NODE"; fi
  if [[ -z "$node_bin" ]]; then
    warn "node not found; remove the notes-capture, notes-paste, notes-prompt, notes-session and notes-spawn entries from $CLAUDE_SETTINGS by hand"
    return 0
  fi
  log "removing the five Claude Code hooks (notes-capture, notes-paste, notes-prompt, notes-session, notes-spawn) from $CLAUDE_SETTINGS"
  "$node_bin" "$HOOKS_HELPER" uninstall --settings "$CLAUDE_SETTINGS" \
    || warn "could not edit $CLAUDE_SETTINGS; remove the notes-capture, notes-paste, notes-prompt, notes-session and notes-spawn entries by hand"
  log "kept cleanupPeriodDays in $CLAUDE_SETTINGS (lowering it would let Claude Code delete old transcripts)"
}

main() {
  remove_unit
  remove_mcp
  remove_skill
  unregister_hooks
  printf '\nKept: data dir %s (delete by hand if you mean it), linger (sudo loginctl disable-linger %s).\n' "$DATA_DIR" "${USER:-$(id -un)}"
  printf 'Windows: powershell -ExecutionPolicy Bypass -File scripts\\windows\\install-wsl-keepalive.ps1 -Uninstall\n'
}

# Run only when executed; `source scripts/uninstall.sh` (the tests) just defines the functions.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
