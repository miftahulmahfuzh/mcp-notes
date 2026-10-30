#!/usr/bin/env bash
# Undo scripts/install.sh on the WSL side: stop and remove the notesd user unit, unregister the
# `notes` MCP server (user scope) and remove the /n skill symlink.
# Keeps the data dir (~/mcp-notes-data) and linger. The Windows keepalive task is removed by
# scripts/windows/install-wsl-keepalive.ps1 -Uninstall.
set -euo pipefail

UNIT_NAME="notesd.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SKILL_DST="$HOME/.claude/skills/n"
DATA_DIR="${NOTES_DATA_DIR:-$HOME/mcp-notes-data}"
DEFAULT_CLAUDE="$HOME/tools/node-v22.23.1-linux-x64/bin/claude"

log()  { printf '==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

if [[ -f "$UNIT_DIR/$UNIT_NAME" ]]; then
  log "stopping and disabling $UNIT_NAME"
  systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
  rm -f "$UNIT_DIR/$UNIT_NAME"
  systemctl --user daemon-reload
  systemctl --user reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true
else
  log "no unit at $UNIT_DIR/$UNIT_NAME"
fi

CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || true)}"
if [[ -z "$CLAUDE_BIN" && -x "$DEFAULT_CLAUDE" ]]; then CLAUDE_BIN="$DEFAULT_CLAUDE"; fi
if [[ -n "$CLAUDE_BIN" ]]; then
  log "removing MCP server 'notes' (user scope)"
  "$CLAUDE_BIN" mcp remove --scope user notes >/dev/null 2>&1 || log "'notes' was not registered"
else
  warn "claude CLI not found; remove the MCP server by hand: claude mcp remove --scope user notes"
fi

if [[ -L "$SKILL_DST" ]]; then
  log "removing skill symlink $SKILL_DST"
  rm -f "$SKILL_DST"
elif [[ -e "$SKILL_DST" ]]; then
  warn "$SKILL_DST is not a symlink; left alone"
fi

printf '\nKept: data dir %s (delete by hand if you mean it), linger (sudo loginctl disable-linger %s).\n' "$DATA_DIR" "$USER"
printf 'Windows: powershell -ExecutionPolicy Bypass -File scripts\\windows\\install-wsl-keepalive.ps1 -Uninstall\n'
