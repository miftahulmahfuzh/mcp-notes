/**
 * Names the environment scan in scripts/docs/reference.ts finds that are not notesd settings, each
 * with the reason it stays out of docs/guide/reference/configuration.md.
 */
export const ENV_IGNORED: Record<string, string> = {
  HOME: 'The user\'s home directory, set by the system. The hooks and install script build default paths from it.',
  PATH: 'The system search path. Read to find binaries given as bare names (claude, gh, explorer.exe, wslpath).',
  TMUX: 'Set by tmux inside a pane. The notes-session hook reads it to tell whether the session runs in tmux.',
  TMUX_PANE: 'Set by tmux inside a pane. The notes-session hook reports it so resume can find the pane.',
  XDG_CONFIG_HOME: 'XDG base directory. install.sh and uninstall.sh put the systemd user unit under it (default ~/.config).',
  XDG_STATE_HOME: 'XDG base directory. The hooks keep their outbox and logs under it (default ~/.local/state).',
  CLAUDE_AGENT_SDK_CLIENT_APP: 'Written, never read: notesd sets it in the environment of the Claude children it starts, as their User-Agent tag.',
  CLAUDE_CODE_ENTRYPOINT: 'Set by Claude Code. The notes-session hook reads it to skip non-terminal sessions; notesd strips it from the children it starts.',
  CLAUDE_CODE_SESSION_ID: 'Set by Claude Code. Only named so that it is stripped from the environment of a resumed or spawned session.',
  CLAUDE_CODE_CHILD_SESSION: 'Set by Claude Code. Only named so that it is stripped from the environment of a resumed or spawned session.',
  CLAUDE_PID: 'Set by Claude Code in its shell. The notes-session hook reads it to find the session\'s process; notesd strips it from its Claude children.',
};
