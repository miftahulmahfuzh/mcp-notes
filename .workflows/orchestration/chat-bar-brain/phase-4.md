# Phase 4: Daemon fit: unit, install.sh, live suite, installed acceptance

**Plan set:** `CHAT_BAR_BRAIN_PLAN.md`
**Analysis:** `docs/analyzer/20261030-105357-UWUH_code_analyzer.md`
**Satisfies:** R1, R5, R6. The installed systemd daemon answers chat-bar messages for real on the owner's Claude login (R5), every R1 behaviour is proven end to end through `http://127.0.0.1:7317/api/chat` (R1), and an opt-in live suite runs one real Claude and one real GLM message (R6).
**Depends on:** Phase 2, Phase 3. Phase 1 lands through both.
**Difficulty:** HARD (live external dependencies, a systemd environment, and an acceptance run against the owner's real database that must not damage any real note)
**Package:** `deploy`, `scripts`, `tests/live`, root config

---

## Goal

After this phase the systemd unit hands the daemon an absolute `claude` binary (`NOTESD_CLAUDE_BIN`) and an explicit `HOME`, so the Agent SDK child finds the executable and `~/.claude/.credentials.json`. `scripts/install.sh` renders and checks both, warns when the login or the GLM keys are missing, and fails verification unless a real `POST /api/chat` ends in `event: done`. `npm run test:live` runs one real Claude message and one real GLM message through `createAgentChatBackend`, and the acceptance prompts from the brief have been run against the installed daemon, with the results recorded.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- unit placeholders `@CLAUDE_BIN@` and `@HOME_DIR@` in `deploy/notesd.service`, rendered to `Environment="NOTESD_CLAUDE_BIN=<readlink -f claude>"` and `Environment="HOME=<$HOME>"`
- `scripts/install.sh`: shell variable `CLAUDE_REAL`, functions `check_claude_login`, `check_env_file`, `chat_smoke`, constants `CHAT_URL`, `CHAT_SMOKE_SECONDS`, `CHAT_SMOKE_MESSAGE`, env override `SKIP_CHAT_CHECK=1`
- npm script `test:live` = `CHAT_LIVE_TEST=1 bash scripts/test-int.sh`
- env switch `CHAT_LIVE_TEST=1` in `vitest.config.ts` (it takes precedence over `VITEST_INTEGRATION`)
- `tests/live/chat.live.test.ts`
- `docs/INSTALL.md` section "4. Chat bar brain"

**Signature changes:** none in TypeScript.

**Requires (from earlier phases):**
- Phase 1: `Config.chat = { brain: ChatBrain; maxTurns: number; timeoutMs: number; claudeBin: string; glm: { baseUrl: string; apiKey: string; model: string } | null }`, with `loadConfig` reading `NOTESD_CLAUDE_BIN` into `claudeBin` (default `'claude'`), `CHAT_BRAIN`, `CHAT_MAX_TURNS`, `CHAT_TIMEOUT_MS` and `LLM_*` from the real env merged over `.env.local`, real env winning. The acceptance step A7 relies on that precedence: a systemd drop-in `CHAT_BRAIN=glm` beats `.env.local`.
- Phase 1: `startDaemon(config, options?: { chat?: ChatBackend })`, `ChatBrain`, `ChatTurnEnd`, `ChatEvent` (`{type:'delta'|'status', text}`), and `ChatTurn.events` / `ChatTurn.end()` exported from `src/chat/backend.ts`. Also `createStubChatBackend({ delayMs })` still exported from `src/chat/stub.ts`.
- Phase 1: SSE `event: done` carries `{"thread_id": string, "brain"?: "claude"|"glm"}`, and `event: status` carries `{"text": string}`. `install.sh`'s `chat_smoke` and the acceptance helper both parse these.
- Phase 2: `createAgentChatBackend(options: AgentChatOptions): AgentChatBackend` exported from `src/chat/agent.ts`, synchronous, with `AgentChatOptions = { chat: Config['chat']; cwd: string; mcpUrl: () => string; query?; now?; baseEnv?; log? }` and `AgentChatBackend extends ChatBackend { close(): void }`. The live test passes exactly `{ chat, cwd, mcpUrl }` and calls `close()` when done.
- Phase 2: the daemon builds the real Agent backend by default (no `chat` option) from `config.chat`, with `cwd = join(dataDir, CHAT_SUBDIR)` and `pathToClaudeCodeExecutable = resolveExecutable(config.chat.claudeBin, PATH)`. With the unit's absolute `NOTESD_CLAUDE_BIN` that is the same absolute path.
- Phase 2: the SDK child env drops `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT` and every `CLAUDE_CODE_*` key (`src/chat/env.ts`), so the live suite started from a Claude Code terminal needs no env workaround.
- Phase 2: `@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/sdk` are in `dependencies` and `package-lock.json` (so install.sh's `npm ci` picks them up). Phase 2 changes only the `dependencies` block of `package.json`; the `scripts` block this phase edits is byte-identical to `main` after Phase 2.
- Phase 3: the web UI shows the status caption and the brain label (only the optional manual check A8 looks at it).

**Leaves alone (owned by others):** `src/chat/backend.ts`, `src/chat/stub.ts`, `src/http/*`, `src/config.ts`, `src/daemon.ts` (phase 1). `src/chat/agent.ts`, `src/chat/prompt.ts`, `src/chat/status.ts`, `src/chat/env.ts` (phase 2; edited here **only** to fix a bug found during acceptance, with a unit test, recorded in the report). All of `web/` (phase 3). `scripts/test-int.sh`, `scripts/uninstall.sh` (unchanged).

## Files

| File | Action | What changes |
|---|---|---|
| `deploy/notesd.service` | modify (lines 14-16) | add `Environment="HOME=@HOME_DIR@"` and `Environment="NOTESD_CLAUDE_BIN=@CLAUDE_BIN@"`, plus a comment on where chat config lives |
| `scripts/install.sh` | modify (header 8-12, consts 22-27, `resolve_claude` 50-56, `check_preconditions` 66-70, `install_unit` 101-105, `verify` 166-190, `main` 192-205) | render `@CLAUDE_BIN@`/`@HOME_DIR@`, path-char check, login check, `.env.local` check, chat smoke in `verify` |
| `vitest.config.ts` | modify (whole file, 30 lines) | `CHAT_LIVE_TEST=1` switches include to `tests/live/**/*.live.test.ts` with long timeouts |
| `package.json` (as Phase 2 leaves it; its `dependencies` gain the two SDK packages, `scripts` unchanged) | modify (scripts block, after `"test:int"`) | add `"test:live"` |
| `tests/live/chat.live.test.ts` | create | one real Claude and one real GLM message via `createAgentChatBackend` against an in-process daemon's `/mcp` |
| `docs/INSTALL.md` | modify (13, 29-30, 40-46, 129-141, insert before 143, append after 161) | chat brain section, new checks, generic worktree note |

## Implementation Steps

### Step 1: Unit template gets the claude binary and HOME
**File:** `deploy/notesd.service:14-16`
**Change:** add two `Environment=` lines and a comment. No keys and no `CHAT_*` values go in the unit (invariant 3); those live in `.env.local`, which the daemon reads itself.
**Code:** the whole file after the change:
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
# The chat bar's brain spawns Claude Code through the Agent SDK. HOME is where it finds the
# login (~/.claude/.credentials.json) and keeps its sessions; NOTESD_CLAUDE_BIN is the real path
# of the claude executable. Chat settings (CHAT_BRAIN, CHAT_MAX_TURNS, CHAT_TIMEOUT_MS) and the
# GLM fallback keys (LLM_*) come from the checkout's .env.local, never from this file.
Environment="HOME=@HOME_DIR@"
Environment="NOTESD_CLAUDE_BIN=@CLAUDE_BIN@"
Restart=on-failure
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=default.target
```
**Impact:** the template now has two more placeholders. The old install.sh would die on them ("unrendered placeholder"), so Step 2 has to land in the same commit.

### Step 2: install.sh renders the binary and HOME, checks the login and env file, smoke-tests chat
**File:** `scripts/install.sh` (whole file; the changed regions are header lines 8-12, constants after line 27, `resolve_claude` 50-56, `check_preconditions` 66-70, `install_unit` 101-105, `verify` 166-190 and `main` 192-205)
**Change:**
- `resolve_claude` also sets `CLAUDE_REAL="$(readlink -f "$c")"`. `CLAUDE_BIN` (possibly a symlink) is still what the script runs for `claude mcp ...`. The unit gets `CLAUDE_REAL`, so it never depends on PATH or on the `bin/claude` symlink (on this machine that resolves to `.../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, a native ELF).
- The path-character check covers `$CLAUDE_REAL` and `$HOME`.
- `check_claude_login` warns (it does not die) when `~/.claude/.credentials.json` is missing.
- `check_env_file` warns when `$REPO_DIR/.env.local` is missing (in a worktree it is a symlink to `~/mcp-notes/.env.local` by convention) or lacks a complete `LLM_*` triple (GLM fallback off).
- `chat_smoke` is called from `verify`. It posts a tiny notes-only message, requires the stream to end with `event: done`, and prints the brain. `brain != claude` is a warning, not a failure. `SKIP_CHAT_CHECK=1` skips the check.

**Code:** the complete new `scripts/install.sh`:
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
#   CLAUDE_BIN      path to the claude CLI (default: `claude` on PATH, then next to node). The
#                   unit gets its real path (readlink -f) as NOTESD_CLAUDE_BIN for the chat bar.
#   NOTES_DATA_DIR  data dir (default: ~/mcp-notes-data)
#   SKIP_CHAT_CHECK set to 1 to skip the chat smoke check in the verification (offline runs)
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
CHAT_URL="http://127.0.0.1:$PORT/api/chat"
MCP_URL="http://localhost:$PORT/mcp"
DEFAULT_NODE="$HOME/tools/node-v22.23.1-linux-x64/bin/node"
CLAUDE_CREDENTIALS="$HOME/.claude/.credentials.json"
HEALTH_WAIT_SECONDS=30
# A little above the daemon's default CHAT_TIMEOUT_MS (180 s), so the daemon's own timeout fires first.
CHAT_SMOKE_SECONDS=200
# Notes-only and read-only: it exercises the SDK child, the login and the notes MCP tools, no web.
CHAT_SMOKE_MESSAGE='Install check. Call the notes tags tool once, then reply with only the number of tags it returned. Use no other tool.'

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
  [[ -f "$SKILL_SRC/SKILL.md" ]] || die "missing $SKILL_SRC/SKILL.md."
  [[ -f "$REPO_DIR/package-lock.json" ]] || die "missing $REPO_DIR/package-lock.json."
  local p
  for p in "$REPO_DIR" "$NODE_BIN" "$NODE_DIR" "$DATA_DIR" "$CLAUDE_REAL" "$HOME"; do
    [[ "$p" != *'|'* && "$p" != *'&'* && "$p" != *'\'* ]] \
      || die "path contains a character the unit renderer cannot handle (| & \\): $p"
  done
  if [[ -e "$SKILL_DST" && ! -L "$SKILL_DST" ]]; then
    die "$SKILL_DST exists and is not a symlink. Move it away, then re-run (refusing to clobber a real directory)."
  fi
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
  check_claude_login
  check_env_file
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
**Impact:**
- The installed unit gains two `Environment=` lines.
- `verify` now takes up to ~200 s longer and fails when chat is broken. The unit is already installed and running by then, so a chat failure does not leave a broken daemon, only a non-zero exit.
- `CHAT_SMOKE_MESSAGE` contains no `"` or `\`, so the `printf` JSON is valid. Keep it that way if you edit it.
- `sed -n '/^event: *done/{n;s/^data: *//p;}'` relies on Hono's `writeSSE` writing `event:` before `data:`. It does.

### Step 3: Vitest switch for the live suite
**File:** `vitest.config.ts:1-30` (whole file)
**Change:** `CHAT_LIVE_TEST=1` wins over `VITEST_INTEGRATION`. `test:live` runs through `scripts/test-int.sh` (Docker Postgres, `TEST_DATABASE_URL`), which also sets `VITEST_INTEGRATION=1`, so the migration `globalSetup` and serial files still apply. `npm test` (`tests/unit/**`, `web/src/**`) and `npm run test:int` (`tests/integration/**`) never match `tests/live/**`.
**Code:**
```ts
import { defineConfig } from 'vitest/config'

/**
 * The single Vitest config for the repo.
 *
 * - `npm test` (unit): `tests/unit/**` in node, plus `web/src/**\/*.test.tsx`, which opt
 *   into jsdom per file with a `// @vitest-environment jsdom` first-line pragma.
 * - `npm run test:int` (scripts/test-int.sh) sets VITEST_INTEGRATION=1 and
 *   TEST_DATABASE_URL, which switches the run to `tests/integration/**` only, against
 *   the Docker Postgres `mcp-notes-pg-test`. Integration files run one at a time
 *   because they share one database and truncate it.
 * - `npm run test:live` sets CHAT_LIVE_TEST=1 on top of scripts/test-int.sh, which switches the
 *   run to `tests/live/**` only: real Claude and real GLM calls through the Agent SDK, on the
 *   same Docker Postgres. Opt-in, slow and billed; never part of `npm test` or `test:int`.
 *
 * Do not add a second config file.
 */
const live = process.env.CHAT_LIVE_TEST === '1'
const integration = live || process.env.VITEST_INTEGRATION === '1'

function includeFor(): string[] {
  if (live) return ['tests/live/**/*.live.test.ts']
  if (integration) return ['tests/integration/**/*.int.test.ts']
  return ['tests/unit/**/*.test.ts', 'web/src/**/*.test.tsx']
}

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: includeFor(),
    exclude: ['node_modules/**', 'dist/**', 'web/dist/**'],
    globalSetup: integration ? ['tests/integration/globalSetup.ts'] : [],
    fileParallelism: !integration,
    testTimeout: live ? 300_000 : integration ? 30_000 : 5_000,
    hookTimeout: live ? 60_000 : integration ? 60_000 : 10_000,
  },
})
```
**Impact:** none on the existing runs. Both branches are unchanged for `live === false`.

### Step 4: `test:live` script
**File:** `package.json`, `"scripts"` block, the line right after `"test:int": "bash scripts/test-int.sh",`
**Change:** add one script. It reuses `scripts/test-int.sh` for the Docker Postgres, which `exec`s vitest with the inherited env, so `CHAT_LIVE_TEST=1` reaches the config.
**Code:** the scripts block after the change:
```json
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "start": "node dist/main.js",
    "build:server": "tsc -p tsconfig.server.json",
    "build": "npm run build:server && npm run build:web",
    "build:web": "vite build --config web/vite.config.ts",
    "dev:web": "vite --config web/vite.config.ts",
    "typecheck": "tsc -p tsconfig.json && tsc -p tsconfig.web.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:int": "bash scripts/test-int.sh",
    "test:live": "CHAT_LIVE_TEST=1 bash scripts/test-int.sh",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:check": "drizzle-kit check"
  }
```
This is the scripts block as Phase 2 leaves it (Phase 2 touches only `dependencies`, which now lists `@anthropic-ai/claude-agent-sdk` `0.3.311` and `@anthropic-ai/sdk` `0.135.0` first; leave that block alone). Add only the `test:live` line.
**Impact:** `package-lock.json` is unchanged (scripts are not in the lockfile).

### Step 5: The live suite
**File:** `tests/live/chat.live.test.ts` (new)

**Choice: an in-process daemon on port 0, not the installed one on 7317.** The reasons:
1. The installed daemon writes to the owner's Neon database. The live test seeds a note, and the agent may call write tools. Neither belongs in real data. In-process it runs on the Docker Postgres that `test-int.sh` already provides, and `testDatabaseUrl()` refuses Neon.
2. The suite has to pass before `install.sh` runs and independently of which checkout the unit points at. The installed path is covered separately by `install.sh`'s chat smoke check and by the acceptance run below.
3. It still uses the real thing end to end. Real HTTP `/mcp` on a real `startDaemon`, a real `claude` child, the real login, the real GLM endpoint. The daemon is started with the stub chat backend because it is needed only for its `/mcp`. The test drives `createAgentChatBackend` directly so it can force each brain.
4. A seeded note with a random codeword and a unique tag makes the assertion exact: the answer must contain a codeword that exists only in that note, plus that note's id. That proves the agent really called the notes tools. Without the codeword it might have guessed.

No env workaround is needed when the suite is started from a Claude Code terminal: Phase 2's `claudeEnv`/`glmEnv` drop `CLAUDECODE` and every `CLAUDE_CODE_*` key from the child env.

**Code:**
```ts
/**
 * Opt-in live suite: one real Claude message and one real GLM message through the Agent SDK
 * backend. Run with `npm run test:live` (CHAT_LIVE_TEST=1 on top of scripts/test-int.sh, which
 * provides the Docker Postgres). Never part of `npm test` or `npm run test:int`.
 *
 * The daemon runs in-process on port 0 against the Docker test database, never the installed
 * one on 7317: the test seeds a note and the agent may write, and that must not reach the
 * owner's Neon data. The daemon is started with the stub chat backend because only its /mcp is
 * used; the Agent backend under test is built here so each brain can be forced.
 *
 * Needs: the `claude` CLI (NOTESD_CLAUDE_BIN or `claude` on PATH) logged in, and LLM_BASE_URL,
 * LLM_API_KEY, LLM_MODEL in .env.local (a worktree carries a symlink to ~/mcp-notes/.env.local).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentChatBackend } from '../../src/chat/agent.js';
import type { ChatBrain, ChatTurnEnd } from '../../src/chat/backend.js';
import { createStubChatBackend } from '../../src/chat/stub.js';
import { loadConfig, type Config } from '../../src/config.js';
import { CHAT_SUBDIR, startDaemon, type RunningDaemon } from '../../src/daemon.js';
import { testDatabaseUrl } from '../integration/setup.js';

/** Per-turn wall clock for the test; the backend's own CHAT_TIMEOUT_MS (default 180 s) fires first. */
const TURN_TIMEOUT_MS = 240_000;

interface LiveAnswer {
  text: string;
  statuses: string[];
  end: ChatTurnEnd;
}

const root = mkdtempSync(join(tmpdir(), 'notesd-live-'));
const dataDir = join(root, 'data');
const tag = `live${randomBytes(4).toString('hex')}`;
const codeword = `kestrel-${randomBytes(3).toString('hex')}`;

let config: Config;
let daemon: RunningDaemon | undefined;
let noteId: string;

beforeAll(async () => {
  config = loadConfig({
    env: {
      ...process.env,
      DATABASE_URL: testDatabaseUrl(),
      NOTESD_PORT: '0',
      NOTES_DATA_DIR: dataDir,
      CHAT_BRAIN: 'claude',
    },
  });
  daemon = await startDaemon(config, { chat: createStubChatBackend({ delayMs: 0 }) });
  const note = await daemon.deps.service.create({
    body: `Live chat check. The codeword is ${codeword}. #${tag}`,
    origin: null,
  });
  noteId = note.id;
});

afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

async function ask(brain: ChatBrain, message: string): Promise<LiveAnswer> {
  if (daemon === undefined) throw new Error('daemon did not start');
  const chat: Config['chat'] = { ...config.chat, brain };
  const mcpUrl = `http://127.0.0.1:${daemon.port}/mcp`;
  const backend = createAgentChatBackend({
    chat,
    cwd: join(dataDir, CHAT_SUBDIR),
    mcpUrl: () => mcpUrl,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  try {
    const turn = await backend.reply({ message, threadId: null, signal: controller.signal });
    let text = '';
    const statuses: string[] = [];
    for await (const event of turn.events) {
      if (event.type === 'delta') text += event.text;
      else if (event.text !== '') statuses.push(event.text);
    }
    return { text, statuses, end: turn.end() };
  } finally {
    clearTimeout(timer);
    backend.close();
  }
}

function codewordPrompt(): string {
  return (
    `Find my note tagged #${tag} and tell me the codeword written in it. ` +
    'Answer in one short sentence and quote the note id.'
  );
}

function expectNotesAnswer(answer: LiveAnswer, brain: ChatBrain): void {
  expect(answer.end.brain).toBe(brain);
  expect(answer.end.threadId).toMatch(/\S/);
  expect(answer.text).toContain(codeword);
  expect(answer.text.toUpperCase()).toContain(noteId);
  expect(answer.statuses.length).toBeGreaterThan(0);
}

describe('chat brain, live', () => {
  it('answers a notes question on Claude, through the notes MCP tools', async () => {
    const answer = await ask('claude', codewordPrompt());
    expectNotesAnswer(answer, 'claude');
  });

  it('answers the same notes question on GLM', async () => {
    if (config.chat.glm === null) {
      throw new Error('LLM_BASE_URL, LLM_API_KEY and LLM_MODEL must be set in .env.local for the GLM live test.');
    }
    const answer = await ask('glm', codewordPrompt());
    expectNotesAnswer(answer, 'glm');
  });
});
```
**Impact:**
- `npm run typecheck` now typechecks this file (`tsconfig.json` includes `tests/**/*.ts`), so it compiles only once phase 2's `createAgentChatBackend` exists. That holds, because this phase depends on phase 2.
- The suite leaves one seeded note per run in the Docker test DB. The next integration run truncates it.
- The run creates SDK session files under `~/.claude/projects/<slug of the tmp chat dir>/`. They are harmless, and a reviewer can delete them.

### Step 6: INSTALL.md
**File:** `docs/INSTALL.md`
**Change:** five edits.

6a. Line 13 (Prerequisites, the `claude` bullet). Replace it with:
```markdown
- The `claude` CLI (on PATH, or next to node, or `CLAUDE_BIN=...`), **logged in**: the chat bar's
  brain runs headless Claude Code on your existing login (`~/.claude/.credentials.json`). No API
  key goes in this repo.
- Optional, for the chat bar's GLM fallback: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` in
  `.env.local` (see "4. Chat bar brain").
```

6b. Lines 29-30 (step 4 of "What it does"). Replace it with:
```markdown
4. Renders `deploy/notesd.service` with absolute paths (node, this checkout, data dir, `HOME`,
   and the real path of `claude` as `NOTESD_CLAUDE_BIN`) into
   `~/.config/systemd/user/notesd.service`, then `daemon-reload`, `enable` and `restart`.
   The absolute node and claude paths matter: the user manager's PATH does not include `~/tools/...`.
   Before that it warns (it does not stop) when `~/.claude/.credentials.json` is missing, when
   `.env.local` is missing, or when `.env.local` has no complete `LLM_*` set (GLM fallback off).
```

6c. Lines 40-46 (step 9 and its code block). Replace them with:
````markdown
9. Prints the verification and exits non-zero unless all four checks pass:

```sh
systemctl --user is-active notesd           # active
curl -s http://127.0.0.1:7317/health        # HTTP 200
claude mcp list | grep '^notes:'            # notes: http://localhost:7317/mcp (HTTP) - ✔ Connected
# chat: one real message through the installed daemon; the stream must end with `event: done`
curl -sN -H 'content-type: application/json' \
  -d '{"message":"Install check. Call the notes tags tool once, then reply with only the number of tags it returned. Use no other tool."}' \
  http://127.0.0.1:7317/api/chat | tail -n 3  # event: done / data: {"thread_id":"…","brain":"claude"}
```

The chat check prints which brain answered. `brain=glm` is a warning: Claude failed (login or
usage limit) and the fallback answered. `SKIP_CHAT_CHECK=1 scripts/install.sh` skips it (offline).
````

6d. Lines 129-141 (section 3). Replace the two sentences that name `notes-spine-images-ui` with generic wording. The section becomes:
````markdown
## 3. After a plan set lands (re-run from the main checkout)

A plan set is built in a worktree (for example `~/.worktrees/mcp-notes/chat-bar-brain`), and its
last phase runs `install.sh` from there, so the unit's `ExecStart` and `WorkingDirectory`, the
`.env.local` the daemon reads, and the skill symlink all point into the worktree. The worktree is deleted
when the branch lands, which leaves the unit failing and the skill dangling. Once the set is on
`main`:

```sh
cd ~/mcp-notes && git pull && scripts/install.sh
```

It rewrites the unit to `~/mcp-notes`, re-points the symlink, rebuilds and restarts. Confirm
with `systemctl --user cat notesd | grep ExecStart`.

A worktree has no `.env.local` of its own (it is gitignored). Before running `install.sh` from
one, link the owner's: `ln -s ~/mcp-notes/.env.local .env.local`.
````

6e. Insert before line 143 (`## Uninstall`) a new section:
````markdown
## 4. Chat bar brain

The chat bar (`POST /api/chat`) runs one headless Claude Code per message through the Claude
Agent SDK. notesd spawns the executable named by `NOTESD_CLAUDE_BIN` (the unit sets it to the
real path of `claude`, here `~/tools/node-v22.23.1-linux-x64/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`),
with `HOME` from the unit, so it uses your Claude Code login in `~/.claude/.credentials.json`.
The agent sees only the `notes` MCP server (`http://127.0.0.1:7317/mcp`, the same tools `/n`
uses) plus WebSearch and WebFetch. Your user settings, CLAUDE.md, hooks, plugins and other MCP
servers are not loaded. Answers are never saved as notes; edits the agent makes on request show
up on the wall like any other edit.

### Settings

All of these are read from the environment, merged over `.env.local` (the real environment
wins). Change `.env.local`, then `systemctl --user restart notesd`.

| Key | Default | Meaning |
|---|---|---|
| `CHAT_BRAIN` | `claude` | `claude` or `glm`. `glm` needs the three `LLM_*` keys (the daemon refuses to start without them). |
| `CHAT_MAX_TURNS` | `24` | Agent turn cap per message. |
| `CHAT_TIMEOUT_MS` | `180000` | Wall clock per message; the run is aborted after it. |
| `NOTESD_CLAUDE_BIN` | `claude` on PATH | Set by the unit; to change it, re-run `CLAUDE_BIN=/path/to/claude scripts/install.sh`. |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | unset | z.ai GLM endpoint, key and model (glm-5.3). Set: a Claude run that fails on a usage limit or authentication before any text is retried once on GLM. Unset: no fallback. |

The GLM key stays in `.env.local`; it is never written into the unit. A Claude run's child
environment never carries `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN`,
so it always uses the login.

The panel's header shows which brain answered (`claude` / `glm`) in small mono type, and what
the agent is doing while it works (`searching notes`, `reading 3 notes`, `searching the web`).

### Threads

A follow-up in an open (or pinned) panel continues the same Claude Code session; dismissing the
panel starts a new one. Sessions are stored by Claude Code under
`~/.claude/projects/-home-miftah-mcp-notes-data-chat/` (the slug of the fixed run directory
`~/mcp-notes-data/chat`), so a thread survives a daemon restart for as long as its `.jsonl` is
there. Each `.jsonl` is also the full transcript of that thread, tool calls included: the place
to look when an answer is wrong.

### Logs and checks

- Daemon output and chat failures: `journalctl --user -u notesd -f`.
- One message by hand: `curl -sN -H 'content-type: application/json' -d '{"message":"how many notes do i have tagged #seer?"}' http://127.0.0.1:7317/api/chat`
  (events: `status`, `delta`, then `done` with `thread_id` and `brain`, or `error`).
- Live suite (real Claude + real GLM, against the Docker test database, not your notes):
  `npm run test:live`. Opt-in; `npm test` and `npm run test:int` never run it.
````

6f. Append to `## Troubleshooting` (after line 161):
```markdown
- Chat answers `Chat failed: …` or the installer's chat check fails: `journalctl --user -u notesd -n 50`.
  Check the login with `claude -p hi` in a terminal; if that asks you to log in, run `claude` and
  `/login`. `systemctl --user cat notesd | grep NOTESD_CLAUDE_BIN` must name an existing file
  (a Claude Code reinstall into a different directory needs `scripts/install.sh` again).
- The panel says `glm` when you expected `claude`: Claude hit a usage limit or the login failed,
  and the fallback answered. The journal has the Claude error.
```
**Impact:** documentation only.

### Step 7: Gate before installing
Run from the worktree. Every command must pass before Step 8.
```bash
cd /home/miftah/.worktrees/mcp-notes/chat-bar-brain
# Idempotent: an existing file or working link is left alone; a missing or dangling link is (re)made.
[ -f .env.local ] || ln -sfn /home/miftah/mcp-notes/.env.local .env.local
git check-ignore -q .env.local   # must succeed: .gitignore line 1 is `.env.local`
npm ci
npm run typecheck
npm test
npm run test:int
bash -n scripts/install.sh
npm run test:live
```
`.env.local` is gitignored (`.gitignore:1`, verified at reconcile time), so the symlink is never committed (`git status --short` must not show it). Re-running the step is a no-op once the link resolves. If `npm run test:live` fails on Claude with an auth or limit error, record it and go on to GLM. Do not weaken the assertions.

### Step 8: Install from the worktree
```bash
cd /home/miftah/.worktrees/mcp-notes/chat-bar-brain
scripts/install.sh 2>&1 | tee "${TMPDIR:-/tmp}/chat-bar-brain-install.log"
systemctl --user cat notesd | grep -E 'ExecStart|HOME=|NOTESD_CLAUDE_BIN='
```
Expected:
- the verification prints `POST http://127.0.0.1:7317/api/chat: done, brain=claude` and `OK`
- `NOTESD_CLAUDE_BIN=/home/miftah/tools/node-v22.23.1-linux-x64/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`
- `HOME=/home/miftah`
- the expected worktree warning

The unit now runs `/home/miftah/.worktrees/mcp-notes/chat-bar-brain/dist/main.js` until the orchestrator re-installs from `~/mcp-notes` after landing (see Handoffs).

### Step 9: Acceptance against the installed daemon
Run all of it in one bash shell (functions and variables are reused). Transcripts go outside the repo, because they contain the owner's note text and must not be committed. Only the summary table goes into the phase report.

**Safety rules for this step:**
- Never edit an existing note of the owner's. The brief's `A-B32` does not exist in the owner's database (`GET /api/notes/A-B32` → 404 at plan time). Even if it does exist when you run this, do not use it. Every write prompt targets a throwaway note created here and tagged `#acceptance`.
- Every throwaway note is soft-deleted at the end (A9). It can be restored, nothing is purged.

**A0. Helpers**
```bash
set -uo pipefail
API=http://127.0.0.1:7317
ACC="${TMPDIR:-/tmp}/chat-bar-brain-acceptance"
mkdir -p "$ACC"

cat > "$ACC/sse-summary.mjs" <<'EOF'
import { readFileSync } from 'node:fs'
const raw = readFileSync(process.argv[2], 'utf8')
let text = ''
const statuses = []
let done = null
let error = null
for (const block of raw.split('\n\n')) {
  let event = 'message'
  const data = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  if (data.length === 0) continue
  const payload = JSON.parse(data.join('\n'))
  if (event === 'delta') text += payload.text
  else if (event === 'status' && payload.text) statuses.push(payload.text)
  else if (event === 'done') done = payload
  else if (event === 'error') error = payload.error
}
const ids = [...new Set(text.match(/\b[0-9A-Z]-[0-9A-Z]{3}\b/g) ?? [])]
console.log(JSON.stringify({ done, error, statuses: [...new Set(statuses)], ids, chars: text.length }, null, 2))
console.log('--- answer ---')
console.log(text)
EOF

wait_health() {
  local i
  for i in $(seq 1 30); do curl -fsS --max-time 2 "$API/health" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "notesd not healthy" >&2; return 1
}

# ask <name> <message> [thread_id]: streams one chat turn to $ACC/<name>.sse and summarizes it.
ask() {
  local body
  if [[ -n "${3:-}" ]]; then
    body="$(jq -nc --arg m "$2" --arg t "$3" '{message: $m, thread_id: $t}')"
  else
    body="$(jq -nc --arg m "$2" '{message: $m}')"
  fi
  curl -sS -N --max-time 300 -H 'content-type: application/json' --data-binary "$body" \
    "$API/api/chat" > "$ACC/$1.sse"
  node "$ACC/sse-summary.mjs" "$ACC/$1.sse"
}

thread_of() { sed -n '/^event: *done/{n;s/^data: *//p;}' "$ACC/$1.sse" | tail -n 1 | jq -r .thread_id; }
brain_of()  { sed -n '/^event: *done/{n;s/^data: *//p;}' "$ACC/$1.sse" | tail -n 1 | jq -r '.brain // "none"'; }

wait_health
curl -s -o /dev/null -w 'A-B32: HTTP %{http_code} (not used either way)\n' "$API/api/notes/A-B32"
```

**A1. Seer summary (R1 notes read, R4 captions)**
```bash
ask a1-seer 'summarize our notes on #seer this week. compare it to last week'
```
Pass when `done` is present with `brain: "claude"`, `statuses` contains `searching notes`, and the answer is plain prose with no `#` headings or tables. If the owner has `#seer` notes it quotes their ids. If there are none, it says so. Either is a pass. Record which.

**A2. Markdown cleanup + tag on a throwaway note (R1 writes, wall SSE)**
```bash
MD_BODY=$'# Acceptance scratch\n\n**Bold claim** and a [link](https://example.com).\n\n- first item\n- second item\n\n#acceptance'
MD_ID="$(curl -sS -H 'content-type: application/json' \
  --data-binary "$(jq -nc --arg b "$MD_BODY" '{body: $b}')" "$API/api/notes" | jq -r .id)"
echo "throwaway markdown note: $MD_ID"

curl -sS -N --max-time 320 "$API/api/events" > "$ACC/a2-events.sse" &
EV_PID=$!
sleep 1
ask a2-edit "check note $MD_ID . i just copy paste it in a markdown format. please remove the markdown formatting in it. also add tag #agentic to it"
sleep 2
kill "$EV_PID" 2>/dev/null

curl -sS "$API/api/notes/$MD_ID" | jq '{body, tags}'
grep -A1 '^event: note' "$ACC/a2-events.sse" | grep -F "\"id\":\"$MD_ID\""
```
Pass when all of these hold:
- `statuses` contains `editing a note` (and `reading a note`).
- The note's new body has no `# `, `**`, `[`…`](` or leading `- `.
- `tags` contains both `agentic` and `acceptance`.
- The answer quotes `$MD_ID`.
- The events capture has a `note` event with `"op":"update"` (or `append`) for `$MD_ID`. That event is what moves the wall.

**A3. Photos saved today, 30 Oct (R1 `view_images`)**
The owner's database had no image notes at plan time, so make one through the real inbox path:
```bash
cd /home/miftah/.worktrees/mcp-notes/chat-bar-brain
STAMP="$(date +%s)"
node --input-type=module -e "
import sharp from 'sharp'
const r = 120 + (Date.now() % 60)
const svg = '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"640\" height=\"480\"><rect width=\"640\" height=\"480\" fill=\"#1d4ed8\"/><circle cx=\"320\" cy=\"240\" r=\"' + r + '\" fill=\"#dc2626\"/></svg>'
await sharp(Buffer.from(svg)).jpeg().toFile(process.argv[1])
" "$ACC/acceptance-$STAMP.jpg"
cp "$ACC/acceptance-$STAMP.jpg" "$HOME/mcp-notes-data/inbox/acceptance-$STAMP.jpg"

IMG_ID=""
for i in $(seq 1 30); do
  IMG_ID="$(curl -sS "$API/api/notes?has_image=true&limit=20" \
    | jq -r --arg n "acceptance-$STAMP.jpg" '.notes[] | select(.image.original_name == $n) | .id' | head -n 1)"
  [[ -n "$IMG_ID" ]] && break
  sleep 1
done
echo "throwaway image note: ${IMG_ID:-<not ingested; check ~/mcp-notes-data/inbox/failed and the journal>}"
curl -sS -X PATCH -H 'content-type: application/json' \
  --data-binary '{"body":"acceptance test photo #acceptance"}' "$API/api/notes/$IMG_ID" | jq '{id, tags}'

ask a3-photos 'show me some pictures that i saved on 30 oct . give your comments on them'
```
Pass when `statuses` contains `looking at a photo` or `looking at N photos`, the answer quotes `$IMG_ID`, and it describes a red circle on a blue background (proof it looked at the picture and did not just read the metadata). If the owner has real photos from 30 Oct, they may appear too. That is fine.

**A4. Verity, notes plus web (R1 WebSearch)**
```bash
ask a4-verity 'when did i watch Verity? can you do some web search to see what is it about?'
VERITY_THREAD="$(thread_of a4-verity)"
echo "thread: $VERITY_THREAD"
```
Pass when `statuses` contains both `searching notes` and `searching the web`, the answer says what the notes show (a date with the note id, or that no note mentions it) and summarizes Verity from the web, and `done.thread_id` is non-empty.

**A5. Follow-up in the same thread, across a daemon restart (R2 resume)**
```bash
systemctl --user restart notesd && wait_health
ask a5-followup 'and what did i write about it the week after?' "$VERITY_THREAD"
echo "follow-up thread: $(thread_of a5-followup)"
```
Pass when the answer clearly continues the Verity context (it resolves "it" to Verity without being told) and `done.thread_id` is non-empty. Record whether it equals `$VERITY_THREAD`. The restart shows resume survives it (R2). Note: R2 belongs to phases 2 and 3; this is evidence only.

**A6. Abort on client disconnect (R1 guardrail)**
```bash
MAIN_PID="$(systemctl --user show -p MainPID --value notesd)"
( sleep 3; pgrep -a -P "$MAIN_PID" > "$ACC/a6-during.txt" ) &
curl -sS -N --max-time 6 -H 'content-type: application/json' \
  --data-binary '{"message":"search the web for reviews of the novel Verity and write a long, detailed summary of them"}' \
  "$API/api/chat" > "$ACC/a6-abort.sse" || true
sleep 10
echo "during:"; cat "$ACC/a6-during.txt"
echo "after:"; pgrep -a -P "$MAIN_PID" || echo "no children"
```
Pass when `during` lists a `claude.exe` child and `after` prints `no children`. The run was stopped when curl hung up.

**A7. GLM brain through the installed daemon (R5 with R3's config path)**
A systemd drop-in sets `CHAT_BRAIN=glm`. The real env beats `.env.local`. The drop-in is removed afterwards.
```bash
DROPIN_DIR="$HOME/.config/systemd/user/notesd.service.d"
mkdir -p "$DROPIN_DIR"
printf '[Service]\nEnvironment=CHAT_BRAIN=glm\n' > "$DROPIN_DIR/acceptance-glm.conf"
systemctl --user daemon-reload && systemctl --user restart notesd && wait_health
ask a7-glm 'how many of my notes are tagged #acceptance? quote their ids'
echo "brain: $(brain_of a7-glm)"
rm -f "$DROPIN_DIR/acceptance-glm.conf"
rmdir "$DROPIN_DIR" 2>/dev/null || true
systemctl --user daemon-reload && systemctl --user restart notesd && wait_health
systemctl --user show -p Environment notesd | grep -c CHAT_BRAIN || true   # must print 0
```
Pass when `brain: glm` and the answer quotes `$MD_ID` and `$IMG_ID`, and the final `grep -c` prints `0` (the drop-in is gone). The fallback *trigger* (Claude auth/limit failure → GLM) is not forced here. That would mean breaking the owner's login. It is covered by phase 2's unit tests against the fake `query`. Say so in the report.

**A8. Panel (manual, owner or any session with a browser; optional for the phase gate)**
Open `http://localhost:7317` and type A1's prompt.
- While it runs, the header line shows the caption (`searching notes`). When done, it shows `claude`.
- Dismiss, ask again: a new thread.
- Pin, ask a follow-up: the same thread.

Record "not checked" if no browser is available. This is phase 3's surface, and the phase-4 gate is A1-A7.

**A9. Cleanup (always run, even after a failure)**
```bash
for id in "$MD_ID" "$IMG_ID"; do
  [[ -n "$id" ]] && curl -sS -X DELETE "$API/api/notes/$id" | jq -c '{id, deleted_at}'
done
curl -sS "$API/api/notes?tag=acceptance&limit=5" | jq '.notes | length'   # must print 0
rm -f "$HOME/.config/systemd/user/notesd.service.d/acceptance-glm.conf"
```
The deleted notes stay restorable (soft delete). Transcripts in `$ACC` are left for the reviewer and are not committed.

**A10. Record.** Put this table in the phase report, one row per check, with brain, the statuses seen, the ids quoted and pass/fail. No answer text from the owner's notes.

| Check | Prompt | Brain | Statuses | Ids quoted | Result | Notes |
|---|---|---|---|---|---|---|
| install chat smoke | install check | | | | | |
| live suite | codeword (claude, glm) | | | | | |
| A1 | seer this week vs last | | | | | |
| A2 | markdown cleanup + #agentic on `<MD_ID>` | | | | | wall event seen? |
| A3 | pictures saved on 30 oct | | | | | described red circle? |
| A4 | Verity + web | | | | | |
| A5 | follow-up after restart | | | | | same thread id? |
| A6 | abort on disconnect | | | | | child gone? |
| A7 | GLM via drop-in | | | | | drop-in removed? |
| A8 | panel (manual) | | | | | |

**If an acceptance check fails because of a backend bug:** fix it in the phase-2 file (`src/chat/agent.ts`, `prompt.ts`, `status.ts` or `env.ts`), add a unit test that fails without the fix, re-run Step 7's gate, re-run `scripts/install.sh`, and re-run the failed check. List each such fix in the report under "Backend fixes during acceptance". `web/` is never edited in this phase. A UI defect goes to Handoffs for phase 3.

## Verification

**Build:** `npm run build` (also run by `scripts/install.sh`)
**Tests:**
- `npm run typecheck && npm test && npm run test:int`: unchanged suites stay green, and `tests/live/**` is not collected by either run.
- `npm run test:live`: two live tests pass.
- `bash -n scripts/install.sh`: syntax.

Also check that `npm test -- --reporter=verbose 2>&1 | grep -c live.test` prints `0`.
**Manual check:** Step 8 output (`done, brain=claude`, the two new `Environment=` lines in the installed unit), and the A0-A9 run.
**Exit criteria:**
- The installed daemon (built from this worktree) answers A1-A5 for real on `claude`, A6 shows the SDK child gone after a disconnect, and A7 answers on `glm`.
- The A2 throwaway note lost its markdown and gained `#agentic`, with a wall `note` event.
- `npm run test:live` passes, and the throwaway notes are soft-deleted.
- The report contains the A10 table and the post-landing note below.

## Handoffs

- **Orchestrator / landing step (mandatory):** after `feature/chat-bar-brain` lands on `main`, run `cd ~/mcp-notes && git pull && scripts/install.sh`. Until then the unit's `ExecStart`, `WorkingDirectory` and the `/n` skill symlink point into `/home/miftah/.worktrees/mcp-notes/chat-bar-brain`. Deleting the worktree before re-installing leaves notesd failing. Confirm with `systemctl --user cat notesd | grep -E 'ExecStart|NOTESD_CLAUDE_BIN'` that it points at `/home/miftah/mcp-notes/dist/main.js`, and that the post-landing `install.sh` printed `done, brain=claude`.
- **Phase 2 (R1), resolved at reconcile:** Phase 2's `src/chat/env.ts` owns dropping `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT` and every `CLAUDE_CODE_*` key from the child env, with a unit test. `DISABLE_AUTOUPDATER` is not set (see the index Decisions). The live suite's options object is aligned with Phase 2's `AgentChatOptions`.
- **Phase 1 (R3):** `loadConfig` must let the real env override `.env.local` for `CHAT_BRAIN` (the existing merge already does this). Acceptance A7 relies on it.
- **Phase 3 (R2/R3/R4):** any panel defect seen in A8 goes back to phase 3. This phase does not touch `web/`.
- **Not done here (deliberately):** forcing the Claude→GLM fallback against the installed daemon. It would require invalidating the owner's login. Phase 2's unit tests own that path (R3).

## Rollback

- Code: `git revert <phase-4 commit>` restores the unit template, install.sh, the vitest config, package.json and INSTALL.md, and removes `tests/live/`.
- Installed daemon: `cd ~/mcp-notes && scripts/install.sh` (main does not have this phase yet, so it renders the old unit without `HOME`/`NOTESD_CLAUDE_BIN` and points it back at `~/mcp-notes`).
- Acceptance data: the throwaway notes are soft-deleted already. To undo the A2 edit history, nothing is needed because the note is throwaway. If the A7 drop-in was left behind: `rm ~/.config/systemd/user/notesd.service.d/acceptance-glm.conf && systemctl --user daemon-reload && systemctl --user restart notesd`.
- The worktree's `.env.local` symlink: `rm /home/miftah/.worktrees/mcp-notes/chat-bar-brain/.env.local` (it is untracked).
