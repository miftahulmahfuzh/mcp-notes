> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/project-session-graph/PLAN.md` phase 5. Source: `.workflows/plan/project-session-graph/phase-5.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 5: SessionStart + Bash spawn hooks, hook endpoints, install

**Plan set:** `PROJECT_SESSION_GRAPH_PLAN.md`
**Analysis:** `docs/analyzer/20261102-093105-N9JN_code_analyzer.md`
**Satisfies:** R2 — exact parent links from now on: a swarm child (`CC_PARENT_SESSION`) gets `env`, a hand-rolled `tmux ... claude` gets `hook`, and every session is told its own node id and its parent's
**Depends on:** Phase 1 (`SessionsRepo`, `cc_sessions`, `cc_pending_spawns`)
**Difficulty:** HARD
**Package:** `claude/hooks`, `src/http`, `scripts`

---

## Goal

Every Claude Code `cli` session that starts on a machine with the hooks installed reports itself to
notesd through a SessionStart hook. The daemon upserts its `cc_sessions` row, links its parent
exactly (`env` from `CC_PARENT_SESSION`, which Phase 2 makes swarm.py set, or `hook` by claiming a
pending spawn that the new Bash PreToolUse hook recorded within the last 30 s), and answers with the
node ids, which the hook hands to the session as `additionalContext`. `scripts/install.sh` registers
both hooks through `scripts/claude-hooks.mjs` and raises `cleanupPeriodDays` to 3650 so Claude Code
stops deleting transcripts the graph ingests.

## Claude Code hook contract used (checked against the existing hooks and the live tool env)

- **SessionStart input (stdin JSON):** `{session_id, transcript_path, cwd, hook_event_name: "SessionStart", source: "startup" | "resume" | "clear" | "compact", model?}`.
  Output: `{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}`
  on stdout. The group has no matcher, so it fires for all four sources.
- **PreToolUse (Bash) input:** `{session_id, transcript_path, cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {command, description?, timeout?, run_in_background?}}`.
  Exit 0 with **empty stdout** means "no decision": the normal permission flow continues. The spawn hook
  never prints, so it can never allow, deny or rewrite anything.
- **Env a hook inherits from the Claude Code process** (measured in a tool env on this machine
  today): `CLAUDE_CODE_ENTRYPOINT=cli`, `CLAUDE_PID=<claude pid>`, `CLAUDE_CODE_SESSION_ID`,
  `TMUX`, `TMUX_PANE=%9`. `CC_PARENT_SESSION` is present only in a tmux child that swarm.py
  launched with `-e CC_PARENT_SESSION=<id>` (Phase 2 contract).
- **Live registry:** `~/.claude/sessions/<pid>.json` holds `{sessionId, name, tmux: "iter1:@127.%255", ...}`
  once Claude Code has written it; at SessionStart it may not exist yet, so name/tmux fall back to the
  claude process's argv (`/proc/<pid>/cmdline`, `-n/--name`) and `tmux display-message`.

**`source` policy (no duplicate parent claims):**

| source | upsert row (name, tmux, cwd, transcript) | `started_at` sent | `env` parent link | claim pending spawn |
|---|---|---|---|---|
| `startup` (or missing) | yes | hook's now | yes | yes, if tmux and cwd are known and the row has no `env`/`hook` parent yet |
| `clear` (new session id, same process) | yes | hook's now | yes | no (the original start already claimed it) |
| `resume` | yes | null | no | no |
| `compact` | yes | null | no | no |

All four print the context again, so a compacted or resumed session re-learns its node id.

## Interface Contract

**Deletes:** none.
**Renames:** none.
**Creates:**
- `claude/hooks/notes-session.mjs`: `runSession`, `buildContext`, `isCliSession`, `sessionIdOf`,
  `parentFrom`, `claudeHome`, `candidatePids`, `nameFromArgv`, `isClaudeWord`, `cleanName`,
  `registryEntry`, `nameFromProcesses`, `tmuxTarget`, constants `HOOK_EVENT`, `START_PATH`,
  `POST_TIMEOUT_MS`, `TMUX_TIMEOUT_MS`, `LOG_FILE` (`session.log`), `PARENT_ENV`, `FRESH_SOURCES`,
  `TMUX_TARGET_FORMAT` + `claude/hooks/notes-session.d.mts`.
- `claude/hooks/notes-spawn.mjs`: `runSpawn`, `detectSpawn`, `mayLaunchClaude`, `shellTokens`,
  `segmentsOf`, `parseFlags`, `resolveDir`, `claudeLaunchIn`, constants `TOOL_NAME`, `SPAWN_PATH`,
  `POST_TIMEOUT_MS`, `LOG_FILE` (`spawn.log`) + `claude/hooks/notes-spawn.d.mts`.
- `src/http/sessionHooks.ts`: `sessionHookRoutes(deps, options?)`, `SessionHookOptions`,
  `SessionHookStartReply`, `SESSION_HOOK_START_PATH` (`/api/sessions/hook/start`),
  `SESSION_HOOK_SPAWN_PATH` (`/api/sessions/hook/spawn`), `MAX_SESSION_HOOK_BODY_BYTES`,
  `PENDING_SPAWN_WINDOW_MS` (re-exported from Phase 1's `src/sessions/types.ts`, not redefined),
  `PENDING_SPAWN_RETAIN_MS` (24 h; the spawn route prunes older pending spawns), `FRESH_START_SOURCES`, `CLAIMING_SOURCES`.
- `scripts/claude-hooks.mjs`: `HOOK_SCRIPTS`, `SPAWN_MATCHER` (`'Bash'`), `SESSION_TIMEOUT_S` (10),
  `SPAWN_TIMEOUT_S` (5), `DEFAULT_RETENTION_DAYS` (3650), `STATUS_ROWS`, `raiseCleanupPeriod(settings, minDays)`,
  CLI subcommand `retention --settings FILE --min-days N`.
- `scripts/install.sh`: function `raise_retention`, var `RETENTION_DAYS` (env `NOTES_CLAUDE_RETENTION_DAYS`, default 3650).
- Wire: `POST /api/sessions/hook/start` and `POST /api/sessions/hook/spawn` (loopback + `X-Notes-Capture: 1` + JSON, via the existing `captureGuard`).

**Signature changes:**
- `scripts/claude-hooks.mjs` `ourGroups(options)`: was `Record<event, group>`, now `Record<event, group[]>`
  (PreToolUse now carries two groups: paste, then Bash spawn). Events: `Stop`, `PreToolUse`,
  `UserPromptSubmit`, `SessionStart`.
- `ourHandlers(settings)`: was keyed by event (`{Stop: cmd}`), now keyed `"<event> <script>"`
  (`{"PreToolUse notes-spawn": cmd}`), because one event now has two of our handlers.
- `OUR_SCRIPT` widened to `notes-(capture|paste|prompt|session|spawn)\.mjs`.
- `status` CLI prints five lines (`Stop notes-capture`, `PreToolUse notes-paste`, `PreToolUse notes-spawn`,
  `UserPromptSubmit notes-prompt`, `SessionStart notes-session`).

**Requires (from earlier phases):** Phase 1, as published in its plan (`src/sessions/repo.ts`,
`src/sessions/types.ts`): `new SessionsRepo(db, opts?)` with

```ts
upsertFromHook(start: HookStart): Promise<HookStartResult>
  // HookStart = { sessionId; host; cwd?; repo?; name?; tmux?; startedAt?; parentSessionId?; parentSource? /* default 'env' */ }
  // HookStartResult = { session: SessionRow; parent: SessionRow | null; parentLink: SetParentResult | null }
  // ensures the child row (node id on insert) and the parent row; never overwrites non-null with null; keeps the earliest started_at
getBySessionId(sessionId: string): Promise<SessionRow | null>   // sessionId, nodeId, parentSessionId, parentLinkSource, ...
recordPendingSpawn(input: { parentSessionId; host; cwd; name?; createdAt? }): Promise<PendingSpawnRow>
claimPendingSpawn(claim: { childSessionId; host; cwd; name?; at?; windowMs? }): Promise<{ spawn: PendingSpawnRow; parentLink: SetParentResult } | null>
  // same host + normalized cwd, unclaimed, created_at in [at - windowMs, at + 5 s], parent != child,
  // name only compared when both sides have one; claims at most once (for update skip locked) and
  // sets the child's parent as 'hook' in the same transaction
prunePendingSpawns(before: Date): Promise<number>
```
and `PENDING_SPAWN_WINDOW_MS` (30 000) in `src/sessions/types.ts`. `HookStart` has no
`transcriptPath`: the hook still sends `transcript_path` (accepted and ignored by the route);
phase 3's ingest records the path.

Phase 2: swarm children carry `CC_PARENT_SESSION=<parent CLAUDE_CODE_SESSION_ID>` (not needed to
build or test this phase; only for the live effect).

**Leaves alone (owned by others):** `claude/hooks/notes-prompt.mjs` (Phase 8), `src/sessions/*`
(Phases 1, 3, 4, 6, 9, 13), `src/http/sessionsApi.ts` and its mount (Phase 7), `src/background.ts`,
`src/config.ts` (Phase 3), `tests/integration/setup.ts` `truncateAll` (Phase 1 — already covers the session tables), README/CLAUDE.md (Phase 14), `~/claude-commands` (Phase 2).

## Files

| File | Action | What changes |
|---|---|---|
| `claude/hooks/notes-session.mjs` | create | SessionStart hook |
| `claude/hooks/notes-session.d.mts` | create | types for the tests |
| `claude/hooks/notes-spawn.mjs` | create | Bash PreToolUse hook (record-only) |
| `claude/hooks/notes-spawn.d.mts` | create | types for the tests |
| `src/http/sessionHooks.ts` | create | the two hook endpoints |
| `src/http/app.ts:12,58-66,85` | modify | import + mount `sessionHookRoutes` after `captureRoutes`, doc comment |
| `scripts/claude-hooks.mjs` | modify (full replacement below) | two new groups, array groups, widened regex, status rows, `retention` subcommand |
| `scripts/claude-hooks.d.mts` | modify (full replacement) | new exports and shapes |
| `scripts/install.sh:2-25,46-50,111-114,249-264,331-348` | modify | header, `RETENTION_DAYS`, precondition list, `register_hooks` text, new `raise_retention`, `main` |
| `scripts/uninstall.sh:2-7,408-422` | modify | five hooks in comments/messages; retention kept on uninstall |
| `tests/unit/hooks/notesSession.test.ts` | create | hook unit tests |
| `tests/unit/hooks/notesSpawn.test.ts` | create | detector table + hook unit tests |
| `tests/unit/scripts/claudeHooks.test.ts` | modify (full replacement) | new groups, status, retention, install.sh `raise_retention` |
| `tests/integration/sessionHooks.int.test.ts` | create | endpoint + end-to-end hook tests against the test DB |

## Implementation Steps

### Step 1: SessionStart hook
**File:** `claude/hooks/notes-session.mjs` (new)
**Change:** new hook script, same shape as `notes-paste.mjs` / `notes-prompt.mjs` (pure `run*`
function with injected I/O, `main()` guarded by `isMainModule`).
**Code:**
```js
#!/usr/bin/env node
/**
 * notes-session: Claude Code SessionStart hook for mcp-notes (the session graph).
 *
 * Tells notesd that a Claude Code session started, resumed, cleared or compacted on this machine,
 * so the graph learns the session's exact parent and its tmux pane before the transcript ingester
 * has read a byte, and tells the session its own node id and its parent's:
 *
 * 1. A non-`cli` session (CLAUDE_CODE_ENTRYPOINT sdk-ts / sdk-cli: the wall chat agent, `claude -p`
 *    helper runs) returns at once: no I/O, no output.
 * 2. It gathers {session, parent, cwd, name, tmux, host, started_at, source, transcript_path}.
 *    parent is CC_PARENT_SESSION (swarm.py spawn_argv sets it on the tmux child). name and tmux come
 *    from Claude Code's live registry (<claude home>/sessions/<CLAUDE_PID>.json) when it already
 *    lists this session, else name from the claude process's `-n/--name` argv and tmux from
 *    `tmux display-message` on TMUX_PANE.
 * 3. It POSTs that to /api/sessions/hook/start (loopback, X-Notes-Capture: 1) within
 *    POST_TIMEOUT_MS. The daemon links the parent ('env'), or claims a pending spawn recorded by the
 *    notes-spawn hook ('hook'); only a fresh start does that, never resume or compact.
 * 4. It prints {hookSpecificOutput:{hookEventName:'SessionStart', additionalContext}} naming the node
 *    id and the parent's node id. Daemon down, an error, or no node id in the reply: no output.
 *
 * Always exits 0; stdout carries only the hook JSON (or nothing). Problems go to
 * ${XDG_STATE_HOME:-~/.local/state}/notes-capture/session.log. Node >= 22 built-ins only.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { daemonBaseUrl, errorText, isMainModule, readStdin, stateDir, writeLog } from './lib/state.mjs';

export const HOOK_EVENT = 'SessionStart';
export const START_PATH = '/api/sessions/hook/start';
export const POST_TIMEOUT_MS = 3000;
export const TMUX_TIMEOUT_MS = 1000;
export const LOG_FILE = 'session.log';
export const PARENT_ENV = 'CC_PARENT_SESSION';
/** Sources that begin a new session id: the only ones that send started_at. */
export const FRESH_SOURCES = ['startup', 'clear'];
/** Same shape as the registry's `tmux` field: `iter1:@127.%255`. */
export const TMUX_TARGET_FORMAT = '#{session_name}:#{window_id}.#{pane_id}';

const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z-]{7,99}$/;
const NODE_ID = /^[0-9A-Z]{2}-[0-9A-Z]{2}$/;
const PID = /^[1-9]\d{0,9}$/;
const PANE = /^%\d{1,9}$/;
const MAX_NAME = 200;
const MAX_TMUX = 200;

/** True for a terminal session: CLAUDE_CODE_ENTRYPOINT unset or `cli`. */
export function isCliSession(env) {
  const entry = typeof env.CLAUDE_CODE_ENTRYPOINT === 'string' ? env.CLAUDE_CODE_ENTRYPOINT.trim() : '';
  return entry === '' || entry === 'cli';
}

/** The hook input's session_id when it looks like a Claude Code session id, else null. */
export function sessionIdOf(input) {
  if (input === null || typeof input !== 'object') return null;
  const id = typeof input.session_id === 'string' ? input.session_id.trim() : '';
  return SESSION_ID.test(id) ? id : null;
}

/** CC_PARENT_SESSION when it is a session id other than this session's own, else null. */
export function parentFrom(env, sessionId) {
  const raw = typeof env[PARENT_ENV] === 'string' ? env[PARENT_ENV].trim() : '';
  if (!SESSION_ID.test(raw) || raw === sessionId) return null;
  return raw;
}

/** CLAUDE_CONFIG_DIR when absolute, else $HOME/.claude. */
export function claudeHome(env) {
  const configured = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  if (configured !== '' && path.isAbsolute(configured)) return configured;
  const home = typeof env.HOME === 'string' && env.HOME !== '' ? env.HOME : os.homedir();
  return path.join(home, '.claude');
}

/** The pids that may be the claude process: CLAUDE_PID first, then this hook's parent. Distinct. */
export function candidatePids(env, ppid) {
  const out = [];
  const raws = [env.CLAUDE_PID, ppid === undefined || ppid === null ? '' : String(ppid)];
  for (const raw of raws) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (PID.test(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

/** Whitespace collapsed, at most MAX_NAME chars; null when empty or not a string. */
export function cleanName(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return text === '' ? null : text;
}

function cleanTmux(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text.length > MAX_TMUX || /\s/.test(text)) return null;
  return text;
}

/** True for a word that runs Claude Code: `claude`, `/x/bin/claude`, `claude.exe`, `.../claude-code/cli.js`. */
export function isClaudeWord(word) {
  if (typeof word !== 'string' || word === '') return false;
  const base = path.basename(word);
  return base === 'claude' || base === 'claude.exe' || /claude-code\/cli\.m?js$/.test(word);
}

/** The `-n X` / `--name X` / `--name=X` value of a claude argv; null when argv is not claude's or has none. */
export function nameFromArgv(argv) {
  if (!Array.isArray(argv) || !argv.some(isClaudeWord)) return null;
  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i];
    if (typeof word !== 'string') continue;
    if ((word === '-n' || word === '--name') && typeof argv[i + 1] === 'string') return cleanName(argv[i + 1]);
    if (word.startsWith('--name=')) return cleanName(word.slice('--name='.length));
  }
  return null;
}

/** {pid, name, tmux} from <home>/sessions/<pid>.json for the first pid whose entry names this session. */
export async function registryEntry(home, pids, sessionId, readText) {
  for (const pid of pids) {
    let parsed;
    try {
      parsed = JSON.parse(await readText(path.join(home, 'sessions', `${pid}.json`)));
    } catch {
      continue;
    }
    if (parsed !== null && typeof parsed === 'object' && parsed.sessionId === sessionId) {
      return { pid, name: cleanName(parsed.name), tmux: cleanTmux(parsed.tmux) };
    }
  }
  return null;
}

/** The `-n/--name` of the first candidate pid that is a claude process, from /proc/<pid>/cmdline. */
export async function nameFromProcesses(pids, readText) {
  for (const pid of pids) {
    let text;
    try {
      text = await readText(`/proc/${pid}/cmdline`);
    } catch {
      continue;
    }
    const name = nameFromArgv(text.split('\0').filter((word) => word !== ''));
    if (name !== null) return name;
  }
  return null;
}

/** `session:@window.%pane` for TMUX_PANE; the bare pane id when tmux cannot say; null outside tmux. */
export async function tmuxTarget(env, runTmux) {
  const pane = typeof env.TMUX_PANE === 'string' ? env.TMUX_PANE.trim() : '';
  if (typeof env.TMUX !== 'string' || env.TMUX === '' || !PANE.test(pane)) return null;
  try {
    const target = cleanTmux(await runTmux(['display-message', '-p', '-t', pane, TMUX_TARGET_FORMAT]));
    if (target !== null) return target;
  } catch {
    // tmux gone or slow: the pane id is still worth having.
  }
  return pane;
}

function defaultRunTmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: TMUX_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function linkPhrase(source) {
  if (source === 'env') return ' (exact link: it was launched by swarm.py)';
  if (source === 'hook') return ' (linked from the tmux launch it ran)';
  if (source === 'heuristic') return ' (inferred from its transcript)';
  return '';
}

/** The additionalContext for a reply carrying this session's node id. */
export function buildContext(reply) {
  const node = reply.node_id;
  const lines = [
    `This Claude Code session is node ${node} in the user's session graph (the Projects page of the mcp-notes wall). ` +
      `Quote ${node} when the user or another session needs to refer to this session.`,
  ];
  const parentNode = typeof reply.parent_node_id === 'string' && NODE_ID.test(reply.parent_node_id) ? reply.parent_node_id : null;
  const parentSession = typeof reply.parent_session_id === 'string' && reply.parent_session_id !== '' ? reply.parent_session_id : null;
  const source = typeof reply.parent_link_source === 'string' ? reply.parent_link_source : null;
  if (parentNode !== null) {
    lines.push(`It was spawned by node ${parentNode}${linkPhrase(source)}.`);
  } else if (parentSession !== null) {
    lines.push(`It was spawned by Claude Code session ${parentSession}${linkPhrase(source)}, which has no node id yet.`);
  } else {
    lines.push('No parent session is recorded for it.');
  }
  return lines.join(' ');
}

function textOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The hook output for one SessionStart input, or null to add nothing. Never throws. */
export async function runSession({
  input,
  env,
  fetchImpl = globalThis.fetch,
  readText = (file) => readFile(file, 'utf8'),
  runTmux = defaultRunTmux,
  now = Date.now,
  ppid = process.ppid,
  hostname = os.hostname,
}) {
  if (!isCliSession(env)) return null;
  const sessionId = sessionIdOf(input);
  if (sessionId === null) return null;
  const log = (message) => writeLog(stateDir(env), LOG_FILE, message);
  try {
    const rawSource = typeof input.source === 'string' ? input.source.trim().slice(0, 32) : '';
    const source = rawSource === '' ? 'startup' : rawSource;
    const pids = candidatePids(env, ppid);
    const entry = await registryEntry(claudeHome(env), pids, sessionId, readText);
    const name = entry !== null && entry.name !== null ? entry.name : await nameFromProcesses(pids, readText);
    const tmux = entry !== null && entry.tmux !== null ? entry.tmux : await tmuxTarget(env, runTmux);
    const payload = {
      session: sessionId,
      parent: parentFrom(env, sessionId),
      cwd: textOrNull(input.cwd),
      name,
      tmux,
      host: hostname(),
      started_at: FRESH_SOURCES.includes(source) ? new Date(now()).toISOString() : null,
      source,
      transcript_path: textOrNull(input.transcript_path),
    };
    const res = await fetchImpl(`${daemonBaseUrl(env)}${START_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notes-capture': '1' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      await log(`start ${sessionId}: HTTP ${res.status} ${detail.slice(0, 200)}`);
      return null;
    }
    const reply = await res.json();
    if (reply === null || typeof reply !== 'object' || typeof reply.node_id !== 'string' || !NODE_ID.test(reply.node_id)) {
      await log(`start ${sessionId}: reply without a node id`);
      return null;
    }
    return { hookSpecificOutput: { hookEventName: HOOK_EVENT, additionalContext: buildContext(reply) } };
  } catch (err) {
    await log(`hook: ${errorText(err)}`);
    return null;
  }
}

async function main() {
  let output = null;
  try {
    const input = JSON.parse(await readStdin());
    output = await runSession({ input, env: process.env });
  } catch (err) {
    await writeLog(stateDir(process.env), LOG_FILE, `hook: ${errorText(err)}`);
  }
  if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exit(0);
}

if (isMainModule(import.meta.url)) void main();
```
**Impact:** new file; nothing imports it except the tests and `notes-spawn.mjs`.

### Step 2: SessionStart hook types
**File:** `claude/hooks/notes-session.d.mts` (new)
**Code:**
```ts
export type Env = Record<string, string | undefined>;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface SessionStartOutput {
  hookSpecificOutput: { hookEventName: 'SessionStart'; additionalContext: string };
}

export interface StartReply {
  session_id?: string;
  node_id: string;
  parent_session_id?: string | null;
  parent_node_id?: string | null;
  parent_link_source?: string | null;
  claimed?: boolean;
}

export const HOOK_EVENT: 'SessionStart';
export const START_PATH: string;
export const POST_TIMEOUT_MS: number;
export const TMUX_TIMEOUT_MS: number;
export const LOG_FILE: string;
export const PARENT_ENV: string;
export const FRESH_SOURCES: string[];
export const TMUX_TARGET_FORMAT: string;

export function isCliSession(env: Env): boolean;
export function sessionIdOf(input: unknown): string | null;
export function parentFrom(env: Env, sessionId: string): string | null;
export function claudeHome(env: Env): string;
export function candidatePids(env: Env, ppid: number | string | null | undefined): string[];
export function cleanName(value: unknown): string | null;
export function isClaudeWord(word: unknown): boolean;
export function nameFromArgv(argv: unknown): string | null;
export function registryEntry(
  home: string,
  pids: string[],
  sessionId: string,
  readText: (file: string) => Promise<string>,
): Promise<{ pid: string; name: string | null; tmux: string | null } | null>;
export function nameFromProcesses(pids: string[], readText: (file: string) => Promise<string>): Promise<string | null>;
export function tmuxTarget(env: Env, runTmux: (args: string[]) => Promise<string>): Promise<string | null>;
export function buildContext(reply: StartReply): string;
export function runSession(opts: {
  input: unknown;
  env: Env;
  fetchImpl?: FetchLike;
  readText?: (file: string) => Promise<string>;
  runTmux?: (args: string[]) => Promise<string>;
  now?: () => number;
  ppid?: number | string | null;
  hostname?: () => string;
}): Promise<SessionStartOutput | null>;
```

### Step 3: Bash spawn hook
**File:** `claude/hooks/notes-spawn.mjs` (new)
**Change:** record-only PreToolUse hook. The fast path (not Bash, or no `tmux` and `claude` words in
the command) does no I/O at all. It never writes to stdout.
**Code:**
```js
#!/usr/bin/env node
/**
 * notes-spawn: Claude Code PreToolUse hook on Bash for mcp-notes (the session graph).
 *
 * When this session's Bash command launches Claude Code in tmux by hand (tmux new-window /
 * split-window / new-session / respawn-* running `claude`, or send-keys typing `claude`), it records
 * a pending spawn {parent: this session, cwd, name, host} at notesd (POST /api/sessions/hook/spawn).
 * The child's SessionStart hook (notes-session) claims it within 30 s, which links child -> this
 * session as 'hook'.
 *
 * Skipped: anything that is not a Bash call; a command without both a `tmux` and a `claude` word
 * (no I/O at all); a command that goes through swarm.py or already passes CC_PARENT_SESSION (those
 * children carry an exact 'env' link); `claude -p/--print` and `claude --resume/--continue` (no new
 * interactive session to link); non-`cli` sessions.
 *
 * It never decides anything: it prints nothing, so Claude Code's normal permission flow runs, and
 * it always exits 0. Problems go to ${XDG_STATE_HOME:-~/.local/state}/notes-capture/spawn.log.
 * Node >= 22 built-ins only.
 */
import os from 'node:os';
import path from 'node:path';
import { daemonBaseUrl, errorText, isMainModule, readStdin, stateDir, writeLog } from './lib/state.mjs';
import { cleanName, isClaudeWord, isCliSession, sessionIdOf } from './notes-session.mjs';

export const TOOL_NAME = 'Bash';
export const SPAWN_PATH = '/api/sessions/hook/spawn';
export const POST_TIMEOUT_MS = 1500;
export const LOG_FILE = 'spawn.log';

const TMUX_WORD = /\btmux\b/;
const CLAUDE_WORD = /\bclaude\b/;
const LAUNCH_COMMANDS = new Set([
  'new-window', 'neww', 'split-window', 'splitw', 'new-session', 'new',
  'respawn-pane', 'respawnp', 'respawn-window', 'respawnw',
]);
const SEND_COMMANDS = new Set(['send-keys', 'send']);
/** tmux's own flags that take a value (`tmux -L sock new-window ...`). */
const TMUX_GLOBAL_ARG_LETTERS = 'LSfcT';
/** Flags taking a value across new-window, split-window, new-session and respawn-*. */
const LAUNCH_ARG_LETTERS = 'ceFflnpstxy';
const SEND_ARG_LETTERS = 'cNt';
const KEY_NAME = /^(Enter|C-m|C-j|KPEnter|Escape|Space|Tab|BSpace)$/;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const WRAPPERS = new Set(['exec', 'command', 'nohup', 'env', 'time']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SKIP = Symbol('skip');

/** Cheap pre-check, no I/O: both words present and not a swarm.py / CC_PARENT_SESSION launch. */
export function mayLaunchClaude(command) {
  if (typeof command !== 'string') return false;
  if (!TMUX_WORD.test(command) || !CLAUDE_WORD.test(command)) return false;
  return !command.includes('swarm.py') && !command.includes('CC_PARENT_SESSION');
}

/**
 * A small POSIX-shell tokenizer: words with quotes and backslashes removed, and operator tokens
 * for ; && || | & newline and bare ( ). `$( ... )` stays inside its word; `2>&1` stays a word.
 * Good enough to find commands; it is not a shell.
 */
export function shellTokens(text) {
  const tokens = [];
  let word = '';
  let inWord = false;
  let depth = 0;
  const push = () => {
    if (inWord) tokens.push({ word });
    word = '';
    inWord = false;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      if (i + 1 < text.length && text[i + 1] !== '\n') {
        word += text[i + 1];
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end === -1 ? text.length : end;
      word += text.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
      continue;
    }
    if (ch === '"') {
      inWord = true;
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1])) {
          if (text[i + 1] !== '\n') word += text[i + 1];
          i += 2;
          continue;
        }
        word += text[i];
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '$' && text[i + 1] === '(') {
      word += '$(';
      inWord = true;
      depth += 1;
      i += 2;
      continue;
    }
    if (ch === ')' && depth > 0) {
      word += ')';
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth > 0) {
      word += ch;
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      push();
      i += 1;
      continue;
    }
    if (ch === '#' && !inWord) {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '(' || ch === ')') {
      push();
      tokens.push({ op: ';' });
      i += 1;
      continue;
    }
    if (ch === '&' && (text[i - 1] === '>' || text[i - 1] === '<' || text[i + 1] === '>')) {
      word += ch;
      inWord = true;
      i += 1;
      continue;
    }
    if (ch === '&' || ch === '|') {
      push();
      const two = text.slice(i, i + 2);
      if (two === '&&' || two === '||') {
        tokens.push({ op: two });
        i += 2;
      } else {
        tokens.push({ op: ch });
        i += 1;
      }
      continue;
    }
    word += ch;
    inWord = true;
    i += 1;
  }
  push();
  return tokens;
}

/** The simple commands of a token list: arrays of words between operators, empty ones dropped. */
export function segmentsOf(tokens) {
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (token.op !== undefined) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push(token.word);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** getopt-style flag parsing: `-dP`, `-c dir`, `-cdir`, `--` ends options. */
export function parseFlags(words, argLetters) {
  const values = new Map();
  const flags = new Set();
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (word === '--') {
      i += 1;
      break;
    }
    if (!word.startsWith('-') || word === '-') break;
    let step = 1;
    for (let j = 1; j < word.length; j += 1) {
      const letter = word[j];
      if (argLetters.includes(letter)) {
        const attached = word.slice(j + 1);
        const value = attached !== '' ? attached : words[i + 1];
        if (attached === '') step = 2;
        if (typeof value === 'string') {
          const list = values.get(letter) ?? [];
          list.push(value);
          values.set(letter, list);
        }
        break;
      }
      flags.add(letter);
    }
    i += step;
  }
  return { values, flags, rest: words.slice(i) };
}

/** An absolute dir for a `-c` / `cd` value, relative to `base`; null when it depends on shell expansion. */
export function resolveDir(value, base, ctx) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v === '') return null;
  if (v === '.' || v === '$PWD' || v === '${PWD}' || v === '$(pwd)' || v === '`pwd`' || v.startsWith('#{')) return base;
  if (v === '~' || v === '$HOME' || v === '${HOME}') return ctx.home;
  if (v.startsWith('~/')) return path.join(ctx.home, v.slice(2));
  if (v.startsWith('$HOME/')) return path.join(ctx.home, v.slice('$HOME/'.length));
  if (v.startsWith('${HOME}/')) return path.join(ctx.home, v.slice('${HOME}/'.length));
  if (/[$`*?]/.test(v)) return null;
  return path.resolve(base, v);
}

function commandWords(words) {
  let i = 0;
  while (i < words.length && (ASSIGNMENT.test(words[i]) || WRAPPERS.has(words[i]))) i += 1;
  return words.slice(i);
}

function claudeArgs(args, cwd) {
  let name = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-p' || arg === '--print' || arg === '-r' || arg === '--resume' || arg === '-c' || arg === '--continue') return SKIP;
    if (arg.startsWith('--resume=')) return SKIP;
    if ((arg === '-n' || arg === '--name') && i + 1 < args.length) {
      name = cleanName(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--name=')) name = cleanName(arg.slice('--name='.length));
  }
  return { cwd, name };
}

/** {cwd, name} of the first interactive `claude` the shell text starts (following `cd`), SKIP, or null. */
export function claudeLaunchIn(text, cwd, ctx) {
  let dir = cwd;
  for (const words of segmentsOf(shellTokens(text))) {
    const argv = commandWords(words);
    if (argv.length === 0) continue;
    if (argv[0] === 'cd') {
      dir = resolveDir(argv[1] ?? '~', dir, ctx) ?? dir;
      continue;
    }
    if (isClaudeWord(argv[0])) return claudeArgs(argv.slice(1), dir);
    if (SHELLS.has(path.basename(argv[0]))) {
      const opts = parseFlags(argv.slice(1), '');
      if ((opts.flags.has('c')) && opts.rest.length > 0) {
        const inner = claudeLaunchIn(opts.rest[0], dir, ctx);
        if (inner !== null) return inner;
      }
    }
  }
  return null;
}

function launchFromArgv(rest, base, ctx) {
  if (rest.length === 0) return null;
  if (rest.length === 1) return claudeLaunchIn(rest[0], base, ctx);
  if (isClaudeWord(rest[0])) return claudeArgs(rest.slice(1), base);
  return claudeLaunchIn(rest.map((word) => `'${word.replace(/'/g, `'\\''`)}'`).join(' '), base, ctx);
}

/**
 * {cwd, name} when `command` launches an interactive Claude Code session in tmux by hand, else
 * null. `ctx` = {cwd: the hook's cwd (absolute), home}. A `-c` that needs shell expansion falls
 * back to the hook's cwd; a wrong guess only means the child's claim misses (no link), never a
 * wrong link.
 */
export function detectSpawn(command, ctx) {
  if (!mayLaunchClaude(command)) return null;
  let dir = ctx.cwd;
  for (const words of segmentsOf(shellTokens(command))) {
    const argv = commandWords(words);
    if (argv.length === 0) continue;
    if (argv[0] === 'cd') {
      dir = resolveDir(argv[1] ?? '~', dir, ctx) ?? dir;
      continue;
    }
    if (path.basename(argv[0]) !== 'tmux') continue;
    const global = parseFlags(argv.slice(1), TMUX_GLOBAL_ARG_LETTERS);
    const sub = global.rest[0];
    let found = null;
    if (LAUNCH_COMMANDS.has(sub)) {
      const opts = parseFlags(global.rest.slice(1), LAUNCH_ARG_LETTERS);
      if ((opts.values.get('e') ?? []).some((value) => value.startsWith('CC_PARENT_SESSION='))) return null;
      const cValues = opts.values.get('c') ?? [];
      const base = cValues.length > 0 ? (resolveDir(cValues[cValues.length - 1], dir, ctx) ?? dir) : dir;
      found = launchFromArgv(opts.rest, base, ctx);
    } else if (SEND_COMMANDS.has(sub)) {
      const opts = parseFlags(global.rest.slice(1), SEND_ARG_LETTERS);
      const typed = opts.rest.filter((key) => !KEY_NAME.test(key)).join(' ');
      found = claudeLaunchIn(typed, dir, ctx);
    }
    if (found === SKIP) return null;
    if (found !== null) return found;
  }
  return null;
}

/** Records a pending spawn for one PreToolUse input. Always resolves to null (no hook output). */
export async function runSpawn({ input, env, fetchImpl = globalThis.fetch, hostname = os.hostname }) {
  if (input === null || typeof input !== 'object' || input.tool_name !== TOOL_NAME) return null;
  const toolInput = input.tool_input;
  const command = toolInput !== null && typeof toolInput === 'object' ? toolInput.command : undefined;
  if (!mayLaunchClaude(command)) return null;
  if (!isCliSession(env)) return null;
  const parent = sessionIdOf(input);
  const cwd = typeof input.cwd === 'string' && path.isAbsolute(input.cwd) ? input.cwd : null;
  if (parent === null || cwd === null) return null;
  const log = (message) => writeLog(stateDir(env), LOG_FILE, message);
  try {
    const home = typeof env.HOME === 'string' && env.HOME !== '' ? env.HOME : os.homedir();
    const spawn = detectSpawn(command, { cwd, home });
    if (spawn === null) return null;
    const res = await fetchImpl(`${daemonBaseUrl(env)}${SPAWN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notes-capture': '1' },
      body: JSON.stringify({ parent, cwd: spawn.cwd, name: spawn.name, host: hostname() }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      await log(`spawn from ${parent}: HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
  } catch (err) {
    await log(`hook: ${errorText(err)}`);
  }
  return null;
}

async function main() {
  try {
    const input = JSON.parse(await readStdin());
    await runSpawn({ input, env: process.env });
  } catch (err) {
    await writeLog(stateDir(process.env), LOG_FILE, `hook: ${errorText(err)}`);
  }
  process.exit(0);
}

if (isMainModule(import.meta.url)) void main();
```
**Impact:** new file. Every Bash call in every session now starts a node process (~40 ms); the
in-process cost after start is two regex tests for commands without `tmux`+`claude`.

### Step 4: Bash spawn hook types
**File:** `claude/hooks/notes-spawn.d.mts` (new)
**Code:**
```ts
export type Env = Record<string, string | undefined>;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type ShellToken = { word: string; op?: undefined } | { op: string; word?: undefined };
export interface SpawnContext {
  cwd: string;
  home: string;
}
export interface DetectedSpawn {
  cwd: string;
  name: string | null;
}

export const TOOL_NAME: 'Bash';
export const SPAWN_PATH: string;
export const POST_TIMEOUT_MS: number;
export const LOG_FILE: string;

export function mayLaunchClaude(command: unknown): boolean;
export function shellTokens(text: string): ShellToken[];
export function segmentsOf(tokens: ShellToken[]): string[][];
export function parseFlags(
  words: string[],
  argLetters: string,
): { values: Map<string, string[]>; flags: Set<string>; rest: string[] };
export function resolveDir(value: unknown, base: string, ctx: SpawnContext): string | null;
export function claudeLaunchIn(text: string, cwd: string, ctx: SpawnContext): DetectedSpawn | symbol | null;
export function detectSpawn(command: unknown, ctx: SpawnContext): DetectedSpawn | null;
export function runSpawn(opts: {
  input: unknown;
  env: Env;
  fetchImpl?: FetchLike;
  hostname?: () => string;
}): Promise<null>;
```

### Step 5: Hook endpoints
**File:** `src/http/sessionHooks.ts` (new)
**Change:** two POST routes behind the existing `captureGuard` (loopback request URL, loopback or no
Origin, `X-Notes-Capture: 1`, JSON). All writes go through `SessionsRepo` (Invariant 3).
**Code:**
```ts
import os from 'node:os';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { SessionsRepo } from '../sessions/repo.js';
import { PENDING_SPAWN_WINDOW_MS } from '../sessions/types.js';
import { captureGuard } from './capture.js';

/** Phase 1's constant (brief: "within ~30s"), re-exported for the tests; never redefined here. */
export { PENDING_SPAWN_WINDOW_MS };
export const SESSION_HOOK_START_PATH = '/api/sessions/hook/start';
export const SESSION_HOOK_SPAWN_PATH = '/api/sessions/hook/spawn';
export const MAX_SESSION_HOOK_BODY_BYTES = 64 * 1024;
/** Pending spawns older than this are deleted when a new one is recorded (claimed or not). */
export const PENDING_SPAWN_RETAIN_MS = 24 * 60 * 60 * 1000;
/** Sources that begin a new session id and may set its parent. */
export const FRESH_START_SOURCES: ReadonlySet<string> = new Set(['startup', 'clear']);
/** Sources that may claim a pending spawn: only the first start of a process. */
export const CLAIMING_SOURCES: ReadonlySet<string> = new Set(['startup']);

const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z-]{7,99}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const sessionIdField = z.string().trim().regex(SESSION_ID, 'expected a Claude Code session id');

function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === undefined || value === null || value === '' ? null : value));
}

const startSchema = z.object({
  session: sessionIdField,
  parent: sessionIdField
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  cwd: optionalText(4096),
  name: optionalText(200),
  tmux: optionalText(200),
  host: optionalText(255),
  started_at: z
    .string()
    .regex(ISO_INSTANT, 'expected an ISO 8601 UTC or offset datetime')
    .refine((value) => !Number.isNaN(Date.parse(value)), 'not a valid datetime')
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  source: z
    .string()
    .trim()
    .max(32)
    .optional()
    .transform((value) => (value === undefined || value === '' ? 'startup' : value)),
  transcript_path: optionalText(4096),
});

const spawnSchema = z.object({
  parent: sessionIdField,
  cwd: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .refine((value) => value.startsWith('/'), 'cwd must be an absolute path'),
  name: optionalText(200),
  host: optionalText(255),
});

export interface SessionHookOptions {
  /** Host recorded when the hook sends none. Defaults to os.hostname(). */
  hostname?: () => string;
  /** Pending-spawn claim window. Defaults to PENDING_SPAWN_WINDOW_MS. */
  windowMs?: number;
  /** Clock for the prune cutoff. Defaults to Date.now. */
  now?: () => number;
}

export interface SessionHookStartReply {
  session_id: string;
  node_id: string;
  parent_session_id: string | null;
  parent_node_id: string | null;
  parent_link_source: string | null;
  /** True when this call linked the parent by claiming a pending spawn. */
  claimed: boolean;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'request'}: ${issue.message}`)
    .join('; ');
}

/**
 * The Claude Code session hooks (loopback + X-Notes-Capture only, like the capture route):
 *
 * POST /api/sessions/hook/start — notes-session (SessionStart). Upserts the session row (node id
 * assigned on first sight), then on a fresh start (`startup`, `clear`) links `parent` as 'env', or
 * (`startup` only, tmux and cwd known, no env/hook parent yet) claims a pending spawn as 'hook'.
 * `resume` / `compact` only refresh the row. 200 SessionHookStartReply.
 *
 * POST /api/sessions/hook/spawn — notes-spawn (Bash PreToolUse). Records a pending spawn
 * {parent, cwd, name, host}, then prunes spawns older than PENDING_SPAWN_RETAIN_MS (the only
 * scheduler cc_pending_spawns has: a cheap indexed delete on the write path). 201 {recorded: true}.
 *
 * 400 bad JSON / validation, 403 guard, 413 too large, 415 not JSON.
 */
export function sessionHookRoutes(deps: AppDeps, options: SessionHookOptions = {}): Hono {
  const r = new Hono();
  const repo = new SessionsRepo(deps.db);
  const hostname = options.hostname ?? os.hostname;
  const windowMs = options.windowMs ?? PENDING_SPAWN_WINDOW_MS;
  const now = options.now ?? Date.now;
  const limit = bodyLimit({
    maxSize: MAX_SESSION_HOOK_BODY_BYTES,
    onError: (c) => c.json({ error: 'too_large', max_bytes: MAX_SESSION_HOOK_BODY_BYTES }, 413),
  });

  r.post(SESSION_HOOK_START_PATH, captureGuard, limit, async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = startSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    const body = parsed.data;
    const host = body.host ?? hostname();

    const fresh = FRESH_START_SOURCES.has(body.source);
    const envParent = fresh && body.parent !== null && body.parent !== body.session ? body.parent : null;
    // Phase 1: ensures the child row (node id on first sight) and, with a parent, the parent's row
    // too, links it as 'env' (env > hook > heuristic), and never clobbers a non-null column with null.
    // transcript_path is not sent: ingest (phase 3) records it on its first read of the file.
    const started = await repo.upsertFromHook({
      sessionId: body.session,
      host,
      cwd: body.cwd,
      name: body.name,
      tmux: body.tmux,
      startedAt: body.started_at === null ? null : new Date(body.started_at),
      parentSessionId: envParent,
      parentSource: 'env',
    });

    let claimed = false;
    if (fresh && envParent === null && CLAIMING_SOURCES.has(body.source) && body.tmux !== null && body.cwd !== null) {
      const source = started.session.parentLinkSource;
      if (source !== 'env' && source !== 'hook') {
        // Phase 1: atomic (for update skip locked), at most once, and sets the parent as 'hook'
        // in the same transaction.
        const claim = await repo.claimPendingSpawn({
          childSessionId: body.session,
          host,
          cwd: body.cwd,
          name: body.name,
          windowMs,
        });
        claimed = claim !== null && claim.parentLink === 'set';
      }
    }

    const row = claimed ? await repo.getBySessionId(body.session) : started.session;
    if (row === null) return c.json({ error: 'not_stored' }, 500);
    const parentRow =
      row.parentSessionId === null
        ? null
        : started.parent !== null && started.parent.sessionId === row.parentSessionId
          ? started.parent
          : await repo.getBySessionId(row.parentSessionId);
    const reply: SessionHookStartReply = {
      session_id: row.sessionId,
      node_id: row.nodeId,
      parent_session_id: row.parentSessionId,
      parent_node_id: parentRow?.nodeId ?? null,
      parent_link_source: row.parentLinkSource ?? null,
      claimed,
    };
    return c.json(reply, 200);
  });

  r.post(SESSION_HOOK_SPAWN_PATH, captureGuard, limit, async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = spawnSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    const body = parsed.data;
    await repo.recordPendingSpawn({
      parentSessionId: body.parent,
      cwd: body.cwd,
      name: body.name,
      host: body.host ?? hostname(),
    });
    await repo.prunePendingSpawns(new Date(now() - PENDING_SPAWN_RETAIN_MS));
    return c.json({ recorded: true }, 201);
  });

  return r;
}
```
**Impact:** new routes only. Field names (`sessionId`, `nodeId`, `parentSessionId`,
`parentLinkSource`) are Phase 1's `SessionRow`.

### Step 6: Mount the routes
**File:** `src/http/app.ts:12` (imports), `:58-66` (doc comment), `:85` (mount)
**Change:** import, mount after `captureRoutes` and before `staticRoutes`. Phase 7 mounts
`sessionsApi` after this line (index edge 5 -> 7).
**Code (import, after line 12 `import { captureRoutes } from './capture.js';`):**
```ts
import { sessionHookRoutes } from './sessionHooks.js';
```
**Code (replaces the doc comment at lines 58-65):**
```ts
/**
 * The whole HTTP surface, mounted in this order (later phases fill the routers, never this file):
 * /health, /mcp, apiRoutes (P6), chatHistoryRoutes (chat history phase 7), imageRoutes (P5),
 * chatImageRoutes (pasted chat images), fileRoutes (note files), revealRoutes (iteration 7:
 * capabilities + reveal; note files add file and note reveal), captureRoutes (Claude Code `/n`
 * capture, loopback + X-Notes-Capture only), sessionHookRoutes (session graph: SessionStart and
 * Bash spawn hooks, same guard), staticRoutes (P6, last: it owns the SPA fallback; it reserves
 * /api, so the order is for clarity).
 */
```
**Code (mount, replaces lines 85-86):**
```ts
  app.route('/', captureRoutes(deps));
  app.route('/', sessionHookRoutes(deps));
  app.route('/', staticRoutes(deps));
```
**Impact:** `createApp` constructs one `SessionsRepo` (no I/O until a request).

### Step 7: Hook settings helper
**File:** `scripts/claude-hooks.mjs` (full replacement)
**Change:** five handlers in four events, PreToolUse with two groups, `ourGroups` returns arrays,
`ourHandlers` keyed by event + script, `retention` subcommand + `raiseCleanupPeriod`.
**Code:**
```js
#!/usr/bin/env node
/**
 * Adds, removes or reports the five mcp-notes Claude Code hooks in a settings.json (normally
 * ~/.claude/settings.json), leaving every other key and every other hook as it was, and raises
 * `cleanupPeriodDays` so Claude Code keeps the transcripts the session graph ingests.
 *
 *   node scripts/claude-hooks.mjs install   --settings FILE --node /abs/node --hooks-dir /abs/repo/claude/hooks [--paste-strategy updatedInput|deny]
 *   node scripts/claude-hooks.mjs uninstall --settings FILE
 *   node scripts/claude-hooks.mjs status    --settings FILE
 *   node scripts/claude-hooks.mjs retention --settings FILE [--min-days N]
 *
 * The hooks: Stop -> notes-capture.mjs (async), PreToolUse mcp__notes__(...) -> notes-paste.mjs,
 * PreToolUse Bash -> notes-spawn.mjs, UserPromptSubmit -> notes-prompt.mjs, SessionStart ->
 * notes-session.mjs. Our handlers are recognised by the script name in their command, so an entry
 * left by another checkout is replaced, never duplicated. install is idempotent: a second run leaves
 * the file byte-identical. `retention` sets cleanupPeriodDays to N (default 3650) when it is missing
 * or lower, and leaves a higher value alone; uninstall does not lower it again (that would let
 * Claude Code delete the history). Before the first change to an existing file a copy is kept at
 * FILE.bak-notes-hooks (once; never overwritten). Writes are atomic (temp file + rename) on the
 * symlink target, keeping the file's mode.
 */
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const OUR_SCRIPT = /notes-(?:capture|paste|prompt|session|spawn)\.mjs(?=['"\s]|$)/;
const OUR_SCRIPT_NAME = /notes-(capture|paste|prompt|session|spawn)\.mjs(?=['"\s]|$)/;
export const HOOK_SCRIPTS = ['notes-capture.mjs', 'notes-paste.mjs', 'notes-prompt.mjs', 'notes-session.mjs', 'notes-spawn.mjs'];
export const PASTE_MATCHER = 'mcp__notes__(similar_images|create_image|attach_image)';
export const SPAWN_MATCHER = 'Bash';
export const BACKUP_SUFFIX = '.bak-notes-hooks';
export const STOP_TIMEOUT_S = 60;
export const PASTE_TIMEOUT_S = 30;
export const PROMPT_TIMEOUT_S = 20;
export const SESSION_TIMEOUT_S = 10;
export const SPAWN_TIMEOUT_S = 5;
export const DEFAULT_RETENTION_DAYS = 3650;
export const PASTE_STRATEGIES = ['updatedInput', 'deny'];
/** What `status` reports, in order: [event, script without .mjs]. */
export const STATUS_ROWS = [
  ['Stop', 'notes-capture'],
  ['PreToolUse', 'notes-paste'],
  ['PreToolUse', 'notes-spawn'],
  ['UserPromptSubmit', 'notes-prompt'],
  ['SessionStart', 'notes-session'],
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** POSIX single-quoting: safe for any path. */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function hookCommand(nodeBin, script, env = {}) {
  const prefix = Object.entries(env)
    .map(([key, value]) => `${key}=${shQuote(value)} `)
    .join('');
  return `${prefix}${shQuote(nodeBin)} ${shQuote(script)}`;
}

export function isOurHandler(handler) {
  return isPlainObject(handler) && typeof handler.command === 'string' && OUR_SCRIPT.test(handler.command);
}

function stripOurs(groups) {
  const kept = [];
  let removed = 0;
  for (const group of groups) {
    if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const handlers = group.hooks.filter((handler) => !isOurHandler(handler));
    removed += group.hooks.length - handlers.length;
    if (handlers.length === group.hooks.length) kept.push(group);
    else if (handlers.length > 0) kept.push({ ...group, hooks: handlers });
  }
  return { groups: kept, removed };
}

/** The matcher groups this repo installs, per event, in the order they are appended. */
export function ourGroups({ nodeBin, hooksDir, pasteStrategy = 'updatedInput' }) {
  const pasteEnv = pasteStrategy === 'deny' ? { NOTES_PASTE_STRATEGY: 'deny' } : {};
  return {
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: hookCommand(nodeBin, path.join(hooksDir, 'notes-capture.mjs')),
            async: true,
            timeout: STOP_TIMEOUT_S,
          },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: PASTE_MATCHER,
        hooks: [
          {
            type: 'command',
            command: hookCommand(nodeBin, path.join(hooksDir, 'notes-paste.mjs'), pasteEnv),
            timeout: PASTE_TIMEOUT_S,
          },
        ],
      },
      {
        matcher: SPAWN_MATCHER,
        hooks: [
          {
            type: 'command',
            command: hookCommand(nodeBin, path.join(hooksDir, 'notes-spawn.mjs')),
            timeout: SPAWN_TIMEOUT_S,
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: 'command',
            command: hookCommand(nodeBin, path.join(hooksDir, 'notes-prompt.mjs')),
            timeout: PROMPT_TIMEOUT_S,
          },
        ],
      },
    ],
    SessionStart: [
      {
        hooks: [
          {
            type: 'command',
            command: hookCommand(nodeBin, path.join(hooksDir, 'notes-session.mjs')),
            timeout: SESSION_TIMEOUT_S,
          },
        ],
      },
    ],
  };
}

/** `settings` with our handlers removed from every event and our groups appended last. */
export function mergeHooks(settings, options) {
  const base = isPlainObject(settings) ? settings : {};
  const hooks = isPlainObject(base.hooks) ? { ...base.hooks } : {};
  for (const [event, groups] of Object.entries(ourGroups(options))) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...stripOurs(existing).groups, ...groups];
  }
  return { ...base, hooks };
}

/** `settings` without our handlers; events and `hooks` emptied by the removal are dropped. Same object when nothing is ours. */
export function removeHooks(settings) {
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) return settings;
  const hooks = { ...settings.hooks };
  let touched = false;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const { groups, removed } = stripOurs(hooks[event]);
    if (removed === 0) continue;
    touched = true;
    if (groups.length === 0) delete hooks[event];
    else hooks[event] = groups;
  }
  if (!touched) return settings;
  const out = { ...settings };
  if (Object.keys(hooks).length === 0) delete out.hooks;
  else out.hooks = hooks;
  return out;
}

/** `{"<event> <script>": command}` for each of our handlers present, e.g. `{"PreToolUse notes-spawn": "..."}`. */
export function ourHandlers(settings) {
  const found = {};
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) return found;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks) {
        if (!isOurHandler(handler)) continue;
        const match = OUR_SCRIPT_NAME.exec(handler.command);
        if (match !== null) found[`${event} notes-${match[1]}`] = handler.command;
      }
    }
  }
  return found;
}

/**
 * `settings` with cleanupPeriodDays raised to `minDays` when it is missing, not a number, or lower.
 * Same object when it already is at least `minDays`.
 */
export function raiseCleanupPeriod(settings, minDays) {
  const base = isPlainObject(settings) ? settings : {};
  const current = base.cleanupPeriodDays;
  if (typeof current === 'number' && Number.isFinite(current) && current >= minDays) return settings;
  return { ...base, cleanupPeriodDays: minDays };
}

export async function readSettings(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, text: null, value: {} };
    throw err;
  }
  if (text.trim() === '') return { exists: true, text, value: {} };
  const value = JSON.parse(text);
  if (!isPlainObject(value)) throw new Error(`${file} does not hold a JSON object`);
  return { exists: true, text, value };
}

export function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** 'unchanged' when `next` equals what is there; otherwise backs up once, writes atomically, 'written'. */
export async function writeSettings(file, current, next) {
  if (current.exists && JSON.stringify(current.value) === JSON.stringify(next)) return 'unchanged';
  const target = current.exists ? await realpath(file).catch(() => file) : file;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  let mode = 0o600;
  if (current.exists) {
    mode = (await stat(target)).mode & 0o777;
    const backup = `${file}${BACKUP_SUFFIX}`;
    if (!existsSync(backup)) await copyFile(target, backup);
  }
  const tmp = `${target}.tmp-notes-hooks-${process.pid}`;
  await writeFile(tmp, serialize(next), { mode });
  await rename(tmp, target);
  return 'written';
}

function fail(message) {
  process.stderr.write(`claude-hooks: ${message}\n`);
  process.exit(1);
}

async function main(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      settings: { type: 'string' },
      node: { type: 'string' },
      'hooks-dir': { type: 'string' },
      'paste-strategy': { type: 'string' },
      'min-days': { type: 'string' },
    },
  });
  const command = positionals[0];
  const file = values.settings;
  if (file === undefined || file === '') fail('--settings is required');
  let current;
  try {
    current = await readSettings(file);
  } catch (err) {
    fail(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (command === 'install') {
    const nodeBin = values.node;
    const hooksDir = values['hooks-dir'];
    const pasteStrategy = values['paste-strategy'] ?? 'updatedInput';
    if (nodeBin === undefined || !path.isAbsolute(nodeBin)) fail('--node must be an absolute path');
    if (hooksDir === undefined || !path.isAbsolute(hooksDir)) fail('--hooks-dir must be an absolute path');
    if (!PASTE_STRATEGIES.includes(pasteStrategy)) fail(`--paste-strategy must be one of ${PASTE_STRATEGIES.join(', ')}`);
    for (const script of HOOK_SCRIPTS) {
      if (!existsSync(path.join(hooksDir, script))) fail(`missing ${path.join(hooksDir, script)}`);
    }
    const result = await writeSettings(file, current, mergeHooks(current.value, { nodeBin, hooksDir, pasteStrategy }));
    process.stdout.write(`${result}: ${file}\n`);
    return;
  }
  if (command === 'uninstall') {
    if (!current.exists) {
      process.stdout.write(`unchanged: ${file} (absent)\n`);
      return;
    }
    const result = await writeSettings(file, current, removeHooks(current.value));
    process.stdout.write(`${result}: ${file}\n`);
    return;
  }
  if (command === 'status') {
    const found = ourHandlers(current.value);
    for (const [event, script] of STATUS_ROWS) {
      process.stdout.write(`${event} ${script}: ${found[`${event} ${script}`] ?? 'not registered'}\n`);
    }
    const days = current.value.cleanupPeriodDays;
    process.stdout.write(`cleanupPeriodDays: ${days === undefined ? 'unset (Claude Code default 30)' : JSON.stringify(days)}\n`);
    return;
  }
  if (command === 'retention') {
    const raw = values['min-days'] ?? String(DEFAULT_RETENTION_DAYS);
    if (!/^[1-9]\d{0,5}$/.test(raw)) fail('--min-days must be a positive integer');
    const minDays = Number(raw);
    const before = current.value.cleanupPeriodDays;
    const result = await writeSettings(file, current, raiseCleanupPeriod(current.value, minDays));
    const shown = before === undefined ? 'unset' : JSON.stringify(before);
    process.stdout.write(`${result}: ${file} (cleanupPeriodDays ${shown}${result === 'written' ? ` -> ${minDays}` : ''})\n`);
    return;
  }
  fail(
    'usage: claude-hooks.mjs install|uninstall|status|retention --settings FILE ' +
      '[--node ABS --hooks-dir ABS --paste-strategy updatedInput|deny] [--min-days N]',
  );
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
```
**Impact:** `ourGroups`/`ourHandlers` shapes change (only `tests/unit/scripts/claudeHooks.test.ts`
and this file use them; checked with `grep -rn "ourGroups\|ourHandlers" src tests scripts claude`).
Existing installs upgrade in place on the next `install.sh`: our old three handlers are stripped
and the five appended.

### Step 8: Helper types
**File:** `scripts/claude-hooks.d.mts` (full replacement)
**Code:**
```ts
export interface HookOptions {
  nodeBin: string;
  hooksDir: string;
  pasteStrategy?: 'updatedInput' | 'deny';
}
export interface SettingsFile {
  exists: boolean;
  text: string | null;
  value: Record<string, unknown>;
}
export type HookEvent = 'Stop' | 'PreToolUse' | 'UserPromptSubmit' | 'SessionStart';
export const OUR_SCRIPT: RegExp;
export const HOOK_SCRIPTS: string[];
export const PASTE_MATCHER: string;
export const SPAWN_MATCHER: string;
export const BACKUP_SUFFIX: string;
export const STOP_TIMEOUT_S: number;
export const PASTE_TIMEOUT_S: number;
export const PROMPT_TIMEOUT_S: number;
export const SESSION_TIMEOUT_S: number;
export const SPAWN_TIMEOUT_S: number;
export const DEFAULT_RETENTION_DAYS: number;
export const PASTE_STRATEGIES: string[];
export const STATUS_ROWS: [HookEvent, string][];
export function shQuote(value: string): string;
export function hookCommand(nodeBin: string, script: string, env?: Record<string, string>): string;
export function isOurHandler(handler: unknown): boolean;
export function ourGroups(options: HookOptions): Record<HookEvent, Record<string, unknown>[]>;
export function mergeHooks(settings: unknown, options: HookOptions): Record<string, unknown>;
export function removeHooks<T>(settings: T): T;
export function ourHandlers(settings: unknown): Record<string, string>;
export function raiseCleanupPeriod<T>(settings: T, minDays: number): T | (T & { cleanupPeriodDays: number });
export function readSettings(file: string): Promise<SettingsFile>;
export function serialize(value: unknown): string;
export function writeSettings(file: string, current: SettingsFile, next: unknown): Promise<'unchanged' | 'written'>;
```

### Step 9: install.sh registers five hooks and raises cleanupPeriodDays
**File:** `scripts/install.sh`

**9a. Header, lines 2-24 replaced by** (the `set -euo pipefail` line follows directly; the header
now ends at line 30):
```bash
# Install or refresh notesd as a systemd user service, register it with Claude Code as the
# `notes` MCP server (user scope), link the /n skill into ~/.claude/skills/n, and register the
# five mcp-notes Claude Code hooks in ~/.claude/settings.json: notes-capture (Stop, saves /n
# exchanges to the chat history), notes-paste (PreToolUse on similar_images, uploads a pasted
# image), notes-prompt (UserPromptSubmit on /n prompts, stores the session's pasted images and
# names their ids), notes-session (SessionStart, reports the session to the session graph and
# tells it its node id) and notes-spawn (PreToolUse on Bash, records a hand-rolled tmux `claude`
# launch so the child links to its parent). It also raises Claude Code's cleanupPeriodDays so
# the transcripts the session graph ingests are not deleted after 30 days.
#
# Idempotent: run it again after every pull. The unit runs code from the checkout this script
# lives in, so run it from the checkout you want the daemon to use (normally ~/mcp-notes).
#
# Flags:
#   --skip-hooks    do not touch ~/.claude/settings.json (same as NOTES_SKIP_HOOKS=1)
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
#   NOTES_CLAUDE_RETENTION_DAYS  minimum cleanupPeriodDays (default 3650, ten years); a higher
#                   value already in settings.json is kept
```

**9b. `parse_args` help range (old line 62, `sed -n '2,26p'`)** becomes:
```bash
        sed -n '2,30p' "${BASH_SOURCE[0]}"
```
(Implementer: confirm the header's last comment line is line 30 after 9a; adjust the number if not.)

**9c. Config block (old lines 46-50), add one line after `PASTE_STRATEGY=...`:**
```bash
HOOKS_DIR="$REPO_DIR/claude/hooks"
HOOKS_HELPER="$REPO_DIR/scripts/claude-hooks.mjs"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
SKIP_HOOKS="${NOTES_SKIP_HOOKS:-0}"
PASTE_STRATEGY="${NOTES_PASTE_STRATEGY:-updatedInput}"
RETENTION_DAYS="${NOTES_CLAUDE_RETENTION_DAYS:-3650}"
```

**9d. `check_preconditions` hook list (old lines 111-114) replaced by:**
```bash
  local hk
  for hk in "$HOOKS_DIR/notes-capture.mjs" "$HOOKS_DIR/notes-paste.mjs" "$HOOKS_DIR/notes-prompt.mjs" \
            "$HOOKS_DIR/notes-session.mjs" "$HOOKS_DIR/notes-spawn.mjs" "$HOOKS_HELPER"; do
    [[ -f "$hk" ]] || die "missing $hk."
  done
```

**9e. `register_hooks` (old lines 249-264) replaced by, followed by the new `raise_retention`:**
```bash
# Merge the five hook entries into ~/.claude/settings.json (user scope: every repo). Everything
# else in the file is kept; a copy of the original is kept once at settings.json.bak-notes-hooks.
# A failure here warns and leaves the file alone: the daemon install is not undone for it.
register_hooks() {
  if [[ "$SKIP_HOOKS" == 1 ]]; then
    log "skipping Claude Code hooks (--skip-hooks / NOTES_SKIP_HOOKS=1)"
    return 0
  fi
  log "registering the five Claude Code hooks (notes-capture, notes-paste, notes-prompt, notes-session, notes-spawn) in $CLAUDE_SETTINGS"
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
```

**9f. `main` (old lines 331-348) replaced by:**
```bash
main() {
  parse_args "$@"
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
  register_hooks
  raise_retention
  verify
}
```
`verify` needs no change: it already pipes `claude-hooks.mjs status` (now five hook lines plus
`cleanupPeriodDays`) through `sed 's/^/claude hook: /'`.
**Impact:** existing installs gain the two hooks and `cleanupPeriodDays: 3650` on the next run.

### Step 10: uninstall.sh
**File:** `scripts/uninstall.sh`

**10a. Header, lines 2-7 replaced by:**
```bash
# Undo scripts/install.sh on the WSL side: stop and remove the notesd user unit, unregister the
# `notes` MCP server (user scope), remove the /n skill symlink, and remove the five hook entries
# (notes-capture, notes-paste, notes-prompt, notes-session, notes-spawn) from
# ~/.claude/settings.json (every other setting and hook is kept). Keeps the data dir
# (~/mcp-notes-data), linger, the hooks' outbox, pasted-image memos and logs
# (~/.local/state/notes-capture), settings.json.bak-notes-hooks, and the raised cleanupPeriodDays
# (lowering it would let Claude Code delete the transcript history; edit it by hand if you mean
# it). The Windows keepalive task is removed by scripts/windows/install-wsl-keepalive.ps1 -Uninstall.
```

**10b. `unregister_hooks` (old lines 408-422) replaced by:**
```bash
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
```

### Step 11: SessionStart hook unit tests
**File:** `tests/unit/hooks/notesSession.test.ts` (new)
**Code:**
```ts
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildContext,
  candidatePids,
  nameFromArgv,
  parentFrom,
  runSession,
  tmuxTarget,
  type FetchLike,
} from '../../../claude/hooks/notes-session.mjs';

const SID = '0ef363d6-0bdd-4a15-aff7-71f0821bd6ee';
const PARENT = 'cc6491fc-1111-4222-8333-944444444444';
const NOW = Date.parse('2026-11-02T03:00:00.000Z');

let tmp: string;
let env: Record<string, string>;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'notes-session-'));
  env = {
    HOME: tmp,
    XDG_STATE_HOME: path.join(tmp, 'state'),
    NOTESD_PORT: '7499',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_PID: '4242',
  };
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface Call {
  url: string;
  header: string | null;
  body: Record<string, unknown>;
}

function fakeFetch(response: () => Response): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, header: new Headers(init.headers).get('x-notes-capture'), body: JSON.parse(String(init.body)) });
    return response();
  };
  return { fetchImpl, calls };
}

const reply = (extra: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ session_id: SID, node_id: 'A0-3G', parent_session_id: null, parent_node_id: null, parent_link_source: null, claimed: false, ...extra }), { status: 200 });

function files(map: Record<string, string>): (file: string) => Promise<string> {
  return async (file) => {
    const text = map[file];
    if (text === undefined) throw Object.assign(new Error(`ENOENT ${file}`), { code: 'ENOENT' });
    return text;
  };
}

const noTmux = async (): Promise<string> => {
  throw new Error('no tmux');
};

function input(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: SID, transcript_path: '/t/s.jsonl', cwd: '/work/repo', hook_event_name: 'SessionStart', source: 'startup', ...extra };
}

describe('runSession', () => {
  it('posts the start with the registry name/tmux and the env parent, and returns the node ids as context', async () => {
    const { fetchImpl, calls } = fakeFetch(() => reply({ parent_session_id: PARENT, parent_node_id: 'B1-2C', parent_link_source: 'env' }));
    const readText = files({
      [path.join(tmp, '.claude', 'sessions', '4242.json')]: JSON.stringify({ sessionId: SID, name: 'impl-x-p5', tmux: 'iter1:@12.%34' }),
    });
    const out = await runSession({
      input: input(),
      env: { ...env, CC_PARENT_SESSION: PARENT },
      fetchImpl,
      readText,
      runTmux: noTmux,
      now: () => NOW,
      ppid: 1,
      hostname: () => 'lenovo',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:7499/api/sessions/hook/start');
    expect(calls[0]!.header).toBe('1');
    expect(calls[0]!.body).toEqual({
      session: SID,
      parent: PARENT,
      cwd: '/work/repo',
      name: 'impl-x-p5',
      tmux: 'iter1:@12.%34',
      host: 'lenovo',
      started_at: '2026-11-02T03:00:00.000Z',
      source: 'startup',
      transcript_path: '/t/s.jsonl',
    });
    expect(out?.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out?.hookSpecificOutput.additionalContext).toContain('node A0-3G');
    expect(out?.hookSpecificOutput.additionalContext).toContain('spawned by node B1-2C');
  });

  it('falls back to the claude argv for the name and tmux display-message for the pane', async () => {
    const { fetchImpl, calls } = fakeFetch(() => reply());
    const readText = files({ '/proc/4242/cmdline': ['/usr/bin/claude', '-n', 'scratch', 'hello'].join('\0') });
    const seen: string[][] = [];
    await runSession({
      input: input(),
      env: { ...env, TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%9' },
      fetchImpl,
      readText,
      runTmux: async (args) => {
        seen.push(args);
        return 'main:@3.%9\n';
      },
      now: () => NOW,
      ppid: 1,
      hostname: () => 'lenovo',
    });
    expect(calls[0]!.body.name).toBe('scratch');
    expect(calls[0]!.body.tmux).toBe('main:@3.%9');
    expect(seen).toEqual([['display-message', '-p', '-t', '%9', '#{session_name}:#{window_id}.#{pane_id}']]);
  });

  it('keeps the bare pane id when tmux cannot answer, and sends null tmux outside tmux', async () => {
    expect(await tmuxTarget({ TMUX: 'x', TMUX_PANE: '%7' }, noTmux)).toBe('%7');
    expect(await tmuxTarget({ TMUX_PANE: '%7' }, noTmux)).toBeNull();
    expect(await tmuxTarget({ TMUX: 'x', TMUX_PANE: 'bogus' }, noTmux)).toBeNull();
  });

  it('resume and compact send no started_at but still return the context', async () => {
    for (const source of ['resume', 'compact']) {
      const { fetchImpl, calls } = fakeFetch(() => reply());
      const out = await runSession({ input: input({ source }), env, fetchImpl, readText: files({}), runTmux: noTmux, now: () => NOW, ppid: 1, hostname: () => 'h' });
      expect(calls[0]!.body.started_at).toBeNull();
      expect(calls[0]!.body.source).toBe(source);
      expect(out?.hookSpecificOutput.additionalContext).toContain('A0-3G');
    }
  });

  it('does nothing at all for a non-cli session', async () => {
    const { fetchImpl, calls } = fakeFetch(() => reply());
    const out = await runSession({ input: input(), env: { ...env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }, fetchImpl, readText: files({}), runTmux: noTmux });
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(tmp, 'state'))).toBe(false);
  });

  it('daemon down, an error status or a reply without a node id: no output, one log line', async () => {
    const down: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await runSession({ input: input(), env, fetchImpl: down, readText: files({}), runTmux: noTmux, ppid: 1 })).toBeNull();
    const bad = fakeFetch(() => new Response('nope', { status: 500 }));
    expect(await runSession({ input: input(), env, fetchImpl: bad.fetchImpl, readText: files({}), runTmux: noTmux, ppid: 1 })).toBeNull();
    const empty = fakeFetch(() => new Response(JSON.stringify({ node_id: 'not-an-id' }), { status: 200 }));
    expect(await runSession({ input: input(), env, fetchImpl: empty.fetchImpl, readText: files({}), runTmux: noTmux, ppid: 1 })).toBeNull();
    const log = await readFile(path.join(tmp, 'state', 'notes-capture', 'session.log'), 'utf8');
    expect(log.trim().split('\n')).toHaveLength(3);
  });

  it('ignores an input without a valid session id', async () => {
    const { fetchImpl, calls } = fakeFetch(() => reply());
    expect(await runSession({ input: { session_id: '' }, env, fetchImpl })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('helpers', () => {
  it('parentFrom drops a blank, malformed or self parent', () => {
    expect(parentFrom({ CC_PARENT_SESSION: ` ${PARENT}\n` }, SID)).toBe(PARENT);
    expect(parentFrom({ CC_PARENT_SESSION: SID }, SID)).toBeNull();
    expect(parentFrom({ CC_PARENT_SESSION: '  ' }, SID)).toBeNull();
    expect(parentFrom({ CC_PARENT_SESSION: 'x y' }, SID)).toBeNull();
    expect(parentFrom({}, SID)).toBeNull();
  });

  it('candidatePids takes CLAUDE_PID then ppid, distinct and numeric', () => {
    expect(candidatePids({ CLAUDE_PID: '42' }, 7)).toEqual(['42', '7']);
    expect(candidatePids({ CLAUDE_PID: '42' }, 42)).toEqual(['42']);
    expect(candidatePids({ CLAUDE_PID: 'abc' }, undefined)).toEqual([]);
  });

  it('nameFromArgv reads -n, --name and --name= of a claude argv only', () => {
    expect(nameFromArgv(['claude', '-n', 'a'])).toBe('a');
    expect(nameFromArgv(['/x/claude.exe', '--name', 'b c'])).toBe('b c');
    expect(nameFromArgv(['node', '/x/@anthropic-ai/claude-code/cli.js', '--name=z'])).toBe('z');
    expect(nameFromArgv(['vim', '-n', 'a'])).toBeNull();
    expect(nameFromArgv(['claude'])).toBeNull();
  });

  it('buildContext names the parent session when it has no node id yet, and says when there is none', () => {
    expect(buildContext({ node_id: 'A0-3G', parent_session_id: PARENT, parent_node_id: null, parent_link_source: 'env' })).toContain(
      `spawned by Claude Code session ${PARENT}`,
    );
    expect(buildContext({ node_id: 'A0-3G' })).toContain('No parent session is recorded');
  });
});
```

### Step 12: Bash spawn hook unit tests
**File:** `tests/unit/hooks/notesSpawn.test.ts` (new)
**Code:**
```ts
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectSpawn, mayLaunchClaude, runSpawn, shellTokens, type FetchLike } from '../../../claude/hooks/notes-spawn.mjs';

const SID = '0ef363d6-0bdd-4a15-aff7-71f0821bd6ee';
const CTX = { cwd: '/home/u/mcp-notes', home: '/home/u' };

describe('detectSpawn', () => {
  const cases: [string, { cwd: string; name: string | null } | null][] = [
    [`tmux new-window -n foo -c /work/repo "claude -n foo 'do it'"`, { cwd: '/work/repo', name: 'foo' }],
    [`tmux split-window -h -c "#{pane_current_path}" claude`, { cwd: '/home/u/mcp-notes', name: null }],
    [`tmux send-keys -t main:1 'cd ~/x && claude --name bar' Enter`, { cwd: '/home/u/x', name: 'bar' }],
    [`tmux new-window -dP -F '#{pane_id}' -c ../sib 'exec claude'`, { cwd: '/home/u/sib', name: null }],
    [`tmux new-window bash -lc 'claude -n z'`, { cwd: '/home/u/mcp-notes', name: 'z' }],
    [`cd /a && tmux new-window -c sub claude`, { cwd: '/a/sub', name: null }],
    [`tmux new-window -c "$HOME/p" "FOO=1 claude --name=q"`, { cwd: '/home/u/p', name: 'q' }],
    [`tmux -L other new-session -d -s s -c /srv claude`, { cwd: '/srv', name: null }],
    [`python3 ~/.claude/skills/swarm/swarm.py spawn --name x && tmux new-window claude`, null],
    [`tmux new-window -e CC_PARENT_SESSION=abc claude`, null],
    [`tmux new-window "claude --resume abc"`, null],
    [`tmux new-window "claude -c"`, null],
    [`tmux new-window "claude -p hi"`, null],
    [`tmux list-windows | grep claude`, null],
    [`echo "tmux new-window claude"`, null],
    [`tmux new-window vim`, null],
    [`ls -la`, null],
  ];
  for (const [command, expected] of cases) {
    it(command, () => {
      expect(detectSpawn(command, CTX)).toEqual(expected);
    });
  }
});

describe('shellTokens / mayLaunchClaude', () => {
  it('splits on operators but keeps quotes, $( ) and 2>&1 inside words', () => {
    const words = shellTokens(`a "b c" 'd' $(pwd) 2>&1 && e; f | g`).map((t) => t.word ?? t.op);
    expect(words).toEqual(['a', 'b c', 'd', '$(pwd)', '2>&1', '&&', 'e', ';', 'f', '|', 'g']);
  });

  it('is a cheap word test that excludes swarm.py and CC_PARENT_SESSION', () => {
    expect(mayLaunchClaude('git status')).toBe(false);
    expect(mayLaunchClaude('tmux ls')).toBe(false);
    expect(mayLaunchClaude('tmux new-window claude')).toBe(true);
    expect(mayLaunchClaude('swarm.py launch tmux claude')).toBe(false);
    expect(mayLaunchClaude(42)).toBe(false);
  });
});

describe('runSpawn', () => {
  let tmp: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'notes-spawn-'));
    env = { HOME: tmp, XDG_STATE_HOME: path.join(tmp, 'state'), NOTESD_PORT: '7499', CLAUDE_CODE_ENTRYPOINT: 'cli' };
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function fake(response: () => Response): { fetchImpl: FetchLike; calls: { url: string; header: string | null; body: unknown }[] } {
    const calls: { url: string; header: string | null; body: unknown }[] = [];
    return {
      calls,
      fetchImpl: async (url, init) => {
        calls.push({ url, header: new Headers(init.headers).get('x-notes-capture'), body: JSON.parse(String(init.body)) });
        return response();
      },
    };
  }

  const bash = (command: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    session_id: SID,
    cwd: '/work/repo',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    ...extra,
  });

  it('records a pending spawn and returns null (no decision)', async () => {
    const { fetchImpl, calls } = fake(() => new Response(JSON.stringify({ recorded: true }), { status: 201 }));
    const out = await runSpawn({ input: bash(`tmux new-window -c /work/repo "claude -n kid"`), env, fetchImpl, hostname: () => 'lenovo' });
    expect(out).toBeNull();
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:7499/api/sessions/hook/spawn',
        header: '1',
        body: { parent: SID, cwd: '/work/repo', name: 'kid', host: 'lenovo' },
      },
    ]);
  });

  it('does no I/O for other tools, ordinary commands, swarm launches and non-cli sessions', async () => {
    const { fetchImpl, calls } = fake(() => new Response('{}', { status: 201 }));
    await runSpawn({ input: { ...bash('tmux new-window claude'), tool_name: 'Read' }, env, fetchImpl });
    await runSpawn({ input: bash('npm test'), env, fetchImpl });
    await runSpawn({ input: bash('python3 swarm.py spawn --name x'), env, fetchImpl });
    await runSpawn({ input: bash('tmux new-window claude'), env: { ...env, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, fetchImpl });
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(tmp, 'state'))).toBe(false);
  });

  it('logs and still returns null when the daemon is down', async () => {
    const down: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await runSpawn({ input: bash('tmux new-window claude'), env, fetchImpl: down })).toBeNull();
    expect(await readFile(path.join(tmp, 'state', 'notes-capture', 'spawn.log'), 'utf8')).toMatch(/fetch failed/);
  });
});
```

### Step 13: claude-hooks tests
**File:** `tests/unit/scripts/claudeHooks.test.ts` (full replacement)
**Code:**
```ts
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookCommand, mergeHooks, ourGroups, ourHandlers, raiseCleanupPeriod, removeHooks, shQuote } from '../../../scripts/claude-hooks.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HELPER = path.join(REPO, 'scripts', 'claude-hooks.mjs');
const HOOKS_DIR = path.join(REPO, 'claude', 'hooks');
const NODE = process.execPath;

const EXISTING = {
  model: 'opus',
  env: { CLAUDE_CODE_PLUGIN_DIRS: '/home/u/mods' },
  enabledPlugins: { 'superpowers@market': true },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/home/u/guard.sh' }] }],
  },
};

const EVENTS = ['Stop', 'PreToolUse', 'UserPromptSubmit', 'SessionStart'];

let home: string;
let settings: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'notes-hooks-home-'));
  settings = path.join(home, '.claude', 'settings.json');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeSettings(value: unknown): Promise<string> {
  await mkdir(path.dirname(settings), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(settings, text, { mode: 0o644 });
  return text;
}

function cli(...args: string[]): string {
  return execFileSync(NODE, [HELPER, ...args], { encoding: 'utf8' });
}

function sourced(script: 'install.sh' | 'uninstall.sh', body: string, extraEnv: Record<string, string> = {}): void {
  execFileSync('bash', ['-c', `source "$1"; ${body}`, '_', path.join(REPO, 'scripts', script)], {
    env: { ...process.env, HOME: home, NODE_BIN: NODE, ...extraEnv },
    encoding: 'utf8',
  });
}

describe('mergeHooks / removeHooks', () => {
  const opts = { nodeBin: '/opt/node/bin/node', hooksDir: '/home/u/mcp-notes/claude/hooks' };
  const cmd = (script: string): string => `'/opt/node/bin/node' '/home/u/mcp-notes/claude/hooks/${script}'`;

  it('adds our five handlers in four events and keeps everything else', () => {
    const merged = mergeHooks(EXISTING, opts) as typeof EXISTING & { hooks: Record<string, unknown[]> };
    expect(merged.env).toEqual(EXISTING.env);
    expect(merged.enabledPlugins).toEqual(EXISTING.enabledPlugins);
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(merged.hooks.Stop![0]).toEqual(EXISTING.hooks.Stop[0]);
    expect(merged.hooks.Stop![1]).toEqual({
      hooks: [{ type: 'command', command: cmd('notes-capture.mjs'), async: true, timeout: 60 }],
    });
    expect(merged.hooks.PreToolUse).toEqual([
      EXISTING.hooks.PreToolUse[0],
      {
        matcher: 'mcp__notes__(similar_images|create_image|attach_image)',
        hooks: [{ type: 'command', command: cmd('notes-paste.mjs'), timeout: 30 }],
      },
      { matcher: 'Bash', hooks: [{ type: 'command', command: cmd('notes-spawn.mjs'), timeout: 5 }] },
    ]);
    expect(merged.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: cmd('notes-prompt.mjs'), timeout: 20 }] }]);
    expect(merged.hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command: cmd('notes-session.mjs'), timeout: 10 }] }]);
    expect(Object.keys(ourGroups(opts))).toEqual(EVENTS);
  });

  it('upgrades a three-hook install in place and keeps user hooks of the same events', () => {
    const userPrompt = { hooks: [{ type: 'command', command: '/home/u/prompt-guard.sh' }] };
    const userStart = { hooks: [{ type: 'command', command: '/home/u/hello.sh' }] };
    const threeHookInstall = {
      ...EXISTING,
      hooks: {
        Stop: [...EXISTING.hooks.Stop, { hooks: [{ type: 'command', command: "'/old/node' '/old/claude/hooks/notes-capture.mjs'", async: true, timeout: 60 }] }],
        PreToolUse: [
          ...EXISTING.hooks.PreToolUse,
          { matcher: 'mcp__notes__(similar_images|create_image|attach_image)', hooks: [{ type: 'command', command: "'/old/node' '/old/claude/hooks/notes-paste.mjs'", timeout: 30 }] },
        ],
        UserPromptSubmit: [userPrompt, { hooks: [{ type: 'command', command: "'/old/node' '/old/claude/hooks/notes-prompt.mjs'", timeout: 20 }] }],
        SessionStart: [userStart],
      },
    };
    const merged = mergeHooks(threeHookInstall, opts) as { hooks: Record<string, unknown[]> };
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(merged.hooks.PreToolUse).toHaveLength(3);
    expect(merged.hooks.UserPromptSubmit).toHaveLength(2);
    expect(merged.hooks.UserPromptSubmit![0]).toEqual(userPrompt);
    expect(merged.hooks.SessionStart).toHaveLength(2);
    expect(merged.hooks.SessionStart![0]).toEqual(userStart);
    expect(JSON.stringify(merged)).not.toContain('/old/');
    expect(mergeHooks(merged, opts)).toEqual(merged);
    const removed = removeHooks(merged) as { hooks: Record<string, unknown[]> };
    expect(removed.hooks.UserPromptSubmit).toEqual([userPrompt]);
    expect(removed.hooks.SessionStart).toEqual([userStart]);
    expect(removed.hooks.PreToolUse).toEqual(EXISTING.hooks.PreToolUse);
    expect(removed.hooks.Stop).toEqual(EXISTING.hooks.Stop);
  });

  it('is idempotent and replaces an entry left by another checkout', () => {
    const once = mergeHooks(EXISTING, { nodeBin: '/old/node', hooksDir: '/old/checkout/claude/hooks' });
    const twice = mergeHooks(once, opts);
    expect(mergeHooks(twice, opts)).toEqual(twice);
    expect(JSON.stringify(twice)).not.toContain('/old/checkout');
    expect((twice as typeof EXISTING).hooks.Stop).toHaveLength(2);
    expect((twice as typeof EXISTING).hooks.PreToolUse).toHaveLength(3);
  });

  it('works without a hooks key and removeHooks restores the original exactly', () => {
    const plain = { model: 'opus', env: { A: '1' } };
    const merged = mergeHooks(plain, opts);
    expect(Object.keys(merged)).toEqual(['model', 'env', 'hooks']);
    expect(removeHooks(merged)).toEqual(plain);
    expect(removeHooks(mergeHooks(EXISTING, opts))).toEqual(EXISTING);
    expect(removeHooks(EXISTING)).toBe(EXISTING);
  });

  it('the deny strategy bakes the env prefix into the paste command only', () => {
    const merged = mergeHooks({}, { ...opts, pasteStrategy: 'deny' }) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(merged.hooks.PreToolUse![0]!.hooks[0]!.command.startsWith("NOTES_PASTE_STRATEGY='deny' ")).toBe(true);
    expect(merged.hooks.PreToolUse![1]!.hooks[0]!.command.startsWith("'/opt/node")).toBe(true);
    expect(merged.hooks.Stop![0]!.hooks[0]!.command.startsWith("'/opt/node")).toBe(true);
  });

  it('ourHandlers keys each handler by event and script', () => {
    expect(Object.keys(ourHandlers(mergeHooks(EXISTING, opts))).sort()).toEqual([
      'PreToolUse notes-paste',
      'PreToolUse notes-spawn',
      'SessionStart notes-session',
      'Stop notes-capture',
      'UserPromptSubmit notes-prompt',
    ]);
  });

  it('quotes paths with single quotes safely', () => {
    expect(shQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
    expect(hookCommand('/n', '/x y/notes-capture.mjs')).toBe(`'/n' '/x y/notes-capture.mjs'`);
  });
});

describe('raiseCleanupPeriod', () => {
  it('sets a missing, lower or non-number value and keeps a higher one (same object)', () => {
    expect(raiseCleanupPeriod({ model: 'opus' }, 3650)).toEqual({ model: 'opus', cleanupPeriodDays: 3650 });
    expect(raiseCleanupPeriod({ cleanupPeriodDays: 30 }, 3650)).toEqual({ cleanupPeriodDays: 3650 });
    expect(raiseCleanupPeriod({ cleanupPeriodDays: 0 }, 3650)).toEqual({ cleanupPeriodDays: 3650 });
    expect(raiseCleanupPeriod({ cleanupPeriodDays: '99' }, 3650)).toEqual({ cleanupPeriodDays: 3650 });
    const high = { cleanupPeriodDays: 9999 };
    expect(raiseCleanupPeriod(high, 3650)).toBe(high);
  });
});

describe('scripts/claude-hooks.mjs against a temp HOME', () => {
  it('creates the file (0600) when there is none, without a backup', async () => {
    cli('install', '--settings', settings, '--node', NODE, '--hooks-dir', HOOKS_DIR);
    const value = JSON.parse(await readFile(settings, 'utf8'));
    expect(Object.keys(value.hooks)).toEqual(EVENTS);
    expect((await stat(settings)).mode & 0o777).toBe(0o600);
    expect(existsSync(`${settings}.bak-notes-hooks`)).toBe(false);
  });

  it('second run leaves the file byte-identical; backup kept once with the original', async () => {
    const original = await writeSettings(EXISTING);
    cli('install', '--settings', settings, '--node', NODE, '--hooks-dir', HOOKS_DIR);
    const first = await readFile(settings, 'utf8');
    expect(cli('install', '--settings', settings, '--node', NODE, '--hooks-dir', HOOKS_DIR)).toMatch(/^unchanged/);
    expect(await readFile(settings, 'utf8')).toBe(first);
    expect(await readFile(`${settings}.bak-notes-hooks`, 'utf8')).toBe(original);
    expect((await stat(settings)).mode & 0o777).toBe(0o644);
    cli('uninstall', '--settings', settings);
    expect(await readFile(settings, 'utf8')).toBe(original);
    expect(await readFile(`${settings}.bak-notes-hooks`, 'utf8')).toBe(original);
  });

  it('refuses invalid JSON and leaves the file alone', async () => {
    await mkdir(path.dirname(settings), { recursive: true });
    await writeFile(settings, '{ not json');
    const run = spawnSync(NODE, [HELPER, 'install', '--settings', settings, '--node', NODE, '--hooks-dir', HOOKS_DIR], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/cannot read/);
    expect(await readFile(settings, 'utf8')).toBe('{ not json');
  });

  it('status reports all five hooks and cleanupPeriodDays', async () => {
    cli('install', '--settings', settings, '--node', NODE, '--hooks-dir', HOOKS_DIR);
    const out = cli('status', '--settings', settings);
    expect(out).toMatch(/Stop notes-capture: .*notes-capture\.mjs/);
    expect(out).toMatch(/PreToolUse notes-paste: .*notes-paste\.mjs/);
    expect(out).toMatch(/PreToolUse notes-spawn: .*notes-spawn\.mjs/);
    expect(out).toMatch(/UserPromptSubmit notes-prompt: .*notes-prompt\.mjs/);
    expect(out).toMatch(/SessionStart notes-session: .*notes-session\.mjs/);
    expect(out).toMatch(/cleanupPeriodDays: unset/);
    cli('uninstall', '--settings', settings);
    const after = cli('status', '--settings', settings);
    expect(after).toMatch(/SessionStart notes-session: not registered/);
    expect(after).toMatch(/PreToolUse notes-spawn: not registered/);
  });

  it('retention raises cleanupPeriodDays once, keeps a higher value and the first backup', async () => {
    const original = await writeSettings({ ...EXISTING, cleanupPeriodDays: 30 });
    expect(cli('retention', '--settings', settings, '--min-days', '3650')).toMatch(/^written: .*30 -> 3650/);
    expect(JSON.parse(await readFile(settings, 'utf8')).cleanupPeriodDays).toBe(3650);
    expect(cli('retention', '--settings', settings)).toMatch(/^unchanged/);
    expect(await readFile(`${settings}.bak-notes-hooks`, 'utf8')).toBe(original);
    await writeSettings({ cleanupPeriodDays: 9999 });
    expect(cli('retention', '--settings', settings, '--min-days', '3650')).toMatch(/^unchanged/);
    const bad = spawnSync(NODE, [HELPER, 'retention', '--settings', settings, '--min-days', 'ten'], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
  });
});

describe('install.sh / uninstall.sh (sourced, temp HOME)', () => {
  it('register_hooks merges into ~/.claude/settings.json, twice = identical, uninstall restores', async () => {
    const original = await writeSettings(EXISTING);
    sourced('install.sh', 'register_hooks');
    const first = await readFile(settings, 'utf8');
    expect(first).toContain(path.join(REPO, 'claude', 'hooks', 'notes-capture.mjs'));
    expect(first).toContain(path.join(REPO, 'claude', 'hooks', 'notes-prompt.mjs'));
    expect(first).toContain(path.join(REPO, 'claude', 'hooks', 'notes-session.mjs'));
    expect(first).toContain(path.join(REPO, 'claude', 'hooks', 'notes-spawn.mjs'));
    expect(first).toContain(NODE);
    sourced('install.sh', 'register_hooks');
    expect(await readFile(settings, 'utf8')).toBe(first);
    sourced('uninstall.sh', 'unregister_hooks');
    expect(await readFile(settings, 'utf8')).toBe(original);
  });

  it('raise_retention sets cleanupPeriodDays, is idempotent, honours the env override, and uninstall keeps it', async () => {
    await writeSettings(EXISTING);
    sourced('install.sh', 'register_hooks; raise_retention');
    const first = await readFile(settings, 'utf8');
    expect(JSON.parse(first).cleanupPeriodDays).toBe(3650);
    sourced('install.sh', 'register_hooks; raise_retention');
    expect(await readFile(settings, 'utf8')).toBe(first);
    sourced('install.sh', 'raise_retention', { NOTES_CLAUDE_RETENTION_DAYS: '5000' });
    expect(JSON.parse(await readFile(settings, 'utf8')).cleanupPeriodDays).toBe(5000);
    sourced('install.sh', 'raise_retention', { NOTES_CLAUDE_RETENTION_DAYS: 'nope' });
    expect(JSON.parse(await readFile(settings, 'utf8')).cleanupPeriodDays).toBe(5000);
    sourced('uninstall.sh', 'unregister_hooks');
    const after = JSON.parse(await readFile(settings, 'utf8'));
    expect(after.cleanupPeriodDays).toBe(5000);
    expect(after.hooks).toEqual(EXISTING.hooks);
  });

  it('--skip-hooks and NOTES_SKIP_HOOKS=1 leave settings.json alone', async () => {
    sourced('install.sh', 'parse_args --skip-hooks; register_hooks; raise_retention');
    expect(existsSync(settings)).toBe(false);
    sourced('install.sh', 'register_hooks; raise_retention', { NOTES_SKIP_HOOKS: '1' });
    expect(existsSync(settings)).toBe(false);
  });

  it('sourcing does not run main', () => {
    expect(() => sourced('install.sh', 'true')).not.toThrow();
    expect(() => sourced('uninstall.sh', 'true')).not.toThrow();
  });
});
```

### Step 14: Endpoint + end-to-end integration tests
**File:** `tests/integration/sessionHooks.int.test.ts` (new)
**Change:** runs against the Docker test DB via `startHarness`. Calls `truncateAll` (Phase 1
extended it to the session tables) in `beforeEach`.
**Code:**
```ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runSession } from '../../claude/hooks/notes-session.mjs';
import { runSpawn } from '../../claude/hooks/notes-spawn.mjs';
import { SESSION_HOOK_SPAWN_PATH, SESSION_HOOK_START_PATH, type SessionHookStartReply } from '../../src/http/sessionHooks.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { startHarness, type Harness } from './imageHarness.js';
import { truncateAll } from './setup.js';

const NODE_ID = /^[0-9A-Z]{2}-[0-9A-Z]{2}$/;
const ORCH = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const HOST = 'test-host';
const CWD = '/home/u/.worktrees/mcp-notes/feat';

let h: Harness;
let repo: SessionsRepo;

beforeAll(async () => {
  h = await startHarness();
  repo = new SessionsRepo(h.deps.db);
});

beforeEach(async () => {
  await h.reset();
  await truncateAll(h.deps.db); // phase 1 extended it to the cc_* tables
});

afterAll(async () => {
  await h.close();
});

function post(pathname: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    h.app.request(`http://127.0.0.1${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notes-capture': '1', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

async function start(body: Record<string, unknown>): Promise<SessionHookStartReply> {
  const res = await post(SESSION_HOOK_START_PATH, { host: HOST, cwd: CWD, source: 'startup', ...body });
  expect(res.status).toBe(200);
  return (await res.json()) as SessionHookStartReply;
}

async function spawn(body: Record<string, unknown>): Promise<void> {
  const res = await post(SESSION_HOOK_SPAWN_PATH, { host: HOST, cwd: CWD, ...body });
  expect(res.status).toBe(201);
}

describe('POST /api/sessions/hook/start', () => {
  it('creates the row with a node id and no parent', async () => {
    const reply = await start({ session: ORCH, name: 'orch-feat', tmux: 'main:@1.%1', started_at: '2026-11-02T03:00:00.000Z' });
    expect(reply.node_id).toMatch(NODE_ID);
    expect(reply).toMatchObject({ session_id: ORCH, parent_session_id: null, parent_node_id: null, parent_link_source: null, claimed: false });
    const row = await repo.getBySessionId(ORCH);
    expect(row?.nodeId).toBe(reply.node_id);
  });

  it('links an env parent and answers with the parent node id; a second start keeps the same ids', async () => {
    const parent = await start({ session: ORCH });
    const first = await start({ session: CHILD, parent: ORCH, tmux: 'main:@2.%2' });
    expect(first).toMatchObject({ parent_session_id: ORCH, parent_node_id: parent.node_id, parent_link_source: 'env' });
    const again = await start({ session: CHILD, parent: ORCH, tmux: 'main:@2.%2' });
    expect(again.node_id).toBe(first.node_id);
    expect(again.parent_link_source).toBe('env');
  });

  it('records an env parent that has no row yet, creating the parent row so both node ids are known', async () => {
    const reply = await start({ session: CHILD, parent: ORCH });
    expect(reply).toMatchObject({ parent_session_id: ORCH, parent_link_source: 'env' });
    expect(reply.parent_node_id).toMatch(NODE_ID);
    expect((await repo.getBySessionId(ORCH))?.nodeId).toBe(reply.parent_node_id);
  });

  it('prunes pending spawns older than a day when a new one is recorded', async () => {
    await spawn({ parent: ORCH });
    await h.deps.db.execute(sql`update cc_pending_spawns set created_at = now() - interval '25 hours'`);
    await spawn({ parent: ORCH });
    const left = await h.deps.db.execute<{ n: number }>(sql`select count(*)::int as n from cc_pending_spawns`);
    expect(left.rows[0]?.n).toBe(1);
  });

  it('resume and compact never set a parent', async () => {
    for (const source of ['resume', 'compact']) {
      const reply = await start({ session: CHILD, parent: ORCH, source });
      expect(reply.parent_session_id).toBeNull();
    }
  });

  it('claims a pending spawn once, within the window, as hook', async () => {
    await start({ session: ORCH });
    await spawn({ parent: ORCH, name: 'kid' });
    const child = await start({ session: CHILD, name: 'kid', tmux: 'main:@3.%3' });
    expect(child).toMatchObject({ parent_session_id: ORCH, parent_link_source: 'hook', claimed: true });
    const other = await start({ session: OTHER, name: 'kid', tmux: 'main:@4.%4' });
    expect(other).toMatchObject({ parent_session_id: null, claimed: false });
    const repeat = await start({ session: CHILD, name: 'kid', tmux: 'main:@3.%3' });
    expect(repeat).toMatchObject({ parent_link_source: 'hook', claimed: false });
  });

  it('does not claim an old spawn, a spawn elsewhere, without tmux, or on clear', async () => {
    await spawn({ parent: ORCH });
    await h.deps.db.execute(sql`update cc_pending_spawns set created_at = now() - interval '31 seconds'`);
    expect((await start({ session: CHILD, tmux: 'main:@3.%3' })).claimed).toBe(false);

    await spawn({ parent: ORCH, cwd: '/somewhere/else' });
    expect((await start({ session: OTHER, tmux: 'main:@4.%4' })).claimed).toBe(false);

    await spawn({ parent: ORCH });
    const noTmux = '44444444-4444-4444-8444-444444444444';
    expect((await start({ session: noTmux })).claimed).toBe(false);
    const cleared = '55555555-5555-4555-8555-555555555555';
    expect((await start({ session: cleared, tmux: 'main:@5.%5', source: 'clear' })).claimed).toBe(false);
    const fresh = '66666666-6666-4666-8666-666666666666';
    expect((await start({ session: fresh, tmux: 'main:@6.%6' })).claimed).toBe(true);
  });

  it('an env parent wins and leaves the pending spawn for its own child', async () => {
    await spawn({ parent: OTHER });
    const child = await start({ session: CHILD, parent: ORCH, tmux: 'main:@3.%3' });
    expect(child).toMatchObject({ parent_session_id: ORCH, parent_link_source: 'env', claimed: false });
    const kid = '77777777-7777-4777-8777-777777777777';
    expect(await start({ session: kid, tmux: 'main:@7.%7' })).toMatchObject({ parent_session_id: OTHER, claimed: true });
  });

  it('guards like the capture route and validates the body', async () => {
    expect((await post(SESSION_HOOK_START_PATH, { session: ORCH }, { 'x-notes-capture': '0' })).status).toBe(403);
    const foreign = await h.app.request(`http://notes.example${SESSION_HOOK_START_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notes-capture': '1' },
      body: JSON.stringify({ session: ORCH }),
    });
    expect(foreign.status).toBe(403);
    expect((await post(SESSION_HOOK_START_PATH, '{oops')).status).toBe(400);
    expect((await post(SESSION_HOOK_START_PATH, { session: 'x y' })).status).toBe(400);
    expect((await post(SESSION_HOOK_SPAWN_PATH, { parent: ORCH, cwd: 'relative' })).status).toBe(400);
  });
});

describe('hooks end to end against a listening daemon', () => {
  let tmp: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    const base = await h.listen();
    tmp = await mkdtemp(path.join(os.tmpdir(), 'notes-session-int-'));
    env = { HOME: tmp, XDG_STATE_HOME: path.join(tmp, 'state'), NOTESD_PORT: new URL(base).port, CLAUDE_CODE_ENTRYPOINT: 'cli' };
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const noFiles = async (): Promise<string> => {
    throw new Error('ENOENT');
  };

  it('a hand-rolled tmux launch links the child to its parent as hook, and both learn their node ids', async () => {
    const orch = await runSession({
      input: { session_id: ORCH, cwd: CWD, source: 'startup', transcript_path: '/t/o.jsonl' },
      env,
      readText: noFiles,
      runTmux: async () => 'main:@1.%1',
      ppid: 1,
      hostname: () => HOST,
    });
    const orchNode = /node ([0-9A-Z]{2}-[0-9A-Z]{2})/.exec(orch!.hookSpecificOutput.additionalContext)![1];

    await runSpawn({
      input: { session_id: ORCH, cwd: CWD, tool_name: 'Bash', tool_input: { command: `tmux new-window -c ${CWD} "claude -n kid"` } },
      env,
      hostname: () => HOST,
    });

    const child = await runSession({
      input: { session_id: CHILD, cwd: CWD, source: 'startup' },
      env: { ...env, TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%2' },
      readText: async (file) => {
        if (file === '/proc/9/cmdline') return ['claude', '-n', 'kid'].join('\0');
        throw new Error('ENOENT');
      },
      runTmux: async () => 'main:@2.%2',
      ppid: 9,
      hostname: () => HOST,
    });
    expect(child!.hookSpecificOutput.additionalContext).toContain(`spawned by node ${orchNode}`);
    const row = await repo.getBySessionId(CHILD);
    expect(row).toMatchObject({ parentSessionId: ORCH, parentLinkSource: 'hook' });
  });

  it('a swarm child (CC_PARENT_SESSION) links as env', async () => {
    await runSession({ input: { session_id: ORCH, cwd: CWD }, env, readText: noFiles, runTmux: async () => '', ppid: 1, hostname: () => HOST });
    const out = await runSession({
      input: { session_id: CHILD, cwd: CWD, source: 'startup' },
      env: { ...env, CC_PARENT_SESSION: ORCH },
      readText: noFiles,
      runTmux: async () => '',
      ppid: 1,
      hostname: () => HOST,
    });
    expect(out!.hookSpecificOutput.additionalContext).toMatch(/spawned by node [0-9A-Z]{2}-[0-9A-Z]{2} \(exact link/);
    expect(await repo.getBySessionId(CHILD)).toMatchObject({ parentSessionId: ORCH, parentLinkSource: 'env' });
  });
});
```
**Impact:** new test file; `h.listen()` is idempotent in the harness, so calling it in `beforeEach` is safe.

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test` (incl. `npx vitest run tests/unit/hooks/notesSession.test.ts tests/unit/hooks/notesSpawn.test.ts tests/unit/scripts/claudeHooks.test.ts`), then `npm run test:int` (incl. `tests/integration/sessionHooks.int.test.ts`).
**Manual check:**
1. `node scripts/claude-hooks.mjs install --settings /tmp/s.json --node "$(command -v node)" --hooks-dir "$PWD/claude/hooks" && node scripts/claude-hooks.mjs status --settings /tmp/s.json` lists five hooks.
2. With the daemon from this worktree running: `echo '{"session_id":"aaaaaaaa-0000-4000-8000-000000000000","cwd":"/tmp","source":"startup"}' | CLAUDE_CODE_ENTRYPOINT=cli node claude/hooks/notes-session.mjs` prints one SessionStart JSON with a node id.
3. `echo '{"session_id":"aaaaaaaa-0000-4000-8000-000000000000","cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"ls"}}' | node claude/hooks/notes-spawn.mjs` prints nothing and exits 0.
4. After `scripts/install.sh`: `jq .cleanupPeriodDays ~/.claude/settings.json` is 3650; a new `claude` in tmux shows "This Claude Code session is node XX-XX" in its context (ask it "what is your node id?").
**Exit criteria:** the five hooks merge idempotently and uninstall cleanly; `retention` raises
`cleanupPeriodDays` once; both endpoints pass their int tests, including "pending spawn claimed only
within the 30 s window, once, never on resume/compact/clear, and an env parent wins"; both hooks
always exit 0 and the spawn hook never prints.

## Handoffs

- **Phase 1 (reconciled):** this phase calls Phase 1's published `upsertFromHook`,
  `claimPendingSpawn({childSessionId, ...})`, `recordPendingSpawn`, `prunePendingSpawns` and
  `getBySessionId` as listed under *Requires*; `PENDING_SPAWN_WINDOW_MS` is imported from
  `src/sessions/types.ts`. `truncateAll` already covers the session tables (Phase 1 Step 11).
- **Phase 3:** the ingester keeps the hook-reported `name`/`tmux` (Phase 1's null-keeps rule) and
  never re-creates a node id for a row the hook inserted first (same `session_id` PK). Pending-spawn
  pruning is owned here (the spawn route), not by the ingest sweep.
- **Phase 7:** mounts `sessionsApi` after `sessionHookRoutes` in `src/http/app.ts`; its
  `/api/sessions/:nodeId` routes are GET, so they cannot shadow these POST paths. Emitting an event
  for the wall when a hook creates a row (live graph refresh) is Phase 7/10's choice; this phase emits none.
- **Phase 8:** owns `notes-prompt.mjs`; nothing here touches it. The SessionStart context already
  teaches the model its node id; Phase 8 resolves ids the user types.
- **Phase 14:** README hooks table (five hooks, `session.log`/`spawn.log`, `NOTES_CLAUDE_RETENTION_DAYS`,
  the two endpoints), CLAUDE.md "Claude Code integration" bullet (hooks list), CHANGELOG.

## Risks

- A hand-launched pane inherits `CC_PARENT_SESSION` if a user types `claude` again in a swarm window
  kept open after its child exited; that session is linked to the orch as `env`. Accepted (it is a
  continuation of that pane's work).
- The Bash matcher spawns a node process for every Bash call (~40 ms). If that is noticeable, a
  follow-up can move the `tmux`/`claude` pre-check into a shell `case` in the hook command.
- `-c` values that need shell expansion fall back to the hook's cwd; a wrong guess only means the
  child is not claimed (later picked up by Phase 4's heuristic only for swarm launches).
- Registry file may not exist at SessionStart; name then comes from `/proc/<pid>/cmdline` (Linux/WSL
  only). On macOS name/tmux would come only from `tmux display-message`; acceptable (both machines are WSL).

## Rollback

Revert this phase's commit, then run `scripts/install.sh` (or `node scripts/claude-hooks.mjs install ...`
from the reverted checkout) to strip `notes-session`/`notes-spawn` from `~/.claude/settings.json`;
the reverted `OUR_SCRIPT` does not recognise them, so if the old helper is used, remove the
`SessionStart` group and the `Bash` PreToolUse group by hand or run `uninstall` from this phase's
checkout first. `cleanupPeriodDays: 3650` stays unless lowered by hand (intended). No schema change
in this phase.
