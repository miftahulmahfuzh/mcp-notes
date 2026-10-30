> Adopted from `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` phase 3. Source: `.workflows/plan/notes-spine-images-ui/phase-3.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 3: /n skill, systemd unit, install + Windows scripts, live verification

**Plan set:** `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md`
**Analysis:** `docs/analyzer/20261030-092006-K7N3_code_analyzer.md`
**Satisfies:** R1 — `/n` from any repo reaches a `notesd` that starts on its own (systemd user unit + linger + Windows keepalive) and is registered with Claude Code at user scope
**Depends on:** Phase 2 (and so Phase 1)
**Difficulty:** NORMAL
**Package:** `claude/`, `deploy/`, `scripts/`, `docs/`

---

## Goal

After this phase, one command (`scripts/install.sh`) builds the daemon, installs and starts it as
a systemd user service that survives logout and reboot, registers it with Claude Code as the
`notes` MCP server at user scope, and links the versioned `/n` skill into `~/.claude/skills/n`.
A PowerShell script registers the Windows logon task that keeps WSL up, and `docs/INSTALL.md`
says, with sources, why that task is needed. The phase ends with the installer run from the
worktree and the three live checks recorded.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `claude/skills/n/SKILL.md`: the user-level `/n` skill (frontmatter `name: n`)
- `deploy/notesd.service`: systemd user unit **template** with placeholders `@NODE_BIN@`, `@NODE_DIR@`, `@REPO_DIR@`, `@DATA_DIR@`
- `scripts/install.sh`: idempotent installer (env overrides: `NODE_BIN`, `CLAUDE_BIN`, `NOTES_DATA_DIR`)
- `scripts/uninstall.sh`: reverses the WSL side of `install.sh`
- `scripts/windows/install-wsl-keepalive.ps1`: params `-Distro` (default `Ubuntu`), `-TaskName` (default `mcp-notes WSL keepalive`), `-Uninstall`, `-NoStart`
- `docs/INSTALL.md`
- External state (not in git): `~/.config/systemd/user/notesd.service`, `~/.claude/skills/n` → `<checkout>/claude/skills/n` symlink, the `notes` entry in Claude Code's user-scope MCP config, `Linger=yes` for `$USER`, `~/mcp-notes-data/`, the Windows scheduled task.

**Signature changes:** none.

**Requires (from earlier phases):**
- `package.json` script `build` that produces `dist/main.js` (Phase 1; Phase 7 later widens `build` to the web app too, which `install.sh` picks up without change because it only calls `npm run build`).
- `package-lock.json` present so `npm ci` works (Phase 1).
- `node dist/main.js`, run with **any** cwd and no extra env, binds `127.0.0.1:7317`, answers `GET /health` with HTTP 200, and serves MCP at `/mcp` (Phase 2). `.env.local` is resolved from the repo root by module location, not cwd (Phase 1 `src/config.ts`).
- `src/config.ts` honours `NOTES_DATA_DIR` (Phase 1). The unit sets it explicitly to the same value as the default.
- `notesd` exits on SIGTERM within 15 s (Phase 2 `src/main.ts`). If it does not, systemd SIGKILLs it after `TimeoutStopSec=15`; nothing breaks, the restart is just slower.
- MCP tool names `create, get, update, append, delete, restore, list, search, tags, revisions, revert` (Phase 2) and, later, `create_image`, `view_images` (Phase 5). The skill names these but never hard-codes their parameter names; it tells Claude to follow each tool's schema.

**Leaves alone (owned by others):** `src/**`, `package.json`, `package-lock.json`, `tsconfig*.json`, `.gitignore` (Phase 1/2/7); `scripts/test-int.sh` (Phase 1, same directory, no overlap); `web/**` (Phases 7, 8).

## Files

| File | Action | What changes |
|---|---|---|
| `claude/skills/n/SKILL.md` | create (new file, line 1) | the `/n` skill |
| `deploy/notesd.service` | create (new file, line 1) | systemd user unit template |
| `scripts/install.sh` | create (new file, line 1, mode 0755) | installer |
| `scripts/uninstall.sh` | create (new file, line 1, mode 0755) | uninstaller |
| `scripts/windows/install-wsl-keepalive.ps1` | create (new file, line 1, ASCII only) | Windows logon task |
| `docs/INSTALL.md` | create (new file, line 1) | install, Windows step, WSL idle behaviour, post-landing re-run |

## Facts checked while planning (2026-10-30, this machine)

- `claude` 2.1.311. `claude mcp add [options] <name> <commandOrUrl>` with `-s, --scope <local|user|project>` and `-t, --transport <stdio|sse|http>`; options go **before** the name. `claude mcp remove [-s scope] <name>` exits non-zero when the server is absent. `claude mcp list` takes no options and prints `name: url (HTTP) - ✔ Connected` per server after a health check. `claude mcp get <name>` exists.
- Node and `claude` both live in `~/tools/node-v22.23.1-linux-x64/bin`. `systemctl --user show-environment` PATH is `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin` — node is not on it, so the unit needs an absolute node path.
- systemd 255, `/etc/wsl.conf` `[boot] systemd=true`, `loginctl show-user miftah -p Linger` → `Linger=no` (install.sh changes it).
- WSL 2.7.14.0, Windows 10.0.22631 (Windows 11 23H2), distro `Ubuntu` (running, default). No `%UserProfile%\.wslconfig` exists (`C:\Users\mahfu`).
- Windows user `pc\mahfu` is in Administrators but the WSL-launched PowerShell is **not elevated** (`IsInRole(Administrator)` = False). PowerShell 5.1.22621. `conhost.exe` present in System32.
- Microsoft Learn, "Advanced settings configuration in WSL" (updated 2026-10-16): `.wslconfig` `[general] instanceIdleTimeout`, default `15000`, "The number of milliseconds that a distro is idle, before it is shut down. Set to -1 to disable auto shutdown"; `[wsl2] vmIdleTimeout`, default `60000`, "The number of milliseconds that a VM is idle, before it is shut down" (Windows 11 only). The "8 second rule" section says the distro stops about 8 s "after closing ALL instances of the distribution shell".
- `curl` and `ss` are installed. `shellcheck` is not.

## Implementation Steps

### Step 1: The `/n` skill
**File:** `claude/skills/n/SKILL.md:1` (new file)
**Change:** write the skill. It is written so Phase 5 does not have to edit it: image tools are
described as "if the `notes` server offers them". No parameter names are hard-coded; Claude reads
the tool schemas. No `$ARGUMENTS` placeholder: Claude Code appends the text after `/n` as the
skill's arguments either way.
**Code:**
````markdown
---
name: n
description: The user's personal notes system, mcp-notes, reached through the `notes` MCP server. Use whenever the user types "/n <request>" from any repo, and when they ask to save, find, read, edit, tag, delete, restore, compare or summarize their notes or look at pictures they saved ("save this session's insights as a note", "what was my last #v250 note", "check note A-B32", "summarize #seer this week vs last week", "show me the pictures I saved on 30 oct").
argument-hint: <request for mcp-notes>
---

# /n — mcp-notes

The text after `/n` is a request for mcp-notes, the user's own notes store. Do it with the
`notes` MCP server's tools (they appear as `mcp__notes__<tool>`). Do not answer from memory,
from files in the current repo, or from earlier conversation when the request is about notes:
the notes are the source of truth.

## What a note is

- One plain-text body. No title, no fields, no structure.
- Tags are the `#hashtags` inside the body (`#seer`, `#v250`, `#from_phone`). The server
  re-parses them on every write: letters, digits, `_` and `-`, lower-cased, and a `#` glued to
  a word (`C#`, `a#b`) is not a tag. To add a tag, put `#tag` in the body. To remove one, take it
  out of the body.
- Ids look like `A-B32`: one character, a dash, three characters, all `0-9A-Z`. Lookup is
  case-insensitive and tolerates a missing dash, so `ab32` finds `A-B32`.
- Every edit keeps the previous body as a revision; deletes are soft and can be restored.
- A note may carry an image (a local file on the machine that saved it). Results say so.

## Tools

The spine tools are `create`, `get` (one or several ids), `update` (full body replace),
`append`, `delete` (soft), `restore`, `list` (tag any/all filters, created/updated date range,
newest first, limit + cursor), `search` (full text + tag + date filters, ranked), `tags` (every
tag with count and last-used date), `revisions` and `revert`. If the server also offers image
tools (for example `create_image` from a local file path, `view_images` to see a note's picture,
and `has_image` / taken-date filters on `list` and `search`), use them as described under
Images. Always follow each tool's own schema and description for parameter names and formats;
they win over anything written here.

## Saving

- Pass `origin` on every `create` and `update`: `cwd` = the current working directory, `repo` =
  the basename of the git top-level (`basename "$(git rev-parse --show-toplevel)"`, omit it when
  the cwd is not in a git repo), and `claude_session` only if you actually know this session's
  id. Never invent one.
- Bodies are plain text. No markdown: no `#` headings (a `#word` heading becomes a tag), no
  `**bold**`, no backtick fences, no tables. Line breaks and a plain `- ` at the start of a line
  are fine. Code tokens, paths, commands and ids are fine inline.
- End a note with its hashtags on the last line, chosen by you: the repo name when the note is
  about a repo, the system or topic (`#seer`, `#v250`), and the kind of thing it is
  (`#bug`, `#decision`, `#howto`) when that helps finding it later. Reuse existing tags: call
  `tags` first when unsure what the user already uses, and prefer their spelling.
- Never put secrets in a note: tokens, passwords, API keys, connection strings.

### "Save this session's insights"

Write one dense plain-text note that someone (the user, or a later Claude session) can act on
without this conversation: what the work was, what was decided and why, what was tried and did
not work, the commands, paths, versions and note ids worth keeping, and what is still open. No
narration of the chat, no filler, no markdown. Hashtags on the last line. Save it with `create`
and `origin`, then reply with the new id and a two-line summary of what it holds.

## Finding and reading

- A note id in the request (`A-B32`, `ab32`) → `get` it.
- "Notes tagged X", "my last note about X" → `list` filtered by that tag, newest first, small
  limit. A tag filter needs the tag without `#`, unless the tool schema says otherwise.
- Words or a topic rather than a tag → `search`, then `get` the best hits if you need full
  bodies. If `search` finds nothing, try `list` by a likely tag, or `tags` to see what exists.
- Page with the cursor when the user asks about "all" of something and the first page is full.

## Editing

- "Remove the markdown", "fix", "rewrite" → `get` the note, write the new full body yourself,
  `update` it (with `origin`). Keep every fact and every existing hashtag unless told otherwise.
- "Add tag #x" → make sure `#x` is in the body (append it to the hashtag line) and save.
- "Add this to note X" → `append`.
- "Undo", "what did it say before" → `revisions`, then `revert` to the one the user means.
- After any edit, reply with the id and what changed in one or two lines, and mention that the
  previous version is kept.

## Comparisons and summaries

The tools filter; you do the analysis. For "this week vs last week" call `list` (or `search`)
twice, once per date range. For "#seer vs #v250" call it twice, once per tag. Then compare the
two result sets yourself: themes, what changed, what is new, what stopped. Dates are in the
user's local time (Asia/Jakarta, WIB). A week runs Monday 00:00 to Sunday 23:59; "this week" is
Monday until now. Use the created date unless the user talks about edits. State the ranges you
used, and cite the note ids each point comes from.

## Images

Only when the server offers image tools.

- "Show me the pictures I saved on 30 oct" → `list` with the image filter and that saved-date
  range (or the taken-date range when the user means when the photo was taken), then the image
  viewing tool on those ids so you actually see them. Comment on what you see, per note id.
- A screenshot or image path at hand ("save this screenshot") → the tool that creates an image
  note from a local path, with a short body and hashtags.
- A note whose image file is not on this machine still has its text; say the file lives on the
  machine that saved it (its metadata names the host) instead of treating it as an error.

## Deleting

Delete only when the user asks, and only the notes they named. Deletes are soft: reply with the
ids and say `restore` brings them back.

## Replies

- Quote note ids exactly (`A-B32`) every time you mention a note, so the user can copy them.
- Keep replies short. Show a note's body only when the user asks to see it or it is short.
- If the request is ambiguous between two readings, pick the likelier one, do it, and say which
  reading you took.

## When the `notes` tools are missing or fail to connect

Say so plainly and suggest, in this order: `systemctl --user status notesd`,
`curl -s http://127.0.0.1:7317/health`, `journalctl --user -u notesd -n 50`, and re-running
`scripts/install.sh` from the mcp-notes checkout (`~/mcp-notes`). Do not fall back to writing
notes into files.
````
**Impact:** none on the tree. Takes effect once Step 3 symlinks it.

### Step 2: systemd user unit template
**File:** `deploy/notesd.service:1` (new file)
**Change:** a template rendered by `install.sh`. `ExecStart` runs `dist/main.js` with node
directly (not `npm start`, so SIGTERM reaches the daemon and no npm wrapper sits in between).
No `network-online.target`: user managers cannot order on it. Instead `Restart=on-failure` with
an unlimited start rate covers a boot where the network (Neon) is not up yet.
`Environment=PATH` puts the node dir first so anything the daemon spawns later (iteration 4's
Agent SDK runs `claude`) finds the same toolchain.
**Code:**
```ini
# notesd: the mcp-notes daemon, as a systemd user service.
# Rendered from deploy/notesd.service by scripts/install.sh. Edit the template, not this copy,
# and re-run scripts/install.sh.

[Unit]
Description=mcp-notes daemon (notesd, 127.0.0.1:7317)
Documentation=file://@REPO_DIR@/docs/INSTALL.md
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=@REPO_DIR@
ExecStart="@NODE_BIN@" "@REPO_DIR@/dist/main.js"
Environment=NODE_ENV=production
Environment="NOTES_DATA_DIR=@DATA_DIR@"
Environment="PATH=@NODE_DIR@:/usr/local/bin:/usr/bin:/bin"
Restart=on-failure
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=default.target
```
**Impact:** none until installed.

### Step 3: Installer
**File:** `scripts/install.sh:1` (new file, `chmod 0755`, and `git add --chmod=+x`)
**Change:** the idempotent installer. Every precondition that can stop it is checked before
anything is changed. Re-running it after a pull rebuilds and restarts the daemon.
`npm ci` runs when `node_modules` is missing or `package-lock.json` is newer than
`node_modules/.package-lock.json` (so the post-landing re-run in `~/mcp-notes` picks up the
set's dependencies). It exits non-zero unless all three checks pass at the end.
**Code:**
```bash
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
```
**Impact:** none on the tree. When run: installs the unit, flips linger, changes Claude Code's
user-scope MCP config, creates the skill symlink.

### Step 4: Uninstaller
**File:** `scripts/uninstall.sh:1` (new file, `chmod 0755`, `git add --chmod=+x`)
**Change:** undo the WSL side. Keeps the data dir and linger (other user units may rely on it),
and says how to undo those by hand.
**Code:**
```bash
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
```
**Impact:** none on the tree.

### Step 5: Windows keepalive task
**File:** `scripts/windows/install-wsl-keepalive.ps1:1` (new file)
**Change:** register a Task Scheduler entry, at logon of the current user, that runs
`wsl.exe -d <Distro> -- sleep infinity` with no window. The file must be **pure ASCII**
(Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page, so an em dash would
corrupt the script) — use `-` and plain quotes only.

Two details that the brief's one-liner does not cover, decided here:
- **Hidden window.** `Register-ScheduledTask -Settings (… -Hidden)` hides the *task* in the Task
  Scheduler UI; it does not hide a console window. A console program started by an Interactive
  logon task opens a visible console. The action therefore runs
  `conhost.exe --headless wsl.exe -d <Distro> -- sleep infinity`: still `wsl.exe -d <distro> --
  sleep infinity`, hosted by a console with no window.
- **No 72-hour kill.** The default `ExecutionTimeLimit` is 3 days, after which Task Scheduler
  kills the action and WSL would idle out. It is set to zero (no limit). The task also runs on
  battery and is restarted if `wsl.exe` exits.

`wsl.exe --list` writes UTF-16 to a pipe; `WSL_UTF8=1` makes it UTF-8 so the distro check works
in PowerShell 5.1.
**Code:**
```powershell
<#
.SYNOPSIS
  Keep WSL running from Windows logon, so notesd (a systemd user service inside the distro)
  is up without a terminal open.

.DESCRIPTION
  Registers a Task Scheduler task, triggered at logon of the current user, that runs
  "wsl.exe -d <Distro> -- sleep infinity" inside a headless console (no window). The attached
  wsl.exe keeps the distro from being shut down by WSL's idle timeout. See docs/INSTALL.md.

  Run from Windows PowerShell:
    powershell -NoProfile -ExecutionPolicy Bypass -File \\wsl.localhost\Ubuntu\home\<you>\mcp-notes\scripts\windows\install-wsl-keepalive.ps1
  If registration fails with "Access is denied", run the same command from an elevated
  PowerShell (Run as administrator). The task still runs as you, not as an administrator.

.PARAMETER Distro
  WSL distribution name, as listed by "wsl -l". Default: Ubuntu.

.PARAMETER TaskName
  Task Scheduler task name. Default: "mcp-notes WSL keepalive".

.PARAMETER Uninstall
  Stop and remove the task instead of registering it.

.PARAMETER NoStart
  Register the task but do not start it now (it starts at the next logon).
#>
[CmdletBinding()]
param(
  [string]$Distro = 'Ubuntu',
  [string]$TaskName = 'mcp-notes WSL keepalive',
  [switch]$Uninstall,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($Uninstall) {
  if ($existing) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed task '$TaskName'. Any running 'sleep infinity' ends with: wsl.exe -d $Distro -- pkill -x sleep"
  } else {
    Write-Host "No task named '$TaskName'."
  }
  return
}

$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
if (-not (Test-Path $wsl)) { throw "wsl.exe not found at $wsl" }
if (-not (Test-Path $conhost)) { throw "conhost.exe not found at $conhost" }

$env:WSL_UTF8 = '1'
$distros = @(& $wsl --list --quiet | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
if ($distros -notcontains $Distro) {
  throw "WSL distro '$Distro' not found. Installed: $($distros -join ', ')"
}

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction -Execute $conhost `
  -Argument "--headless `"$wsl`" -d `"$Distro`" -- sleep infinity"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -Hidden

try {
  Register-ScheduledTask -TaskName $TaskName `
    -Description "Keeps WSL distro '$Distro' running from logon so the mcp-notes daemon (notesd) stays up. Runs: wsl.exe -d $Distro -- sleep infinity (headless)." `
    -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
} catch [System.UnauthorizedAccessException] {
  throw "Access denied registering '$TaskName'. Re-run this script from an elevated PowerShell (Run as administrator)."
} catch {
  if ($_.Exception.HResult -eq -2147024891) {
    throw "Access denied registering '$TaskName'. Re-run this script from an elevated PowerShell (Run as administrator)."
  }
  throw
}

Write-Host "Registered task '$TaskName' for $user (at logon): wsl.exe -d $Distro -- sleep infinity, headless."

if (-not $NoStart) {
  $state = (Get-ScheduledTask -TaskName $TaskName).State
  if ($state -ne 'Running') {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started it now."
  } else {
    Write-Host "Already running."
  }
}

Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State | Format-Table -AutoSize
```
**Impact:** none on the tree. When run: one scheduled task in the user's Task Scheduler library.

### Step 6: `docs/INSTALL.md`
**File:** `docs/INSTALL.md:1` (new file)
**Change:** the install guide. The WSL idle section states what Microsoft documents and what is
inferred, and gives a test the user can run to see it for themselves.
**Code:**
````markdown
# Installing mcp-notes

`notesd` runs inside WSL as a systemd **user** service, on `127.0.0.1:7317`. Claude Code reaches
it as the `notes` MCP server (user scope), and `/n` is a user-level skill symlinked from this
repo. A Windows logon task keeps WSL itself running.

## Prerequisites

- WSL 2 with systemd: `/etc/wsl.conf` has `[boot]` / `systemd=true`, and
  `systemctl --user is-system-running` answers (`running` or `degraded`).
- Node 22. The installer finds `node` on your PATH, else
  `~/tools/node-v22.23.1-linux-x64/bin/node`, or set `NODE_BIN=/abs/path/to/node`.
- The `claude` CLI (on PATH, or next to node, or `CLAUDE_BIN=...`).
- `.env.local` at the repo root with `DATABASE_URL` and `DATABASE_URL_UNPOOLED` (the Neon pooled and direct hosts; the daemon picks the pooled one by host name, so the key names do not have to be right).
- The Neon schema migrated once: `npm run db:migrate`.

## 1. Install (WSL)

```sh
cd ~/mcp-notes
scripts/install.sh
```

What it does, every run (it is idempotent, re-run it after every pull):

1. `npm ci` when `node_modules` is missing or older than `package-lock.json`.
2. `npm run build` (server, and the web UI once it exists).
3. Creates the data dir, `~/mcp-notes-data` (or `$NOTES_DATA_DIR`).
4. Renders `deploy/notesd.service` with absolute paths (node, this checkout, data dir) into
   `~/.config/systemd/user/notesd.service`, then `daemon-reload`, `enable` and `restart`.
   The absolute node path matters: the user manager's PATH does not include `~/tools/...`.
5. `loginctl enable-linger $USER`, so your user manager, and with it `notesd`, starts when the
   distro boots rather than when you first open a shell. If that needs a password the script
   says so; run `sudo loginctl enable-linger $USER` once.
6. Waits up to 30 s for `GET http://127.0.0.1:7317/health`.
7. `claude mcp remove --scope user notes` (ignored if absent), then
   `claude mcp add --scope user --transport http notes http://localhost:7317/mcp`.
8. Symlinks `~/.claude/skills/n` -> `<this checkout>/claude/skills/n`. An existing symlink is
   replaced; a real directory there stops the script before it changes anything.
9. Prints the verification and exits non-zero unless all three checks pass:

```sh
systemctl --user is-active notesd           # active
curl -s http://127.0.0.1:7317/health        # HTTP 200
claude mcp list | grep '^notes:'            # notes: http://localhost:7317/mcp (HTTP) - ✔ Connected
```

Logs: `journalctl --user -u notesd -f`.

The unit and the skill point at **the checkout that ran the script**. Run it from `~/mcp-notes`.

## 2. Keep WSL running (Windows)

### Why this is needed

WSL stops an idle distro, and stopping the distro stops `notesd` with it.

What Microsoft documents (Learn, "Advanced settings configuration in WSL", updated 2026-10-16):

- `%UserProfile%\.wslconfig`, `[general]` `instanceIdleTimeout`, default `15000`: "The number of
  milliseconds that a distro is idle, before it is shut down. Set to -1 to disable auto
  shutdown."
- `[wsl2]` `vmIdleTimeout`, default `60000` (Windows 11): "The number of milliseconds that a VM
  is idle, before it is shut down." This applies to the whole VM after its distros have stopped.
- The "8 second rule": the distro stops shortly "after closing ALL instances of the distribution
  shell".

What that means here, stated as inference rather than documentation: "idle" is about Windows-side
`wsl.exe` sessions, not Linux processes. systemd services, `notesd` among them, and a lingering
user manager do **not** keep the distro up. Linger only decides that `notesd` starts when the
distro boots; it does not boot the distro or keep it running. So with no terminal open, WSL
shuts the distro down about 15 s after the last terminal closes, and `notesd` goes with it.
During the working day an open Claude Code terminal keeps it up anyway; the gap is before the
first terminal of the day and after the last one closes (the web UI at `http://localhost:7317`
would be unreachable then).

Check it yourself (PowerShell, without the keepalive task): close every WSL terminal, wait 30 s,
run `wsl --list --running`. "There are no running distributions" confirms it.

This machine had no `.wslconfig` when this was written, so both timeouts are at their defaults.

### The fix: a logon task holding one `wsl.exe` open

`scripts/windows/install-wsl-keepalive.ps1` registers a Task Scheduler task, at your logon, that
runs `wsl.exe -d Ubuntu -- sleep infinity` with no window. That attached `wsl.exe` keeps the
distro non-idle all day; systemd starts `notesd` (linger) as the distro boots.

From Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File \\wsl.localhost\Ubuntu\home\miftah\mcp-notes\scripts\windows\install-wsl-keepalive.ps1
```

or from WSL:

```sh
cd /mnt/c && powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w ~/mcp-notes/scripts/windows/install-wsl-keepalive.ps1)"
```

Parameters: `-Distro <name>` (default `Ubuntu`), `-TaskName <name>` (default
`mcp-notes WSL keepalive`), `-NoStart` (do not start it now), `-Uninstall`.

If it fails with "Access is denied", run it from an elevated PowerShell (Run as administrator).
The task still runs as you.

Details:

- The action is `conhost.exe --headless wsl.exe -d Ubuntu -- sleep infinity`. Task Scheduler's
  "hidden" setting only hides the task in its UI; a console program started at logon would
  otherwise open a visible console window.
- The default 3-day execution limit is removed, so Task Scheduler never kills it; it runs on
  battery and is restarted up to 3 times if `wsl.exe` exits.
- Check it: `Get-ScheduledTask -TaskName 'mcp-notes WSL keepalive'` (State `Running`), and in WSL
  `pgrep -af 'sleep infinity'`.

### Alternative: turn the idle shutdown off

Instead of the task, `%UserProfile%\.wslconfig`:

```ini
[general]
instanceIdleTimeout=-1
```

then `wsl --shutdown`. This keeps a started distro running, but nothing starts WSL at logon, so
`notesd` is down until you open a terminal once. The task covers both, which is why it is the
chosen setup.

## 3. After the plan set lands (re-run from the main checkout)

The set is built in a worktree (`~/.worktrees/mcp-notes/notes-spine-images-ui`) and its phase
ran `install.sh` from there, so the unit, `WorkingDirectory` and the skill symlink point into
the worktree. The worktree is deleted when the branch lands, which leaves the unit failing and
the skill dangling. Once the set is on `main`:

```sh
cd ~/mcp-notes && git pull && scripts/install.sh
```

It rewrites the unit to `~/mcp-notes`, re-points the symlink, rebuilds and restarts. Confirm
with `systemctl --user cat notesd | grep ExecStart`.

## Uninstall

```sh
scripts/uninstall.sh
```

Stops and removes the unit, runs `claude mcp remove --scope user notes`, removes the skill
symlink. It keeps `~/mcp-notes-data` and linger (`sudo loginctl disable-linger $USER` to undo).
Windows: run the keepalive script with `-Uninstall`.

## Troubleshooting

- `notes` shows "Failed to connect": `systemctl --user status notesd`, then
  `journalctl --user -u notesd -n 50`. The daemon binds `127.0.0.1` only; Claude Code connects to
  `localhost`, which resolves to IPv4 first or falls back to it.
- `/n` not found in Claude Code: `ls -l ~/.claude/skills/n` must point at an existing
  `claude/skills/n`; re-run `scripts/install.sh`.
- Port 7317 taken by a dev run: stop it; the installer's health check would otherwise pass
  against the wrong process. `ss -ltnp 'sport = :7317'` shows the owner.
````
**Impact:** none on the tree.

### Step 7: Static checks
**Change:** no file. Run:
```sh
cd /home/miftah/.worktrees/mcp-notes/notes-spine-images-ui
bash -n scripts/install.sh && bash -n scripts/uninstall.sh
test -x scripts/install.sh && test -x scripts/uninstall.sh
LC_ALL=C grep -nP '[^\x00-\x7F]' scripts/windows/install-wsl-keepalive.ps1 && echo "NON-ASCII in ps1" || echo "ps1 is ASCII"
cd /mnt/c && powershell.exe -NoProfile -Command "\$null = [System.Management.Automation.Language.Parser]::ParseFile('$(wslpath -w /home/miftah/.worktrees/mcp-notes/notes-spine-images-ui/scripts/windows/install-wsl-keepalive.ps1)', [ref]\$null, [ref]\$e); if (\$e) { \$e; exit 1 } else { 'ps1 parses' }"
```
`shellcheck` is not installed; do not add it (no dependency changes in this phase).

### Step 8: Run the installer from the worktree and record the result
**Change:** no file. This is the phase's live verification. Precondition: Phase 2 has landed in
this worktree (`npm run build` produces `dist/main.js`) and `npm run db:migrate` has been applied
to Neon (Phase 1 records that). Nothing else may hold port 7317 (`ss -ltnp 'sport = :7317'`
empty), since invariant 10 keeps phase test runs off it.
```sh
cd /home/miftah/.worktrees/mcp-notes/notes-spine-images-ui
export PATH="$HOME/tools/node-v22.23.1-linux-x64/bin:$PATH"
scripts/install.sh 2>&1 | tee .workflows/plan/notes-spine-images-ui/phase-3-install.log
systemctl --user is-active notesd
curl -s -w '\nHTTP %{http_code}\n' http://127.0.0.1:7317/health
claude mcp list | grep '^notes:'
claude mcp get notes
ls -l ~/.claude/skills/n
loginctl show-user "$USER" -p Linger
systemctl --user cat notesd | grep -E 'ExecStart|WorkingDirectory'
```
Second run, to prove idempotency: run `scripts/install.sh` again; it must print
"node_modules up to date", "unit unchanged", "linger already enabled", "replacing skill symlink",
and end with `OK`.

If linger needs a password, the script warns and continues; record the warning and ask for
`sudo loginctl enable-linger $USER` in the completion notes rather than failing the phase.

Record in the phase's completion notes: the three check outputs, the linger state, and the
sentence "the unit and the `/n` symlink point at the worktree until the post-landing re-run
`cd ~/mcp-notes && git pull && scripts/install.sh`".

Do not commit `phase-3-install.log` (it is a scratch record; delete it after copying the
outputs into the completion notes).

### Step 9: Register the Windows task (best effort) and record it
**Change:** no file.
```sh
cd /mnt/c && powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w /home/miftah/.worktrees/mcp-notes/notes-spine-images-ui/scripts/windows/install-wsl-keepalive.ps1)"
powershell.exe -NoProfile -Command "Get-ScheduledTask -TaskName 'mcp-notes WSL keepalive' | Select-Object TaskName,State; (Get-ScheduledTask -TaskName 'mcp-notes WSL keepalive').Actions | Select-Object Execute,Arguments"
pgrep -af 'sleep infinity'
```
The task's action does not reference the repo path, so registering it from the worktree is
final (no post-landing re-run needed for the Windows side). The WSL-launched PowerShell is not
elevated; if registration fails with "Access denied", record that and leave the elevated run to
the user (the command is in `docs/INSTALL.md`). That is not a phase failure: the WSL-side checks
of Step 8 are the exit criterion.

Do not run the "close every terminal and wait" idle test: it would end this session.

## Verification

**Build:** `npm run build` (run by `install.sh`; must stay green). `npm run typecheck` unchanged
by this phase.
**Tests:** `npm test` and `npm run test:int` — unchanged by this phase, must still be green
(invariant 2). `bash -n` on both shell scripts, the PowerShell parse check of Step 7.
**Manual check:** in a **new** Claude Code session (MCP servers and skills load at start), from
any repo: `/n check notes that has #v250 tags. i wonder what my last note about it was` → Claude
calls `mcp__notes__list` (no notes yet is a fine answer), and `/n save a test note: phase 3
install check #mcp-notes #test` → a reply quoting a new `A-B32`-style id. Delete that test note
afterwards with `/n delete <id>`.
**Exit criteria:** `scripts/install.sh` exits 0 from the worktree and a second run also exits 0;
`systemctl --user is-active notesd` → `active`; `curl 127.0.0.1:7317/health` → HTTP 200;
`claude mcp list` shows `notes: http://localhost:7317/mcp (HTTP) - ✔ Connected`;
`~/.claude/skills/n` is a symlink to the worktree's `claude/skills/n`; these outputs, the linger
state and the Windows task result are recorded in the completion notes.

## Handoffs

- **Post-landing re-run (completion handler / user, after the whole set lands):**
  `cd ~/mcp-notes && git pull && scripts/install.sh`. Until then the unit's `ExecStart`,
  `WorkingDirectory` and the skill symlink point into the worktree, and they break the moment
  the worktree is deleted. Already listed under the index's "Next".
- **Phase 2:** `notesd` must start with any cwd and no env beyond what the unit sets
  (`NODE_ENV`, `NOTES_DATA_DIR`, `PATH`), and should exit on SIGTERM. If `/health` returns
  non-200 while degraded (for example Neon unreachable), the installer treats that as failure;
  that is intended.
- **Phase 5:** no edit to `claude/skills/n/SKILL.md` is needed; it already tells Claude to use
  image tools when the server offers them and to follow the tool schemas. If Phase 5 names its
  tools differently from `create_image` / `view_images`, the skill still works (it says "for
  example").
- **Phase 7:** `install.sh` only calls `npm run build`; widening `build` to the web app needs no
  change here. The daemon serves the SPA from `<checkout>/web/dist`, which the unit's
  `WorkingDirectory`/checkout already covers.
- **Not done, out of scope:** a README section linking `docs/INSTALL.md` (no README exists yet;
  whoever writes one should link it). GPD install (iteration 7+).

## Risks

- `loginctl enable-linger` may need polkit authentication in WSL; the script degrades to a
  warning. Without linger, `notesd` starts only when a login session starts the user manager —
  which a keepalive `wsl.exe` session does, so it is still covered, just later.
- `claude mcp add` URL is `localhost` (fixed decision) while the daemon binds `127.0.0.1` only.
  Low risk: the coordinator verified on this machine that `localhost` resolves to `127.0.0.1`
  first (`getent ahosts localhost` and Node's `dns.lookup('localhost')`). The `claude mcp list`
  check in verification still confirms it end to end.
- `Register-ScheduledTask` for an at-logon trigger may need elevation; handled as best effort.
- `conhost.exe --headless` is a long-standing but lightly documented switch. If a window does
  appear at logon, it is cosmetic; the keepalive still works.

## Rollback

`scripts/uninstall.sh` (unit, MCP registration, skill symlink),
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File <ps1> -Uninstall` (Windows task),
optionally `sudo loginctl disable-linger $USER`, then `git revert` the phase commit. Nothing in
`src/**`, the database or the data dir is touched.
