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
