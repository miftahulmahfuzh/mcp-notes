> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/project-session-graph/PLAN.md` phase 9. Source: `.workflows/plan/project-session-graph/phase-9.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 9: Resume/spawn into tmux, `session_resume` tool

**Plan set:** `PROJECT_SESSION_GRAPH_PLAN.md`
**Analysis:** `docs/analyzer/20261102-093105-N9JN_code_analyzer.md`
**Satisfies:** R8 (resume/spawn from the wall into tmux, focus/message a live node, deleted-cwd handling by measurement), R6 (the `session_resume` MCP + chat tool)
**Depends on:** Phase 7 (and through it 1, 3, 5, 6)
**Difficulty:** HARD
**Package:** `src/sessions`, `src/http`, `src/mcp`

---

## Goal

Given a session node id, the daemon opens that Claude Code session for the user in tmux. If the
session is live it focuses the session's pane and, with a prompt, types the prompt into it. It
never starts a second copy. If the session is not live it opens `claude --resume <sid> [prompt]`
in a new window of the most recently attached tmux session. With `fresh: true` it starts a new
session whose first prompt is the node's context. The wall reaches this through
`POST /api/sessions/:nodeId/resume` (same-origin only). Claude Code and the chat brain reach it
through the `session_resume` MCP tool. A node whose transcript is on the other machine returns
`not_on_this_machine`.

## Measurements (taken 2026-11-02 on the Lenovo; nothing left behind)

Each claim below comes from a run. The experiments used a throwaway `CLAUDE_CONFIG_DIR`, a
synthetic transcript, a local fake Messages API that logged requests (so nothing was billed),
and separate tmux servers (`tmux -L <name>`) that were killed afterwards. Everything was deleted
when the runs finished.

**M1. `claude --resume <sid>` finds the transcript by session id, not by cwd.** Claude Code
2.1.311. A transcript was stored under `projects/<sanitized orig cwd>/<sid>.jsonl`, then `orig`
was deleted.
- `-p --resume <sid>` run from an unrelated directory loaded the transcript. The fake API
  received the old turns ("remember the word PELICAN"), so the transcript loaded. The same
  happened in interactive mode inside a tmux pane (the TUI showed the old turns).
- An unknown id fails at once: `No conversation found with session ID: <id>`, exit 1, about 0.25 s.
- So `--resume` needs neither the original cwd nor a matching project dir.

**M2. A session resumed from another cwd runs in the new cwd and is told so.** The request's
environment block said `Primary working directory: <new> (was <orig>)`.

**M3. A resumed session keeps writing to the original transcript file.** That file, in the
*original* project dir, grew from 162 to 201 lines over the runs. New records carry the new
`cwd`. No transcript appeared under the new cwd's project dir. (This is a handoff to Phase 3.)

**M4. A positional prompt after `--resume <sid>` is sent as the next user turn.** In
interactive mode it was submitted right after the resume ("second prompt ZEBRA" reached the API).

**M5. An inherited `CLAUDE_CODE_CHILD_SESSION` turns transcript saving off.** The first
interactive run inherited it from the calling session's environment. The TUI then showed
`Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`. A window started by
`tmux new-window` gets the tmux *server's* global environment, not the daemon's. That
environment is clean today (`tmux show-environment -g` has no `CLAUDE*`/`CC_*` keys). It would
not be clean if a Claude Code Bash tool had ever started the server. So the command is wrapped
as `env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u
CLAUDE_CODE_ENTRYPOINT -u CC_PARENT_SESSION <claude> ...`.

**M6. tmux from the systemd user unit.** `systemctl --user show notesd` shows `PrivateTmp=no`.
The running daemon's env has no `TMUX`/`TMUX_TMPDIR`. `systemd-run --user --wait -P tmux
list-sessions` (a transient user service like `notesd`) reached the user's server on the
default socket `/tmp/tmux-1000/default` and listed `note`. So **no `-S` is needed**. An optional
override, `NOTESD_TMUX_SOCKET`, adds `-S <path>` to every tmux call for unusual setups.

**M7. tmux details used by the code (tmux 3.4):**
- `new-window` given several arguments runs them directly, without `sh -c` (man page; verified
  with `env -u FOO sleep 5`). So no shell quoting is involved.
- `new-window -c <missing dir>` silently falls back to `$HOME`, so the daemon has to pick the
  cwd itself (see Handling).
- `-t '=<session>:'` targets "that exact session, next free index". `-P -F '#{session_name}:#{window_index} #{pane_id}'` printed `t:2 %1`.
- Any target accepts a pane id: `list-windows -t %9` resolved the session.
- A client→server command is limited to about 16 KB. `set-buffer` with 16 000 bytes worked and
  17 000 failed with `command too long`. Text sent through tmux is capped at 12 000 UTF-8 bytes.
- `set-buffer -b <name> -- <text>` accepts text that starts with `-`, and multi-line text.
  `paste-buffer -p -d -b <name>` pastes it and deletes the buffer (0 buffers afterwards).

**M8. Live registry.** `~/.claude/sessions/<pid>.json` has `tmux: "<session>:@<window>.%<pane>"`
(e.g. `iter1:@181.%260`), `messagingSocketPath: /run/user/1000/cc-socks/<pid>.sock` and a
sibling `<pid>.<hash>.key`, `peerProtocol: 1`. Older sessions (2.1.181) have no `tmux` field
and no socket. The directory also holds files for dead pids; Phase 3's registry filters them by
liveness. The session-name part of `tmux` can be stale after a rename, but pane ids are unique
per server. So only `%<pane>` is used.

### Decisions taken from the measurements

- **Deleted worktree cwd.** `--resume` does not need the original cwd (M1). The daemon picks a
  directory to run in, in this order:
  1. The node's own `cwd`, if it is still a directory.
  2. The most recent cwd of another session in the same repo on this host that is not under
     the worktrees root and still exists. This is the repo's main checkout, where a landed
     worktree's branch now lives.
  3. `~/<repo>`.
  4. `$HOME`.

  Paths under `~/.worktrees` are never picked, because a sibling worktree belongs to a
  different branch. The directory is **not** recreated: an empty non-git directory would be
  worse than the real checkout. The response reports the cwd it used, plus `original_cwd` when
  it fell back. Claude itself tells the model `(was <orig>)` (M2).
- **Messaging a live session: tmux paste, not the messaging socket.** The registry's
  `messagingSocketPath` and `.key` file belong to Claude Code's private peer protocol
  (`peerProtocol: 1`), which `SendMessage` uses between sessions. It is undocumented and
  versioned. It identifies the *sender* as a session (`<cross-session-message from=...>`), and
  the daemon is not one. Older live sessions do not have it (M8). `tmux set-buffer` +
  `paste-buffer -p` (bracketed paste, so a multi-line prompt stays one message) + `send-keys
  Enter` works the same as the user typing. It works on every version, shows up in the pane,
  and Claude Code queues it if the session is busy. A pane in copy mode is first sent
  `send-keys -X cancel`.
- **Never resume twice.** If the registry says the session is live, the daemon focuses or
  messages it. If the session is live but has no reachable pane (not in tmux, or another tmux
  server), the answer is `409 live_outside_tmux {pid}` and nothing is spawned. For the moment
  between spawning and the new process writing its registry file, the resumer remembers each
  spawn for 20 s (`RECENT_SPAWN_MS`). A second click in that window focuses the pane it just
  opened.
- **Fresh sessions hang off the node.** The fresh command sets `CC_PARENT_SESSION=<node sid>`
  through `env`. Phase 5's SessionStart hook then links the new session to the node as `env`,
  so it shows up as a branch of that node.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `src/sessions/resume.ts`: `ResumeAction`, `ResumeRequest`, `ResumeNode`, `LiveEntry`,
  `ResumeResult`, `ResumeOutcome`, `CommandRunner`, `ResumeDeps`, `SessionResumer`,
  `CreateSessionResumerOptions`, `DefaultResumeDepsInput`, `SessionRowLike`; constants
  `RESUME_PROMPT_MAX_CHARS = 4000`, `TMUX_TEXT_MAX_BYTES = 12000`, `RECENT_SPAWN_MS = 20000`,
  `TMUX_TIMEOUT_MS = 5000`, `WINDOW_NAME_MAX = 40`, `SCRUBBED_ENV`, `NEW_WINDOW_FORMAT`,
  `TMUX_SOCKET_ENV = 'NOTESD_TMUX_SOCKET'`, `TMUX_BIN_ENV = 'NOTESD_TMUX_BIN'`; functions
  `runCommand`, `tmuxArgs`, `parseLatest`, `parseRegistryTmux`, `parseNewWindow`, `clipUtf8`,
  `isUnder`, `promptArgs`, `claudeCommand`, `windowName`, `freshPrompt`, `toResumeNode`,
  `pickTmuxSession`, `pickClient`, `paneAlive`, `focusPane`, `messagePane`, `resolveCwd`,
  `resumeNode`, `createSessionResumer`, `defaultResumeDeps`.
- `src/http/sessionResume.ts`: `sessionResumeRoutes(deps, opts)`, `SessionResumeRoutesOptions`,
  `resumeBodySchema`, `sessionLookup(repo)`, `defaultSessionResumer(deps)`.
- `src/mcp/sessionTools.ts`: `registerSessionResumeTool(server, deps)`, `resumeToolResult(outcome, nodeId)`.
- Route `POST /api/sessions/:nodeId/resume` with body `{prompt?: string (<= 4000 chars), fresh?: boolean}`
  (empty body = `{}`, unknown keys rejected), guarded by `sameOriginOnly`:
  - `200 {action: 'focused'|'messaged'|'resumed'|'spawned', window?: "<session>:<index>", cwd?: string, original_cwd?: string}`
  - `400 {error: 'invalid_json'}` / `400 {error: 'invalid_body', message}`
  - `403 {error: 'forbidden_origin'}` (guard)
  - `404 {error: 'not_found'}` / `404 {error: 'not_on_this_machine', host}`
  - `409 {error: 'no_tmux'}` (no tmux server) / `409 {error: 'live_outside_tmux', pid}`
  - `500 {error: 'spawn_failed', message}`
- MCP tool `session_resume(node_id, prompt?, fresh?)`.
- Env vars (read in `defaultResumeDeps`, not `config.ts`): `NOTESD_TMUX_SOCKET` (optional `-S`), `NOTESD_TMUX_BIN` (default `tmux`).

**Signature changes:**
- `mcpToolDeps(deps: AppDeps, sessionOverrides?: SessionsReadOverrides): ToolDeps` (Phase 7) -> `mcpToolDeps(deps, sessionOverrides?, extra?: { sessionResume?: SessionResumer }): ToolDeps` (third optional parameter; Phase 7's call sites unchanged).
- `CreateAppOptions` gains `sessionResume?: SessionResumer`.
- `ToolDeps` gains `sessionResume?: SessionResumer`.

**Requires (from earlier phases):**
- Phase 1: `normalizeNodeId(input): string | null` (`src/sessions/ids.ts`); `class SessionsRepo`
  with `constructor(db: Db, opts?)`, `getByNodeId(input): Promise<SessionRow | null>`,
  `listForRepo(repo, {limit}): Promise<SessionListItem[]>` (newest first; items carry `host`,
  `cwd`); `ccSessions` table with camelCase columns `sessionId, nodeId, host, repo, cwd, name,
  customTitle, aiTitle, summary, firstPrompt, transcriptPath, commits (SessionCommit[]:
  {sha, subject, at}), planDocs (string[])`; `generateNodeId()`.
- Phase 3 (as published): `config.sessions.claudeHome`, `config.sessions.worktreesDir`;
  `readLiveSessions(claudeHome: string, isAlive?): Promise<LiveSession[]>` in
  `src/sessions/registry.ts`, returning only entries whose pid is alive on this host, with
  `LiveSession` carrying `pid: number`, `sessionId: string`, `tmux: string | null` (plus
  `status`, `name`, `cwd`, `messagingSocketPath`, ...). Only the `live:` adapter in
  `defaultSessionResumer` (`src/http/sessionResume.ts`) touches it.
- Phase 5: SessionStart hook turns `CC_PARENT_SESSION` into an `env` parent link (its plan's `parentFrom`).
- Phase 7 (as published): `src/mcp/sessionTools.ts` exists with `registerSessionTools(server, deps)`,
  which `createMcpServer` calls; `src/chat/status.ts` exports
  `SESSION_TOOL_NAMES = ['sessions_search', 'session_get', 'session_transcript', 'sessions_usage'] as const`
  spread into `allowedChatTools()` (19 + 4 + 15 + 2 = 40); `tests/unit/chat-status.test.ts`
  asserts `SESSION_TOOL_NAMES` has length 4 and the total `19 + 4 + 15 + 2`. `src/http/app.ts`
  after Phase 7 Step 8: `CreateAppOptions.sessions?`, `mcpToolDeps(deps, sessionOverrides?)`,
  `const toolDeps = mcpToolDeps(deps, options.sessions);`, and the mounts
  `captureRoutes`, `sessionHookRoutes` (Phase 5), `sessionsApiRoutes(deps, options.sessions)`, `staticRoutes`.

**Leaves alone (owned by others):** `web/**` (Phases 10–13), `src/http/sessionsApi.ts` (Phase
7), `src/sessions/{ids,repo,types,registry,ingest,transcript,repoResolve,links,summarize,search}.ts`
(1, 3, 4, 6), `src/config.ts` (3), `src/mcp/instructions.ts` (7), `claude/hooks/*` (5, 8),
README/CHANGELOG (14).

## Files

| File | Action | What changes |
|---|---|---|
| `src/sessions/resume.ts` | create | tmux/registry/cwd logic, pure + injectable runner |
| `src/http/sessionResume.ts` | create | `POST /api/sessions/:nodeId/resume`, default resumer wiring (repo, registry, config) |
| `src/http/app.ts` (as Phase 7 Step 8 leaves it) | modify | `CreateAppOptions.sessionResume`, `mcpToolDeps` third arg, one resumer shared by route + MCP, mount after `sessionsApiRoutes`, before `staticRoutes` |
| `src/mcp/tools.ts` | modify | `ToolDeps.sessionResume?` (`:12-28`) |
| `src/mcp/sessionTools.ts` | modify | append `registerSessionResumeTool` + `resumeToolResult`; call it at the end of `registerSessionTools` |
| `src/chat/status.ts` | modify | `'session_resume'` in the session tool list; caption `'opening a session in tmux'` in `captionForToolUse` (`:138` switch) |
| `tests/unit/sessions/resume.test.ts` | create | every branch with a fake runner |
| `tests/unit/sessions/sessionResumeRoute.test.ts` | create | guard, body validation, status passthrough |
| `tests/unit/sessions/sessionResumeTool.test.ts` | create | MCP tool over in-memory transport |
| `tests/unit/chat-status.test.ts` | modify | +1 tool, caption row |
| `tests/integration/sessions.resume.int.test.ts` | create | real `SessionsRepo` lookup -> `ResumeNode`, cross-host 404 |

## Implementation Steps

### Step 1: The resume engine
**File:** `src/sessions/resume.ts` (new)
**Change:** All tmux, registry and cwd logic. Every OS touch goes through `ResumeDeps`
(runner, `isDir`, `live`, `repoCwds`, `now`), so tests never spawn anything.
**Code:**
```ts
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveExecutable } from '../chat/env.js';

/*
 * Resume / spawn a Claude Code session into the user's tmux (PROJECT_SESSION_GRAPH phase 9).
 *
 * MEASURED 2026-11-02, Claude Code 2.1.311, tmux 3.4 (see .workflows/plan/project-session-graph/phase-9.md):
 * - `claude --resume <sid>` finds the transcript by session id across every project dir; the
 *   original cwd may be gone. It then runs in the new cwd ("Primary working directory: X (was Y)")
 *   and keeps appending to the ORIGINAL transcript file.
 * - A positional prompt after `--resume <sid>` is submitted as the next user turn.
 * - An inherited CLAUDE_CODE_CHILD_SESSION turns transcript saving off, so the command scrubs it.
 * - The systemd user unit reaches the default tmux socket (/tmp/tmux-<uid>/default); no -S needed.
 * - `new-window -c <missing>` silently falls back to $HOME, so the cwd is resolved here.
 * - One tmux command is capped near 16 KB, so text sent through tmux is clipped to 12 000 bytes.
 */

export const RESUME_PROMPT_MAX_CHARS = 4000;
export const TMUX_TEXT_MAX_BYTES = 12_000;
export const RECENT_SPAWN_MS = 20_000;
export const TMUX_TIMEOUT_MS = 5_000;
export const WINDOW_NAME_MAX = 40;
export const TMUX_SOCKET_ENV = 'NOTESD_TMUX_SOCKET';
export const TMUX_BIN_ENV = 'NOTESD_TMUX_BIN';

/** Removed from the claude process env: markers a server started inside a Claude Code session would leak. */
export const SCRUBBED_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CC_PARENT_SESSION',
] as const;

/** What `new-window -P` prints: "<session>:<index> <pane id>". */
export const NEW_WINDOW_FORMAT = '#{session_name}:#{window_index} #{pane_id}';

export type ResumeAction = 'focused' | 'messaged' | 'resumed' | 'spawned';

export interface ResumeRequest {
  /** Typed into a live session, or passed to `claude --resume <sid> <prompt>`, or appended to a fresh session's context. */
  prompt?: string | undefined;
  /** Start a new session seeded with the node's context instead of resuming it. */
  fresh?: boolean | undefined;
}

/** What resume needs to know about a node (built from a cc_sessions row by toResumeNode). */
export interface ResumeNode {
  sessionId: string;
  nodeId: string;
  host: string;
  repo: string | null;
  cwd: string | null;
  name: string | null;
  title: string | null;
  summary: string | null;
  firstPrompt: string | null;
  transcriptPath: string | null;
  /** "<sha12> <subject>" lines, oldest first. */
  commits: string[];
  planDocs: string[];
}

/** A live registry entry for the node's session on this host. */
export interface LiveEntry {
  pid: number;
  /** Registry `tmux` field, e.g. "note:@0.%7"; null when the session is not in tmux. */
  tmux: string | null;
}

export interface ResumeResult {
  action: ResumeAction;
  /** "<tmux session>:<window index>" the session is in. */
  window?: string;
  /** resumed / spawned: the directory claude runs in. */
  cwd?: string;
  /** Present only when the node's own cwd is gone and `cwd` is a fallback. */
  original_cwd?: string;
}

export type ResumeOutcome =
  | { status: 200; body: ResumeResult }
  | { status: 404; body: { error: 'not_found' } }
  | { status: 404; body: { error: 'not_on_this_machine'; host: string } }
  | { status: 409; body: { error: 'no_tmux' } }
  | { status: 409; body: { error: 'live_outside_tmux'; pid: number } }
  | { status: 500; body: { error: 'spawn_failed'; message: string } };

/** Runs `cmd args` and resolves with stdout; rejects on spawn error, timeout or a non-zero exit. */
export type CommandRunner = (cmd: string, args: readonly string[]) => Promise<string>;

/** Every OS touch point of resume. Tests inject fakes; the daemon uses defaultResumeDeps(). */
export interface ResumeDeps {
  /** os.hostname() of this machine; a node with another host is not_on_this_machine. */
  host: string;
  run: CommandRunner;
  tmuxBin: string;
  /** NOTESD_TMUX_SOCKET: passed as `-S <path>` to every tmux call. Null: tmux's default socket. */
  tmuxSocket: string | null;
  /** Absolute path of the claude executable (what the tmux window execs). */
  claudeBin: string;
  homeDir: string;
  /** Root of `<root>/<repo>/<slug>` worktrees; never chosen as a fallback cwd. */
  worktreesDir: string;
  /** The live registry entry of a session on this host, or null. */
  live(sessionId: string): Promise<LiveEntry | null>;
  isDir(p: string): Promise<boolean>;
  /** Cwds of the repo's sessions on this host, newest first (fallback candidates for a deleted cwd). */
  repoCwds(repo: string): Promise<string[]>;
  now(): number;
}

const execFileAsync = promisify(execFile);

/** The real CommandRunner: execFile (no shell) with a timeout. */
export async function runCommand(
  cmd: string,
  args: readonly string[],
  timeoutMs: number = TMUX_TIMEOUT_MS,
): Promise<string> {
  const { stdout } = await execFileAsync(cmd, [...args], {
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** tmux arguments with the optional `-S <socket>` in front. */
export function tmuxArgs(deps: Pick<ResumeDeps, 'tmuxSocket'>, args: readonly string[]): string[] {
  return deps.tmuxSocket !== null ? ['-S', deps.tmuxSocket, ...args] : [...args];
}

function tmux(deps: ResumeDeps, args: readonly string[]): Promise<string> {
  return deps.run(deps.tmuxBin, tmuxArgs(deps, args));
}

/**
 * Lines of "<number> <value>" -> the value with the largest number. An empty number (a session
 * never attached prints "" for #{session_last_attached}) counts as 0; the first line wins ties.
 */
export function parseLatest(stdout: string): string | null {
  let best: { at: number; value: string } | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const value = line.slice(sp + 1);
    if (value === '') continue;
    const n = Number(line.slice(0, sp));
    const at = Number.isFinite(n) ? n : 0;
    if (best === null || at > best.at) best = { at, value };
  }
  return best === null ? null : best.value;
}

const REGISTRY_TMUX = /^(.*):(@\d+)\.(%\d+)$/;

/** Registry `tmux` field "note:@0.%7" -> parts. Only paneId is trusted (session names go stale on rename). */
export function parseRegistryTmux(value: string): { session: string; windowId: string; paneId: string } | null {
  const m = REGISTRY_TMUX.exec(value.trim());
  if (m === null) return null;
  return { session: m[1]!, windowId: m[2]!, paneId: m[3]! };
}

/** `new-window -P -F NEW_WINDOW_FORMAT` output -> window label and pane id. */
export function parseNewWindow(stdout: string): { window: string; paneId: string | null } {
  const line = (stdout.trim().split('\n')[0] ?? '').trim();
  const sp = line.lastIndexOf(' ');
  if (sp > 0 && line.slice(sp + 1).startsWith('%')) {
    return { window: line.slice(0, sp), paneId: line.slice(sp + 1) };
  }
  return { window: line, paneId: null };
}

/** Text clipped to at most maxBytes of UTF-8 (an ellipsis marks a cut), never splitting a code point. */
export function clipUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const suffix = '…';
  const budget = maxBytes - Buffer.byteLength(suffix, 'utf8');
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > budget) break;
    out += ch;
    bytes += b;
  }
  return out + suffix;
}

/** True when child is parent or inside it. */
export function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The positional prompt for claude; `--` first when it starts with a dash so it is not read as a flag. */
export function promptArgs(prompt: string | undefined): string[] {
  if (prompt === undefined || prompt === '') return [];
  return prompt.startsWith('-') ? ['--', prompt] : [prompt];
}

/** argv for the tmux window: `env -u <markers> [VAR=value...] <claude> <args...>`. */
export function claudeCommand(
  claudeBin: string,
  claudeArgs: readonly string[],
  setEnv: Readonly<Record<string, string>> = {},
): string[] {
  return [
    'env',
    ...SCRUBBED_ENV.flatMap((name) => ['-u', name]),
    ...Object.entries(setEnv).map(([k, v]) => `${k}=${v}`),
    claudeBin,
    ...claudeArgs,
  ];
}

/** tmux window name: the session's name (or node id) for a resume, "<nodeId>-new" for a fresh session. */
export function windowName(node: Pick<ResumeNode, 'name' | 'nodeId'>, fresh: boolean): string {
  const base = fresh ? `${node.nodeId}-new` : node.name?.trim() || node.nodeId;
  return base.replace(/[\s:.]+/g, '-').slice(0, WINDOW_NAME_MAX);
}

/**
 * First prompt of a fresh session: who it continues, where the transcript is, summary (or the
 * first prompt), plan docs, commits, then the user's prompt. Mentions the node id, so Phase 8's
 * prompt hook adds the node's full context too. Clipped to TMUX_TEXT_MAX_BYTES.
 */
export function freshPrompt(node: ResumeNode, userPrompt?: string): string {
  const lines: string[] = [];
  lines.push(`Continue the work of Claude Code session ${node.nodeId}${node.title ? ` ("${node.title}")` : ''}.`);
  if (node.cwd !== null) lines.push(`It ran in ${node.cwd}${node.repo !== null ? ` (repo ${node.repo})` : ''}.`);
  if (node.transcriptPath !== null) {
    lines.push(`Its full transcript is ${node.transcriptPath}; read the parts you need, it is the source of truth.`);
  }
  if (node.summary !== null && node.summary.trim() !== '') {
    lines.push('', 'Summary:', node.summary.trim());
  } else if (node.firstPrompt !== null && node.firstPrompt.trim() !== '') {
    lines.push('', 'It started with:', clipUtf8(node.firstPrompt.trim(), 2000));
  }
  if (node.planDocs.length > 0) lines.push('', 'Plan docs:', ...node.planDocs.slice(0, 20).map((d) => `- ${d}`));
  if (node.commits.length > 0) lines.push('', 'Commits:', ...node.commits.slice(-20).map((c) => `- ${c}`));
  const tail = userPrompt !== undefined && userPrompt !== ''
    ? ['', `Task: ${userPrompt}`]
    : ['', 'Read the context above, then wait for my next instruction.'];
  const head = clipUtf8(lines.join('\n'), TMUX_TEXT_MAX_BYTES - Buffer.byteLength(tail.join('\n'), 'utf8') - 16);
  return clipUtf8(head + tail.join('\n'), TMUX_TEXT_MAX_BYTES);
}

/** The cc_sessions columns resume reads (structurally matches Phase 1's SessionRow). */
export interface SessionRowLike {
  sessionId: string;
  nodeId: string;
  host: string;
  repo: string | null;
  cwd: string | null;
  name: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  summary: string | null;
  firstPrompt: string | null;
  transcriptPath: string | null;
  commits: unknown;
  planDocs: unknown;
}

function field(item: object, key: string): string | null {
  const v = (item as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function stringList(value: unknown, describe: (item: object) => string | null): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      if (item.trim() !== '') out.push(item.trim());
    } else if (typeof item === 'object' && item !== null) {
      const line = describe(item);
      if (line !== null) out.push(line);
    }
  }
  return out;
}

function commitLine(item: object): string | null {
  const sha = field(item, 'sha');
  const subject = field(item, 'subject');
  if (sha !== null && subject !== null) return `${sha.slice(0, 12)} ${subject}`;
  return sha ?? subject;
}

/** cc_sessions row -> ResumeNode. Title: custom title, else AI title. */
export function toResumeNode(row: SessionRowLike): ResumeNode {
  return {
    sessionId: row.sessionId,
    nodeId: row.nodeId,
    host: row.host,
    repo: row.repo,
    cwd: row.cwd,
    name: row.name,
    title: row.customTitle ?? row.aiTitle ?? null,
    summary: row.summary,
    firstPrompt: row.firstPrompt,
    transcriptPath: row.transcriptPath,
    commits: stringList(row.commits, commitLine),
    planDocs: stringList(row.planDocs, (item) => field(item, 'path')),
  };
}

/** The most recently attached tmux session's name, or null when no server is running. */
export async function pickTmuxSession(deps: ResumeDeps): Promise<string | null> {
  try {
    return parseLatest(await tmux(deps, ['list-sessions', '-F', '#{session_last_attached} #{session_name}']));
  } catch {
    return null;
  }
}

/** The most recently active client (its tty name), or null. */
export async function pickClient(deps: ResumeDeps): Promise<string | null> {
  try {
    return parseLatest(await tmux(deps, ['list-clients', '-F', '#{client_activity} #{client_name}']));
  } catch {
    return null;
  }
}

/** True when the pane exists on this tmux server. */
export async function paneAlive(deps: ResumeDeps, paneId: string): Promise<boolean> {
  try {
    const out = await tmux(deps, ['list-panes', '-a', '-F', '#{pane_id}']);
    return out.split('\n').some((line) => line.trim() === paneId);
  } catch {
    return false;
  }
}

/** "<session>:<index>" of the window holding a pane, or null. */
async function windowLabel(deps: ResumeDeps, paneId: string): Promise<string | null> {
  try {
    const out = (await tmux(deps, ['display-message', '-p', '-t', paneId, '#{session_name}:#{window_index}'])).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/** Best effort: show `target` on the most recently active client. */
async function switchMostRecentClient(deps: ResumeDeps, target: string): Promise<void> {
  const client = await pickClient(deps);
  if (client === null) return;
  try {
    await tmux(deps, ['switch-client', '-c', client, '-t', target]);
  } catch {
    // the window is open either way; failing to switch a client is not a failed resume
  }
}

/** Make the pane current in its window and session, and show it on the most recently active client. */
export async function focusPane(deps: ResumeDeps, paneId: string): Promise<void> {
  await tmux(deps, ['select-window', '-t', paneId]);
  await tmux(deps, ['select-pane', '-t', paneId]);
  await switchMostRecentClient(deps, paneId);
}

/** Type text into the pane as one bracketed paste, then Enter. Leaves copy mode first. */
export async function messagePane(deps: ResumeDeps, paneId: string, text: string): Promise<void> {
  const inMode = (await tmux(deps, ['display-message', '-p', '-t', paneId, '#{pane_in_mode}'])).trim();
  if (inMode === '1') await tmux(deps, ['send-keys', '-t', paneId, '-X', 'cancel']);
  const buffer = `notesd-resume-${randomBytes(4).toString('hex')}`;
  await tmux(deps, ['set-buffer', '-b', buffer, '--', clipUtf8(text, TMUX_TEXT_MAX_BYTES)]);
  await tmux(deps, ['paste-buffer', '-p', '-d', '-b', buffer, '-t', paneId]);
  await tmux(deps, ['send-keys', '-t', paneId, 'Enter']);
}

/**
 * Where claude runs: the node's cwd when it still exists; else the newest existing cwd of the
 * repo's sessions outside the worktrees root (the main checkout), else ~/<repo>, else $HOME.
 * `missing` is true when the node had a cwd and it is gone.
 */
export async function resolveCwd(
  deps: ResumeDeps,
  node: Pick<ResumeNode, 'cwd' | 'repo'>,
): Promise<{ cwd: string; missing: boolean }> {
  if (node.cwd !== null && (await deps.isDir(node.cwd))) return { cwd: node.cwd, missing: false };
  const missing = node.cwd !== null;
  const candidates: string[] = [];
  if (node.repo !== null && node.repo !== '') {
    try {
      candidates.push(...(await deps.repoCwds(node.repo)));
    } catch {
      // the DB is only a hint here; fall through to the path convention
    }
    candidates.push(path.join(deps.homeDir, node.repo));
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (candidate === node.cwd || isUnder(candidate, deps.worktreesDir)) continue;
    if (await deps.isDir(candidate)) return { cwd: candidate, missing };
  }
  return { cwd: deps.homeDir, missing };
}

/** Pane of a session spawned moments ago, keyed by session id (registry may not list it yet). */
export type RecentSpawns = Map<string, { at: number; paneId: string }>;

type LiveTarget = { kind: 'none' } | { kind: 'pane'; paneId: string } | { kind: 'outside'; pid: number };

async function liveTarget(deps: ResumeDeps, node: ResumeNode, recent: RecentSpawns): Promise<LiveTarget> {
  const entry = await deps.live(node.sessionId);
  if (entry !== null) {
    const paneId = entry.tmux !== null ? (parseRegistryTmux(entry.tmux)?.paneId ?? null) : null;
    if (paneId !== null && (await paneAlive(deps, paneId))) return { kind: 'pane', paneId };
    return { kind: 'outside', pid: entry.pid };
  }
  const spawned = recent.get(node.sessionId);
  if (spawned !== undefined) {
    if (deps.now() - spawned.at < RECENT_SPAWN_MS && (await paneAlive(deps, spawned.paneId))) {
      return { kind: 'pane', paneId: spawned.paneId };
    }
    recent.delete(node.sessionId);
  }
  return { kind: 'none' };
}

function ok(body: ResumeResult): ResumeOutcome {
  return { status: 200, body };
}

/**
 * The whole decision for one node:
 * other host -> 404 not_on_this_machine (no tmux call at all);
 * not fresh and live in a reachable pane -> focus it (and message it with a prompt);
 * not fresh and live elsewhere -> 409 live_outside_tmux (never resume twice);
 * otherwise a new window in the most recently attached tmux session (409 no_tmux without one):
 * `claude --resume <sid> [prompt]`, or with fresh a new claude whose first prompt is the node's context.
 */
export async function resumeNode(
  deps: ResumeDeps,
  node: ResumeNode,
  req: ResumeRequest,
  recent: RecentSpawns = new Map(),
): Promise<ResumeOutcome> {
  if (node.host !== deps.host) return { status: 404, body: { error: 'not_on_this_machine', host: node.host } };
  const trimmed = req.prompt?.trim();
  const prompt = trimmed === undefined || trimmed === '' ? undefined : clipUtf8(trimmed, TMUX_TEXT_MAX_BYTES);
  const fresh = req.fresh === true;
  try {
    if (!fresh) {
      const target = await liveTarget(deps, node, recent);
      if (target.kind === 'outside') return { status: 409, body: { error: 'live_outside_tmux', pid: target.pid } };
      if (target.kind === 'pane') {
        await focusPane(deps, target.paneId);
        const window = await windowLabel(deps, target.paneId);
        const where = window !== null ? { window } : {};
        if (prompt !== undefined) {
          await messagePane(deps, target.paneId, prompt);
          return ok({ action: 'messaged', ...where });
        }
        return ok({ action: 'focused', ...where });
      }
    }

    const session = await pickTmuxSession(deps);
    if (session === null) return { status: 409, body: { error: 'no_tmux' } };
    const place = await resolveCwd(deps, node);
    const argv = fresh
      ? claudeCommand(deps.claudeBin, promptArgs(freshPrompt(node, prompt)), { CC_PARENT_SESSION: node.sessionId })
      : claudeCommand(deps.claudeBin, ['--resume', node.sessionId, ...promptArgs(prompt)]);
    const out = await tmux(deps, [
      'new-window',
      '-t',
      `=${session}:`,
      '-c',
      place.cwd,
      '-n',
      windowName(node, fresh),
      '-P',
      '-F',
      NEW_WINDOW_FORMAT,
      ...argv,
    ]);
    const created = parseNewWindow(out);
    if (created.paneId !== null) {
      if (!fresh) recent.set(node.sessionId, { at: deps.now(), paneId: created.paneId });
      await switchMostRecentClient(deps, created.paneId);
    }
    return ok({
      action: fresh ? 'spawned' : 'resumed',
      ...(created.window !== '' ? { window: created.window } : {}),
      cwd: place.cwd,
      ...(place.missing && node.cwd !== null ? { original_cwd: node.cwd } : {}),
    });
  } catch (err) {
    return { status: 500, body: { error: 'spawn_failed', message: errorMessage(err) } };
  }
}

/** Resolves a node id (any spelling) and resumes it. Shared by the HTTP route and the MCP tool. */
export interface SessionResumer {
  resume(nodeIdInput: string, req: ResumeRequest): Promise<ResumeOutcome>;
}

export interface CreateSessionResumerOptions {
  /** Canonical node id or null for a non-id (Phase 1's normalizeNodeId). */
  normalize(input: string): string | null;
  /** The node with this canonical id, or null. */
  lookup(nodeId: string): Promise<ResumeNode | null>;
  /** The deps, or a factory called once on first use (keeps construction free of I/O). */
  deps: ResumeDeps | (() => ResumeDeps);
}

export function createSessionResumer(opts: CreateSessionResumerOptions): SessionResumer {
  const recent: RecentSpawns = new Map();
  let resolved: ResumeDeps | undefined;
  const getDeps = (): ResumeDeps => {
    resolved ??= typeof opts.deps === 'function' ? opts.deps() : opts.deps;
    return resolved;
  };
  return {
    async resume(nodeIdInput, req) {
      const nodeId = opts.normalize(nodeIdInput);
      if (nodeId === null) return { status: 404, body: { error: 'not_found' } };
      const node = await opts.lookup(nodeId);
      if (node === null) return { status: 404, body: { error: 'not_found' } };
      return resumeNode(getDeps(), node, req, recent);
    },
  };
}

export interface DefaultResumeDepsInput {
  /** config.chat.claudeBin (NOTESD_CLAUDE_BIN); resolved against PATH to an absolute path. */
  claudeBin: string;
  worktreesDir: string;
  live: ResumeDeps['live'];
  repoCwds: ResumeDeps['repoCwds'];
  /** Defaults to process.env (NOTESD_TMUX_SOCKET, NOTESD_TMUX_BIN, PATH). */
  env?: Readonly<Record<string, string | undefined>>;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** The real ResumeDeps for the daemon. */
export function defaultResumeDeps(input: DefaultResumeDepsInput): ResumeDeps {
  const env = input.env ?? process.env;
  const socket = env[TMUX_SOCKET_ENV]?.trim();
  return {
    host: os.hostname(),
    run: (cmd, args) => runCommand(cmd, args),
    tmuxBin: env[TMUX_BIN_ENV]?.trim() || 'tmux',
    tmuxSocket: socket !== undefined && socket !== '' ? socket : null,
    claudeBin: resolveExecutable(input.claudeBin, env.PATH),
    homeDir: os.homedir(),
    worktreesDir: input.worktreesDir,
    live: input.live,
    isDir: isDirectory,
    repoCwds: input.repoCwds,
    now: () => Date.now(),
  };
}
```
**Impact:** New module. Nothing imports it until Step 2.

### Step 2: The route and the default wiring
**File:** `src/http/sessionResume.ts` (new)
**Change:** `POST /api/sessions/:nodeId/resume`, guarded by `sameOriginOnly`. This module is
where the pure engine meets Phase 1's repo, Phase 3's registry and config. The default resumer
is lazy: building the app touches no DB, filesystem or tmux.
**Code:**
```ts
import os from 'node:os';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { normalizeNodeId } from '../sessions/ids.js';
import { readLiveSessions } from '../sessions/registry.js';
import { SessionsRepo } from '../sessions/repo.js';
import {
  createSessionResumer,
  defaultResumeDeps,
  RESUME_PROMPT_MAX_CHARS,
  toResumeNode,
  type ResumeNode,
  type SessionResumer,
} from '../sessions/resume.js';
import { describeIssues } from './api.js';
import { sameOriginOnly } from './sameOrigin.js';

/** `{prompt?, fresh?}`; unknown keys are refused so a typo never silently resumes instead of spawning. */
export const resumeBodySchema = z.strictObject({
  prompt: z.string().max(RESUME_PROMPT_MAX_CHARS).optional(),
  fresh: z.boolean().optional(),
});

export interface SessionResumeRoutesOptions {
  /** Defaults to defaultSessionResumer(deps). createApp passes the one it shares with the MCP tool. */
  resumer?: SessionResumer;
}

/** Node id -> ResumeNode through Phase 1's repo (getByNodeId is case/dash tolerant). */
export function sessionLookup(repo: Pick<SessionsRepo, 'getByNodeId'>): (nodeId: string) => Promise<ResumeNode | null> {
  return async (nodeId) => {
    const row = await repo.getByNodeId(nodeId);
    return row === null ? null : toResumeNode(row);
  };
}

/** The daemon's resumer: cc_sessions via SessionsRepo, live status via the registry, real tmux. */
export function defaultSessionResumer(deps: AppDeps): SessionResumer {
  let sessions: SessionsRepo | undefined;
  const repo = (): SessionsRepo => {
    sessions ??= new SessionsRepo(deps.db);
    return sessions;
  };
  const host = os.hostname();
  return createSessionResumer({
    normalize: normalizeNodeId,
    lookup: (nodeId) => sessionLookup(repo())(nodeId),
    deps: () =>
      defaultResumeDeps({
        claudeBin: deps.config.chat.claudeBin,
        worktreesDir: deps.config.sessions.worktreesDir,
        live: async (sessionId) => {
          const entry = (await readLiveSessions(deps.config.sessions.claudeHome)).find((s) => s.sessionId === sessionId);
          return entry === undefined ? null : { pid: entry.pid, tmux: entry.tmux ?? null };
        },
        repoCwds: async (name) =>
          (await repo().listForRepo(name, { limit: 200 }))
            .filter((item) => item.host === host && item.cwd !== null)
            .map((item) => item.cwd as string),
      }),
  });
}

/** An empty body is `{}`; anything else must be JSON. */
async function readBody(c: Context): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await c.req.text();
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * POST /api/sessions/:nodeId/resume {prompt?, fresh?} (own Origin only)
 * -> 200 {action: focused|messaged|resumed|spawned, window?, cwd?, original_cwd?}
 * | 404 not_found | 404 not_on_this_machine {host} | 409 no_tmux | 409 live_outside_tmux {pid}
 * | 500 spawn_failed {message} | 400 invalid_json | 400 invalid_body {message} | 403 forbidden_origin.
 */
export function sessionResumeRoutes(deps: AppDeps, opts: SessionResumeRoutesOptions = {}): Hono {
  let resumer = opts.resumer;
  const getResumer = (): SessionResumer => {
    resumer ??= defaultSessionResumer(deps);
    return resumer;
  };
  const r = new Hono();

  r.post('/api/sessions/:nodeId/resume', sameOriginOnly, async (c) => {
    const body = await readBody(c);
    if (!body.ok) return c.json({ error: 'invalid_json' }, 400);
    const parsed = resumeBodySchema.safeParse(body.value);
    if (!parsed.success) return c.json({ error: 'invalid_body', message: describeIssues(parsed.error) }, 400);
    const out = await getResumer().resume(c.req.param('nodeId'), parsed.data);
    return c.json(out.body, out.status);
  });

  return r;
}
```
**Impact:** New module. If Phase 3's registry export has a different name or shape, adapt the
`live:` adapter above, nothing else (see Interface Contract → Requires).

### Step 3: `ToolDeps.sessionResume`
**File:** `src/mcp/tools.ts:12-28` (the `ToolDeps` interface; append after the `chatUploads` member, or after whatever Phase 7 appended last)
**Change:** One optional member plus its type import. Add this import line among the
existing type imports at the top of the file (`:1-10`):
```ts
import type { SessionResumer } from '../sessions/resume.js';
```
Add this member as the last one in `ToolDeps`:
```ts
  /** Phase 9: resume / spawn a session into tmux (`session_resume`). Omitted: the tool answers that it is unavailable. */
  sessionResume?: SessionResumer;
```
**Impact:** Optional, so every existing `ToolDeps` literal still compiles.

### Step 4: The `session_resume` MCP tool
**File:** `src/mcp/sessionTools.ts` (Phase 7's file). Append at the end of the file, and add
one call as the **last statement** of Phase 7's `registerSessionTools(server, deps)`:
```ts
  registerSessionResumeTool(server, deps);
```
Add these imports at the top of the file. Skip any Phase 7 already imports; `z`,
`McpServer`, `jsonResult` and `errorResult` are probably there already:
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { RESUME_PROMPT_MAX_CHARS, type ResumeOutcome } from '../sessions/resume.js';
import { errorResult, jsonResult, type ToolDeps } from './tools.js';
```
**Code (appended):**
```ts
function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

/** ResumeOutcome -> the tool's answer: the JSON result on success, a "<code>: <what to do>" error otherwise. */
export function resumeToolResult(out: ResumeOutcome, nodeId: string): CallToolResult {
  if (out.status === 200) return jsonResult(out.body);
  const body = out.body;
  switch (body.error) {
    case 'not_found':
      return toolError(`not_found: no session with node id ${nodeId}`);
    case 'not_on_this_machine':
      return toolError(`not_on_this_machine: session ${nodeId} ran on ${body.host}; resume it on that machine`);
    case 'no_tmux':
      return toolError('no_tmux: no tmux server is running on this machine, so there is nowhere to open the session');
    case 'live_outside_tmux':
      return toolError(`live_outside_tmux: session ${nodeId} is already running (pid ${body.pid}) outside tmux; switch to its terminal`);
    case 'spawn_failed':
      return toolError(`spawn_failed: ${body.message}`);
  }
}

export function registerSessionResumeTool(server: McpServer, deps: Pick<ToolDeps, 'sessionResume'>): void {
  server.registerTool(
    'session_resume',
    {
      title: 'Resume a Claude Code session',
      description:
        "Open a Claude Code session from the session graph in the user's tmux, on this machine. node_id is a session node id like A0-3G (two characters, a dash, two characters; not a note id). If that session is already running, its tmux window is focused and prompt (if given) is typed into it; it is never resumed twice. Otherwise a new window in the most recently attached tmux session runs `claude --resume <session> [prompt]` in the session's directory; if that directory is gone (a removed worktree) it runs from the repository checkout and returns original_cwd. fresh=true starts a new session whose first prompt is this node's summary, commits and plan docs (plus prompt) instead of resuming. A session whose transcript lives on the other machine answers not_on_this_machine. Returns { action: focused | messaged | resumed | spawned, window }.",
      inputSchema: {
        node_id: z.string().min(1).describe('Session node id like A0-3G. Case-insensitive; the dash may be omitted.'),
        prompt: z
          .string()
          .max(RESUME_PROMPT_MAX_CHARS)
          .optional()
          .describe('Optional message: typed into the running session, or sent as the first turn after resuming.'),
        fresh: z
          .boolean()
          .optional()
          .describe("true: start a new session seeded with this node's context instead of resuming it. Default false."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ node_id, prompt, fresh }) => {
      const resumer = deps.sessionResume;
      if (resumer === undefined) return toolError('session_resume is not available in this server');
      try {
        return resumeToolResult(await resumer.resume(node_id, { prompt, fresh }), node_id);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
```
**Impact:** `createMcpServer` already calls `registerSessionTools` (Phase 7), so the tool shows
up without touching `src/mcp/server.ts`. `resumeToolResult`'s `switch` covers every case, so it
has no fallthrough return and TS checks that it is exhaustive.

### Step 5: One resumer shared by route and tool; mount the route
**File:** `src/http/app.ts`
**Change 5a, imports (`:1-16`).** Add:
```ts
import type { SessionResumer } from '../sessions/resume.js';
import { defaultSessionResumer, sessionResumeRoutes } from './sessionResume.js';
```
**Change 5b, `CreateAppOptions` (`:34-39`).** Add the member:
```ts
  /** Resume/spawn into tmux, shared by POST /api/sessions/:nodeId/resume and the session_resume tool. Omitted: the real one. */
  sessionResume?: SessionResumer;
```
**Change 5c, `mcpToolDeps`.** Phase 7 made it `mcpToolDeps(deps, sessionOverrides?)` and always
sets `sessions`. This phase adds a third, optional parameter, so Phase 7's call sites and tests
compile unchanged. The function after this phase (Phase 7's body kept, `sessionResume` spread added):
```ts
export function mcpToolDeps(
  deps: AppDeps,
  sessionOverrides?: SessionsReadOverrides,
  extra: { sessionResume?: SessionResumer } = {},
): ToolDeps {
  const wallUrl = wallUrlForPort(deps.config.port);
  return {
    service: deps.service,
    dataDir: deps.config.dataDir,
    db: deps.db,
    imageEmbedder: deps.imageEmbedder ?? null,
    chatUploads: dbChatUploadSource(deps.db, deps.config.dataDir),
    sessions: sessionsReadDeps(deps, sessionOverrides),
    ...(wallUrl !== undefined ? { wallUrl } : {}),
    ...(extra.sessionResume !== undefined ? { sessionResume: extra.sessionResume } : {}),
  };
}
```
The `extra` default is `{}`, so `tests/unit/mcp.instructions.test.ts:177-181` (partial
`AppDeps`, no `config.sessions`) still passes. `mcpToolDeps` never builds a resumer itself.

**Change 5d, `createApp`.** Replace Phase 7's line
`const toolDeps = mcpToolDeps(deps, options.sessions);` with:
```ts
  const sessionResume = options.sessionResume ?? defaultSessionResumer(deps);
  const toolDeps = mcpToolDeps(deps, options.sessions, { sessionResume });
```
**Change 5e, mount.** Insert immediately above `app.route('/', staticRoutes(deps));`, i.e.
right after Phase 7's `app.route('/', sessionsApiRoutes(deps, options.sessions));`:
```ts
  app.route('/', sessionResumeRoutes(deps, { resumer: sessionResume }));
```
Add `sessionResumeRoutes (project-session-graph phase 9: resume/spawn into tmux, own Origin
only)` to the mount-order list in the `createApp` doc comment, just before `staticRoutes`.
**Impact:** `defaultSessionResumer` is lazy, so every existing `createApp(deps)` caller
(`daemon.ts:106`, `mcp.tools.int`, `connectors/mcp.int`, `reveal.int`) builds no repo, reads
nothing and spawns nothing. The route path `/api/sessions/:nodeId/resume` (POST) clashes with
neither Phase 7's GET `/api/sessions/:nodeId` nor Phase 5's POST `/api/sessions/hook/{start,spawn}`:
different method or different last segment.

### Step 6: Chat brain allowlist and caption
**File:** `src/chat/status.ts`
**Change 6a.** Add `'session_resume'` as the last entry of Phase 7's `SESSION_TOOL_NAMES`
(it becomes `['sessions_search', 'session_get', 'session_transcript', 'sessions_usage', 'session_resume']`). Update the
`allowedChatTools()` doc comment to say: "PROJECT_SESSION_GRAPH_PLAN phase 9 adds `session_resume`."
**Change 6b.** In `captionForToolUse`, add above `default:` (currently `:138`):
```ts
    case 'session_resume':
      return 'opening a session in tmux';
```
**Impact:** The chat brain can now call `mcp__notes__session_resume`. Nothing else changes.

### Step 7: Unit tests for the engine
**File:** `tests/unit/sessions/resume.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import {
  claudeCommand,
  clipUtf8,
  createSessionResumer,
  freshPrompt,
  isUnder,
  NEW_WINDOW_FORMAT,
  parseLatest,
  parseNewWindow,
  parseRegistryTmux,
  promptArgs,
  RECENT_SPAWN_MS,
  resolveCwd,
  resumeNode,
  SCRUBBED_ENV,
  toResumeNode,
  windowName,
  type CommandRunner,
  type LiveEntry,
  type ResumeDeps,
  type ResumeNode,
} from '../../../src/sessions/resume.js';

const SID = '6f1c2d3e-0000-4000-8000-00000000abcd';
const CLAUDE = '/opt/claude/claude.exe';

type Handler = (args: string[]) => string;

/** A tmux that answers per subcommand; records every call (with any -S stripped in `sub`). */
function fakeTmux(over: Partial<Record<string, Handler>> = {}) {
  const calls: string[][] = [];
  const handlers: Record<string, Handler> = {
    'list-sessions': () => '100 work\n200 note\n 0 never\n',
    'list-clients': () => '50 /dev/pts/1\n90 /dev/pts/2\n',
    'list-panes': () => '%1\n%7\n',
    'display-message': (a) => (a.includes('#{pane_in_mode}') ? '0\n' : 'note:1\n'),
    'new-window': () => 'note:3 %12\n',
    ...over,
  } as Record<string, Handler>;
  const run: CommandRunner = async (cmd, args) => {
    expect(cmd).toBe('tmux');
    calls.push([...args]);
    const a = args[0] === '-S' ? args.slice(2) : [...args];
    const h = handlers[a[0]!];
    return h === undefined ? '' : h(a);
  };
  const sub = (name: string): string[][] =>
    calls.map((c) => (c[0] === '-S' ? c.slice(2) : c)).filter((c) => c[0] === name);
  return { run, calls, sub };
}

function makeDeps(
  run: CommandRunner,
  over: Partial<ResumeDeps> & { dirs?: string[]; liveEntry?: LiveEntry | null; clock?: { t: number } } = {},
): ResumeDeps {
  const dirs = new Set(over.dirs ?? ['/home/u/mcp-notes', '/home/u']);
  const clock = over.clock ?? { t: 1_000_000 };
  return {
    host: 'lenovo',
    run,
    tmuxBin: 'tmux',
    tmuxSocket: null,
    claudeBin: CLAUDE,
    homeDir: '/home/u',
    worktreesDir: '/home/u/.worktrees',
    live: async () => over.liveEntry ?? null,
    isDir: async (p) => dirs.has(p),
    repoCwds: async () => [],
    now: () => clock.t,
    ...over,
  };
}

function node(over: Partial<ResumeNode> = {}): ResumeNode {
  return {
    sessionId: SID,
    nodeId: 'A0-3G',
    host: 'lenovo',
    repo: 'mcp-notes',
    cwd: '/home/u/mcp-notes',
    name: 'impl-x-p1',
    title: 'wall editing',
    summary: 'Built the photo delete flow.',
    firstPrompt: 'make photos deletable',
    transcriptPath: `/home/u/.claude/projects/-home-u-mcp-notes/${SID}.jsonl`,
    commits: ['abc123def456 feat: delete photos'],
    planDocs: ['docs/plans/WALL_PLAN.md'],
    ...over,
  };
}

function newWindowArgv(cwd: string, name: string, argv: string[]): string[] {
  return ['new-window', '-t', '=note:', '-c', cwd, '-n', name, '-P', '-F', NEW_WINDOW_FORMAT, ...argv];
}

describe('parsers', () => {
  it('parseLatest picks the largest number, treats an empty number as 0, keeps spaces in names', () => {
    expect(parseLatest('100 work\n200 note\n 0 never\n')).toBe('note');
    expect(parseLatest(' a\n b\n')).toBe('a');
    expect(parseLatest('5 my session\n')).toBe('my session');
    expect(parseLatest('')).toBeNull();
  });

  it('parseRegistryTmux keeps the pane id and tolerates colons in the session name', () => {
    expect(parseRegistryTmux('note:@0.%7')).toEqual({ session: 'note', windowId: '@0', paneId: '%7' });
    expect(parseRegistryTmux('a:b:@12.%255')).toEqual({ session: 'a:b', windowId: '@12', paneId: '%255' });
    expect(parseRegistryTmux('%7')).toBeNull();
  });

  it('parseNewWindow splits the window label from the pane id', () => {
    expect(parseNewWindow('note:3 %12\n')).toEqual({ window: 'note:3', paneId: '%12' });
    expect(parseNewWindow('my session:3 %12')).toEqual({ window: 'my session:3', paneId: '%12' });
    expect(parseNewWindow('')).toEqual({ window: '', paneId: null });
  });

  it('clipUtf8 cuts on code points within the byte budget', () => {
    expect(clipUtf8('short', 100)).toBe('short');
    const cut = clipUtf8('é'.repeat(100), 21);
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(21);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('isUnder, promptArgs, windowName', () => {
    expect(isUnder('/home/u/.worktrees/mcp-notes/x', '/home/u/.worktrees')).toBe(true);
    expect(isUnder('/home/u/mcp-notes', '/home/u/.worktrees')).toBe(false);
    expect(promptArgs(undefined)).toEqual([]);
    expect(promptArgs('go on')).toEqual(['go on']);
    expect(promptArgs('-x please')).toEqual(['--', '-x please']);
    expect(windowName({ name: 'impl x:p1', nodeId: 'A0-3G' }, false)).toBe('impl-x-p1');
    expect(windowName({ name: null, nodeId: 'A0-3G' }, false)).toBe('A0-3G');
    expect(windowName({ name: 'impl', nodeId: 'A0-3G' }, true)).toBe('A0-3G-new');
  });

  it('claudeCommand scrubs the inherited Claude Code markers (M5) and sets extra env', () => {
    expect(SCRUBBED_ENV).toContain('CLAUDE_CODE_CHILD_SESSION');
    expect(claudeCommand(CLAUDE, ['--resume', SID], { CC_PARENT_SESSION: 'p' })).toEqual([
      'env',
      ...SCRUBBED_ENV.flatMap((n) => ['-u', n]),
      'CC_PARENT_SESSION=p',
      CLAUDE,
      '--resume',
      SID,
    ]);
  });

  it('toResumeNode maps commits {sha, subject} and plan docs, title falls back to the AI title', () => {
    const n = toResumeNode({
      sessionId: SID,
      nodeId: 'A0-3G',
      host: 'lenovo',
      repo: 'mcp-notes',
      cwd: '/x',
      name: null,
      customTitle: null,
      aiTitle: 'AI title',
      summary: null,
      firstPrompt: 'hi',
      transcriptPath: null,
      commits: [{ sha: 'abc123def4567890', subject: 'feat: y', at: null }, 'raw line', 42],
      planDocs: ['docs/plans/A.md', ''],
    });
    expect(n.title).toBe('AI title');
    expect(n.commits).toEqual(['abc123def456 feat: y', 'raw line']);
    expect(n.planDocs).toEqual(['docs/plans/A.md']);
  });

  it('freshPrompt carries node id, transcript, summary, commits, plan docs and the task, within the byte budget', () => {
    const p = freshPrompt(node(), 'add tests');
    expect(p).toContain('A0-3G');
    expect(p).toContain(`${SID}.jsonl`);
    expect(p).toContain('Built the photo delete flow.');
    expect(p).toContain('- abc123def456 feat: delete photos');
    expect(p).toContain('- docs/plans/WALL_PLAN.md');
    expect(p.endsWith('Task: add tests')).toBe(true);
    const huge = freshPrompt(node({ summary: 'x'.repeat(50_000) }), 'keep me');
    expect(Buffer.byteLength(huge, 'utf8')).toBeLessThanOrEqual(12_000);
    expect(huge.endsWith('Task: keep me')).toBe(true);
  });
});

describe('resumeNode', () => {
  it('a node from another host is not_on_this_machine and touches no tmux', async () => {
    const t = fakeTmux();
    const out = await resumeNode(makeDeps(t.run), node({ host: 'GPD' }), {});
    expect(out).toEqual({ status: 404, body: { error: 'not_on_this_machine', host: 'GPD' } });
    expect(t.calls).toEqual([]);
  });

  it('not live: claude --resume in a new window of the most recently attached session', async () => {
    const t = fakeTmux();
    const out = await resumeNode(makeDeps(t.run), node(), {});
    expect(out).toEqual({ status: 200, body: { action: 'resumed', window: 'note:3', cwd: '/home/u/mcp-notes' } });
    expect(t.sub('new-window')).toEqual([
      newWindowArgv('/home/u/mcp-notes', 'impl-x-p1', claudeCommand(CLAUDE, ['--resume', SID])),
    ]);
    expect(t.sub('switch-client')).toEqual([['switch-client', '-c', '/dev/pts/2', '-t', '%12']]);
  });

  it('not live with a prompt: the prompt follows --resume <sid>, behind -- when it starts with a dash', async () => {
    const t = fakeTmux();
    await resumeNode(makeDeps(t.run), node(), { prompt: '  continue  ' });
    await resumeNode(makeDeps(t.run), node({ sessionId: 'other' }), { prompt: '-rf? no, continue' });
    const [first, second] = t.sub('new-window');
    expect(first!.slice(-3)).toEqual(['--resume', SID, 'continue']);
    expect(second!.slice(-4)).toEqual(['--resume', 'other', '--', '-rf? no, continue']);
  });

  it('live in a reachable pane: focuses it, never opens a window', async () => {
    const t = fakeTmux();
    const out = await resumeNode(makeDeps(t.run, { liveEntry: { pid: 42, tmux: 'stale-name:@0.%7' } }), node(), {});
    expect(out).toEqual({ status: 200, body: { action: 'focused', window: 'note:1' } });
    expect(t.sub('select-window')).toEqual([['select-window', '-t', '%7']]);
    expect(t.sub('select-pane')).toEqual([['select-pane', '-t', '%7']]);
    expect(t.sub('switch-client')).toEqual([['switch-client', '-c', '/dev/pts/2', '-t', '%7']]);
    expect(t.sub('new-window')).toEqual([]);
  });

  it('live with a prompt: pastes it as one bracketed paste and presses Enter', async () => {
    const t = fakeTmux();
    const out = await resumeNode(makeDeps(t.run, { liveEntry: { pid: 42, tmux: 'note:@0.%7' } }), node(), {
      prompt: 'line one\nline two',
    });
    expect(out).toEqual({ status: 200, body: { action: 'messaged', window: 'note:1' } });
    const [set] = t.sub('set-buffer');
    expect(set!.slice(0, 2)).toEqual(['set-buffer', '-b']);
    expect(set!.slice(3)).toEqual(['--', 'line one\nline two']);
    const buffer = set![2]!;
    expect(t.sub('paste-buffer')).toEqual([['paste-buffer', '-p', '-d', '-b', buffer, '-t', '%7']]);
    expect(t.sub('send-keys')).toEqual([['send-keys', '-t', '%7', 'Enter']]);
    expect(t.sub('new-window')).toEqual([]);
  });

  it('a pane in copy mode is released before the paste', async () => {
    const t = fakeTmux({ 'display-message': (a) => (a.includes('#{pane_in_mode}') ? '1\n' : 'note:1\n') });
    await resumeNode(makeDeps(t.run, { liveEntry: { pid: 42, tmux: 'note:@0.%7' } }), node(), { prompt: 'hi' });
    expect(t.sub('send-keys')).toEqual([
      ['send-keys', '-t', '%7', '-X', 'cancel'],
      ['send-keys', '-t', '%7', 'Enter'],
    ]);
  });

  it('live but not in tmux (or its pane is gone): 409 live_outside_tmux, nothing spawned', async () => {
    const t = fakeTmux();
    expect(await resumeNode(makeDeps(t.run, { liveEntry: { pid: 42, tmux: null } }), node(), {})).toEqual({
      status: 409,
      body: { error: 'live_outside_tmux', pid: 42 },
    });
    expect(await resumeNode(makeDeps(t.run, { liveEntry: { pid: 43, tmux: 'note:@0.%99' } }), node(), {})).toEqual({
      status: 409,
      body: { error: 'live_outside_tmux', pid: 43 },
    });
    expect(t.sub('new-window')).toEqual([]);
  });

  it('fresh: a new claude with the node context, child of the node, even while the node is live', async () => {
    const t = fakeTmux();
    const out = await resumeNode(makeDeps(t.run, { liveEntry: { pid: 42, tmux: 'note:@0.%7' } }), node(), {
      fresh: true,
      prompt: 'write the README',
    });
    expect(out).toEqual({ status: 200, body: { action: 'spawned', window: 'note:3', cwd: '/home/u/mcp-notes' } });
    const [nw] = t.sub('new-window');
    const expectedPrompt = freshPrompt(node(), 'write the README');
    expect(nw).toEqual(
      newWindowArgv(
        '/home/u/mcp-notes',
        'A0-3G-new',
        claudeCommand(CLAUDE, [expectedPrompt], { CC_PARENT_SESSION: SID }),
      ),
    );
    expect(t.sub('select-window')).toEqual([]);
  });

  it('no tmux server: 409 no_tmux', async () => {
    const t = fakeTmux({
      'list-sessions': () => {
        throw new Error('no server running on /tmp/tmux-1000/default');
      },
    });
    expect(await resumeNode(makeDeps(t.run), node(), {})).toEqual({ status: 409, body: { error: 'no_tmux' } });
  });

  it('new-window failing is a 500 spawn_failed with the message', async () => {
    const t = fakeTmux({
      'new-window': () => {
        throw new Error('command too long');
      },
    });
    expect(await resumeNode(makeDeps(t.run), node(), {})).toEqual({
      status: 500,
      body: { error: 'spawn_failed', message: 'command too long' },
    });
  });

  it('NOTESD_TMUX_SOCKET puts -S <socket> in front of every tmux call', async () => {
    const t = fakeTmux();
    await resumeNode(makeDeps(t.run, { tmuxSocket: '/run/tmux.sock' }), node(), {});
    expect(t.calls.length).toBeGreaterThan(0);
    for (const call of t.calls) expect(call.slice(0, 2)).toEqual(['-S', '/run/tmux.sock']);
  });
});

describe('resolveCwd (deleted worktree)', () => {
  const gone = node({ cwd: '/home/u/.worktrees/mcp-notes/wall-editing' });

  it('prefers the newest existing non-worktree cwd of the same repo, and reports original_cwd', async () => {
    const t = fakeTmux();
    const deps = makeDeps(t.run, {
      dirs: ['/home/u/mcp-notes', '/home/u/.worktrees/mcp-notes/other', '/home/u'],
      repoCwds: async () => ['/home/u/.worktrees/mcp-notes/other', '/home/u/old-clone', '/home/u/mcp-notes'],
    });
    expect(await resolveCwd(deps, gone)).toEqual({ cwd: '/home/u/mcp-notes', missing: true });
    const out = await resumeNode(deps, gone, {});
    expect(out).toEqual({
      status: 200,
      body: {
        action: 'resumed',
        window: 'note:3',
        cwd: '/home/u/mcp-notes',
        original_cwd: '/home/u/.worktrees/mcp-notes/wall-editing',
      },
    });
  });

  it('falls back to ~/<repo>, then $HOME', async () => {
    const t = fakeTmux();
    expect(await resolveCwd(makeDeps(t.run, { dirs: ['/home/u/mcp-notes'] }), gone)).toEqual({
      cwd: '/home/u/mcp-notes',
      missing: true,
    });
    expect(await resolveCwd(makeDeps(t.run, { dirs: [] }), gone)).toEqual({ cwd: '/home/u', missing: true });
    expect(await resolveCwd(makeDeps(t.run, { dirs: [] }), node({ cwd: null, repo: null }))).toEqual({
      cwd: '/home/u',
      missing: false,
    });
  });

  it('a failing repoCwds is only a hint', async () => {
    const t = fakeTmux();
    const deps = makeDeps(t.run, {
      dirs: ['/home/u/mcp-notes'],
      repoCwds: async () => {
        throw new Error('db down');
      },
    });
    expect(await resolveCwd(deps, gone)).toEqual({ cwd: '/home/u/mcp-notes', missing: true });
  });
});

describe('createSessionResumer', () => {
  function resumerWith(deps: ResumeDeps, nodes: ResumeNode[]) {
    return createSessionResumer({
      normalize: (input) => {
        const s = input.trim().toUpperCase().replace('-', '');
        return /^[0-9A-Z]{4}$/.test(s) ? `${s.slice(0, 2)}-${s.slice(2)}` : null;
      },
      lookup: async (id) => nodes.find((n) => n.nodeId === id) ?? null,
      deps,
    });
  }

  it('a non-id and an unknown id are not_found', async () => {
    const t = fakeTmux();
    const r = resumerWith(makeDeps(t.run), [node()]);
    expect(await r.resume('not an id', {})).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await r.resume('ZZ-ZZ', {})).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(t.calls).toEqual([]);
  });

  it('a second click before the registry lists the new process focuses the window it just opened', async () => {
    const clock = { t: 1_000_000 };
    const t = fakeTmux({ 'list-panes': () => '%1\n%12\n' });
    const r = resumerWith(makeDeps(t.run, { clock }), [node()]);
    expect((await r.resume('a03g', {})).body).toMatchObject({ action: 'resumed' });
    clock.t += 5_000;
    expect((await r.resume('A0-3G', {})).body).toMatchObject({ action: 'focused' });
    expect(t.sub('new-window')).toHaveLength(1);
    clock.t += RECENT_SPAWN_MS;
    expect((await r.resume('A0-3G', {})).body).toMatchObject({ action: 'resumed' });
    expect(t.sub('new-window')).toHaveLength(2);
  });

  it('builds lazy deps once', async () => {
    const t = fakeTmux();
    let built = 0;
    const r = createSessionResumer({
      normalize: () => 'A0-3G',
      lookup: async () => node(),
      deps: () => {
        built += 1;
        return makeDeps(t.run);
      },
    });
    expect(built).toBe(0);
    await r.resume('A0-3G', {});
    await r.resume('A0-3G', { fresh: true });
    expect(built).toBe(1);
  });
});
```
**Impact:** Runs under `npm test`. No tmux, no filesystem, no DB.

### Step 8: Route unit test
**File:** `tests/unit/sessions/sessionResumeRoute.test.ts` (new)
**Code:**
```ts
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../../src/deps.js';
import { sessionResumeRoutes } from '../../../src/http/sessionResume.js';
import type { ResumeOutcome, ResumeRequest, SessionResumer } from '../../../src/sessions/resume.js';

const OWN = 'http://localhost';

function fakeResumer(out: ResumeOutcome) {
  const resume = vi.fn(async (_id: string, _req: ResumeRequest): Promise<ResumeOutcome> => out);
  return { resume } satisfies SessionResumer;
}

function post(app: ReturnType<typeof sessionResumeRoutes>, body: string | undefined, origin: string | undefined = OWN) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin !== undefined) headers.Origin = origin;
  return Promise.resolve(
    app.request('/api/sessions/a03g/resume', { method: 'POST', headers, ...(body !== undefined ? { body } : {}) }),
  );
}

/** The route never reads deps when a resumer is injected. */
const NO_DEPS = {} as AppDeps;

describe('POST /api/sessions/:nodeId/resume', () => {
  it('refuses a missing or foreign Origin before touching the resumer', async () => {
    const r = fakeResumer({ status: 200, body: { action: 'resumed' } });
    const app = sessionResumeRoutes(NO_DEPS, { resumer: r });
    for (const origin of [undefined, 'http://evil.example', 'http://localhost:5173']) {
      const res = await post(app, '{}', origin);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden_origin' });
    }
    expect(r.resume).not.toHaveBeenCalled();
  });

  it('an empty body is {}; the raw node id is passed through', async () => {
    const r = fakeResumer({ status: 200, body: { action: 'resumed', window: 'note:4', cwd: '/x' } });
    const res = await post(sessionResumeRoutes(NO_DEPS, { resumer: r }), undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: 'resumed', window: 'note:4', cwd: '/x' });
    expect(r.resume).toHaveBeenCalledWith('a03g', {});
  });

  it('passes prompt and fresh', async () => {
    const r = fakeResumer({ status: 200, body: { action: 'spawned' } });
    await post(sessionResumeRoutes(NO_DEPS, { resumer: r }), JSON.stringify({ prompt: 'go', fresh: true }));
    expect(r.resume).toHaveBeenCalledWith('a03g', { prompt: 'go', fresh: true });
  });

  it('400 for bad JSON, unknown keys, wrong types and an over-long prompt', async () => {
    const r = fakeResumer({ status: 200, body: { action: 'resumed' } });
    const app = sessionResumeRoutes(NO_DEPS, { resumer: r });
    expect(await (await post(app, '{nope')).json()).toEqual({ error: 'invalid_json' });
    for (const body of [{ fresh: 'yes' }, { promt: 'typo' }, { prompt: 'x'.repeat(4001) }, { prompt: null }]) {
      const res = await post(app, JSON.stringify(body));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    }
    expect(r.resume).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 404, body: { error: 'not_found' } }],
    [{ status: 404, body: { error: 'not_on_this_machine', host: 'GPD' } }],
    [{ status: 409, body: { error: 'no_tmux' } }],
    [{ status: 409, body: { error: 'live_outside_tmux', pid: 7 } }],
    [{ status: 500, body: { error: 'spawn_failed', message: 'boom' } }],
  ] as Array<[ResumeOutcome]>)('passes the outcome through: %j', async (out) => {
    const res = await post(sessionResumeRoutes(NO_DEPS, { resumer: fakeResumer(out) }), '{}');
    expect(res.status).toBe(out.status);
    expect(await res.json()).toEqual(out.body);
  });
});
```

### Step 9: MCP tool unit test
**File:** `tests/unit/sessions/sessionResumeTool.test.ts` (new)
**Code:**
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { registerSessionResumeTool } from '../../../src/mcp/sessionTools.js';
import type { ResumeOutcome, ResumeRequest, SessionResumer } from '../../../src/sessions/resume.js';

async function connect(resumer: SessionResumer | undefined) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerSessionResumeTool(server, resumer !== undefined ? { sessionResume: resumer } : {});
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function text(res: unknown): string {
  return ((res as { content: Array<{ text: string }> }).content[0] ?? { text: '' }).text;
}

describe('session_resume tool', () => {
  it('returns the action as JSON and passes prompt / fresh through', async () => {
    const resume = vi.fn(
      async (_id: string, _req: ResumeRequest): Promise<ResumeOutcome> => ({
        status: 200,
        body: { action: 'messaged', window: 'note:1' },
      }),
    );
    const { client, close } = await connect({ resume });
    const res = await client.callTool({ name: 'session_resume', arguments: { node_id: 'a03g', prompt: 'go on' } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res))).toEqual({ action: 'messaged', window: 'note:1' });
    expect(resume).toHaveBeenCalledWith('a03g', { prompt: 'go on', fresh: undefined });
    await close();
  });

  it('not_on_this_machine names the host', async () => {
    const { client, close } = await connect({
      resume: async () => ({ status: 404, body: { error: 'not_on_this_machine', host: 'GPD' } }),
    });
    const res = await client.callTool({ name: 'session_resume', arguments: { node_id: 'A0-3G' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('not_on_this_machine: session A0-3G ran on GPD; resume it on that machine');
    await close();
  });

  it('without a resumer the tool says it is unavailable', async () => {
    const { client, close } = await connect(undefined);
    const res = await client.callTool({ name: 'session_resume', arguments: { node_id: 'A0-3G' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('not available');
    await close();
  });
});
```

### Step 10: Chat allowlist test
**File:** `tests/unit/chat-status.test.ts` (as Phase 7 left it; its `allowedChatTools` test, currently `:8-25`)
**Change:**
- Raise the expected session-tool count by one: Phase 7's
  `expect(SESSION_TOOL_NAMES).toHaveLength(4)` and `expect(tools).toHaveLength(19 + 4 + 15 + 2)`
  become `5` and `19 + 5 + 15 + 2` (41 names).
- Add `expect(tools).toContain('mcp__notes__session_resume');` after the other `toContain` lines.
- In the `captionForToolUse` `it.each` table, add the row
  `[n('session_resume'), { node_id: 'A0-3G' }, 'opening a session in tmux'],`.
- Change the test title's tool count to match.

### Step 11: Integration test against the real repo
**File:** `tests/integration/sessions.resume.int.test.ts` (new)
**Change:** Checks that `sessionLookup(new SessionsRepo(db))` + `toResumeNode` read Phase 1's
real columns, and that the host gate works on a real row. Rows are inserted with Drizzle (test
setup, not app code) and deleted afterwards.
**Code:**
```ts
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { ccSessions } from '../../src/db/schema.js';
import { sessionLookup } from '../../src/http/sessionResume.js';
import { generateNodeId, normalizeNodeId } from '../../src/sessions/ids.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createSessionResumer, type CommandRunner, type ResumeDeps } from '../../src/sessions/resume.js';
import { closeTestDb, openTestDb } from './setup.js';

const db = openTestDb();
const created: string[] = [];

afterAll(async () => {
  if (created.length > 0) await db.delete(ccSessions).where(inArray(ccSessions.sessionId, created));
  await closeTestDb(db);
});

async function insert(host: string): Promise<{ sessionId: string; nodeId: string }> {
  const sessionId = randomUUID();
  const nodeId = generateNodeId();
  created.push(sessionId);
  await db.insert(ccSessions).values({
    sessionId,
    nodeId,
    host,
    repo: 'mcp-notes',
    cwd: '/nonexistent/worktree',
    name: 'impl-x-p9',
    aiTitle: 'resume test',
    summary: 'A summary.',
    transcriptPath: `/home/u/.claude/projects/x/${sessionId}.jsonl`,
    commits: [{ sha: 'abc123def4567890', subject: 'feat: resume', at: null }],
    planDocs: ['docs/plans/PROJECT_SESSION_GRAPH_PLAN.md'],
    entrypoint: 'cli',
  });
  return { sessionId, nodeId };
}

function deps(run: CommandRunner): ResumeDeps {
  return {
    host: 'this-host',
    run,
    tmuxBin: 'tmux',
    tmuxSocket: null,
    claudeBin: '/opt/claude',
    homeDir: '/home/u',
    worktreesDir: '/home/u/.worktrees',
    live: async () => null,
    isDir: async (p) => p === '/home/u',
    repoCwds: async () => [],
    now: () => Date.now(),
  };
}

describe('session resume against cc_sessions', () => {
  const repo = new SessionsRepo(db);
  const lookup = sessionLookup(repo);

  it('maps a real row into a ResumeNode', async () => {
    const { sessionId, nodeId } = await insert('this-host');
    const node = await lookup(nodeId);
    expect(node).toMatchObject({
      sessionId,
      nodeId,
      host: 'this-host',
      repo: 'mcp-notes',
      cwd: '/nonexistent/worktree',
      name: 'impl-x-p9',
      title: 'resume test',
      summary: 'A summary.',
      commits: ['abc123def456 feat: resume'],
      planDocs: ['docs/plans/PROJECT_SESSION_GRAPH_PLAN.md'],
    });
  });

  it('resumes a local row (cwd gone -> $HOME fallback) and refuses another host', async () => {
    const local = await insert('this-host');
    const remote = await insert('GPD');
    const calls: string[][] = [];
    const run: CommandRunner = async (_cmd, args) => {
      calls.push([...args]);
      if (args[0] === 'list-sessions') return '10 note\n';
      if (args[0] === 'new-window') return 'note:5 %30\n';
      return '';
    };
    const resumer = createSessionResumer({ normalize: normalizeNodeId, lookup, deps: deps(run) });
    expect(await resumer.resume(local.nodeId.toLowerCase().replace('-', ''), {})).toEqual({
      status: 200,
      body: { action: 'resumed', window: 'note:5', cwd: '/home/u', original_cwd: '/nonexistent/worktree' },
    });
    const before = calls.length;
    expect(await resumer.resume(remote.nodeId, {})).toEqual({
      status: 404,
      body: { error: 'not_on_this_machine', host: 'GPD' },
    });
    expect(calls.length).toBe(before);
    let unused = generateNodeId();
    while ((await repo.getByNodeId(unused)) !== null) unused = generateNodeId();
    expect(await resumer.resume(unused, {})).toEqual({ status: 404, body: { error: 'not_found' } });
  });
});
```
**Impact:** Runs under `npm run test:int` (`openTestDb(): Db` / `closeTestDb(db): Promise<void>`,
`tests/integration/setup.ts:30,34`). The unknown-id probe is drawn from `generateNodeId()` and
confirmed absent, so a shared test DB cannot make it flaky.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npx vitest run tests/unit/sessions/resume.test.ts tests/unit/sessions/sessionResumeRoute.test.ts tests/unit/sessions/sessionResumeTool.test.ts tests/unit/chat-status.test.ts tests/unit/mcp.instructions.test.ts`, then `npm test`, then `npm run test:int`.
**Manual check** (on the Lenovo, after `npm run build` and a daemon restart; the user's tmux server running):
1. Pick a node id that is not live, then
   `curl -s -X POST -H 'Origin: http://localhost:7317' -H 'content-type: application/json' localhost:7317/api/sessions/<id>/resume -d '{}'`.
   A new window named after the session opens in the most recently attached tmux session and
   the old conversation is on screen. The response is `{"action":"resumed","window":"note:N","cwd":...}`.
2. Repeat the same curl right away: `{"action":"focused"}` and no second window.
3. With `-d '{"prompt":"say hi"}'` on that now-live node: the text shows up in its input box
   and is submitted: `messaged`.
4. A node whose worktree was deleted: it opens in the main checkout, with `original_cwd` in the response.
5. Without the `Origin` header: 403.
6. From Claude Code: `mcp__notes__session_resume {node_id}` behaves the same.

**Exit criteria:** every branch (cross-host, live → focused/messaged, live outside tmux, not
live → resumed, fresh → spawned with `CC_PARENT_SESSION`, no tmux, deleted cwd, double click,
`-S` socket) is covered by fake-runner tests. The route is same-origin only and returns the
documented codes. `session_resume` is registered and in `allowedChatTools()`. The `--resume`
measurement is recorded in this plan and in the `resume.ts` header comment.

## Handoffs

- **Phase 3 (ingest), from M3:** a session resumed from another cwd keeps appending to its
  *original* transcript file. Records after the resume carry the *new* `cwd`. Ingest must not
  move a session's `repo` (or `cwd`) to whatever the latest record says. Resolve repo from the
  first record (or keep the stored one once set). Otherwise a worktree session resumed in the
  main checkout changes repo, and one resumed from `$HOME` loses its repo. The same transcript
  path stays the key, so offsets are unaffected.
- **Phase 3 (registry):** this phase calls `readLiveSessions(claudeHome)` and reads `pid`,
  `sessionId` and `tmux`. If the export has another name or shape, the reconciler edits the
  `live:` adapter in `src/http/sessionResume.ts` (Step 2). Only liveness-checked entries
  should come back, since a stale pid file would make a dead session look "live outside tmux".
- **Phase 5:** a wall-spawned fresh session carries `CC_PARENT_SESSION=<node sid>`, set
  through `env` in the window's command, not through `tmux -e`. Phase 5's SessionStart hook
  should link it as `env` (its `parentFrom`). A resumed session has `CC_PARENT_SESSION`
  scrubbed. Its SessionStart fires with `source: "resume"` and must not change the parent link.
- **Phase 7 / reconciler:** `src/mcp/instructions.ts` (Phase 7) should mention
  `session_resume` in the sessions paragraph. This phase does not edit that file.
- **Phase 11:** response shapes as in the Interface Contract. `window` is omitted, not null,
  when unknown. Extra error codes the panel may want to word: `no_tmux` (409),
  `live_outside_tmux` (409, `pid`), `spawn_failed` (500, `message`), `invalid_body` (400).
  The prompt limit is 4000 characters.
- **Phase 14:** README rows for `POST /api/sessions/:nodeId/resume` and the `session_resume`
  tool. Env table: `NOTESD_TMUX_SOCKET` (optional; tmux socket path, default tmux's own) and
  `NOTESD_TMUX_BIN` (default `tmux`). CLAUDE.md: resume uses the user's default tmux server
  and the most recently attached session.

## Rollback

Revert this phase's commit. That removes `src/sessions/resume.ts`,
`src/http/sessionResume.ts`, the three new unit tests and the int test, and restores
`app.ts`, `tools.ts`, `sessionTools.ts`, `status.ts` and `chat-status.test.ts`. No schema or
data change. Windows opened while the phase was live are ordinary tmux windows and stay open.
