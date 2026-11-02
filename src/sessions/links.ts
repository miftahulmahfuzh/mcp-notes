/**
 * Heuristic parent links (iteration 8, R3).
 *
 * Claude Code does not record who started a session. For sessions spawned before CC_PARENT_SESSION
 * and the SessionStart hook existed (phases 2 and 5), the parent is recovered from the parent's own
 * transcript: a Bash tool_use running `swarm.py spawn --slug S --phase N` / `swarm.py launch --name X`,
 * or a `SendMessage {to: X}`. The child is the session named X on the same host that started inside
 * a bounded window around that tool_use, after the parent itself started, in the same cwd or repo.
 * Links are written through SessionsRepo.setParent(child, parent, 'heuristic'), which never
 * replaces an env or hook link; this module also skips any child that already has a parent.
 *
 * Two paths:
 * - backfill: once per host (app_settings marker), after the ingester's first full pass, re-read
 *   every transcript of this host (streamed, substring-prefiltered) and link everything at once.
 *   Spawn intents are not stored in cc_sessions, so this is the only way to see historical ones.
 * - live: the ingester hands each committed batch's parsed records to onBatch; intents found there
 *   wait in memory until their child shows up or their window has passed.
 *
 * Naming mirrors ~/claude-commands/skills/swarm/swarm.py (slugify, child_name, MAX_NAME).
 */
import { open, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';

/** Bump to make every host re-run the backfill scan once (e.g. after the matching rules improve). */
export const LINKS_BACKFILL_VERSION = 1;
/** app_settings key prefix; the full key is `${LINKS_MARKER_PREFIX}${host}`. */
export const LINKS_MARKER_PREFIX = 'sessions.links.backfill.';

/** A spawned child's first record comes 2-4 s after the tool_use (measured); allow clock slop before... */
export const SPAWN_BEFORE_MS = 10_000;
/** ...and slow commands (report/verify/reap run first, trust checks, `sleep`) after. */
export const SPAWN_AFTER_MS = 5 * 60_000;
/** A message goes to a session that is already running: it started at most this long before. */
export const MESSAGE_BEFORE_MS = 6 * 60 * 60_000;
export const MESSAGE_AFTER_MS = 10_000;
/** Live path: an unresolved intent is kept this long after its window closes, then dropped. */
export const PENDING_RETAIN_MS = 10 * 60_000;
/** Live path: never hold more unresolved intents than this (oldest dropped first). */
export const PENDING_CAP = 2_000;
export const DEFAULT_LINK_DEBOUNCE_MS = 2_000;
/** close() waits this long for an in-flight drain or backfill; well under main.ts's 10 s exit. */
export const DEFAULT_LINK_CLOSE_GRACE_MS = 5_000;
/** swarm.py MAX_NAME: session.py's cap on a session name. */
export const SWARM_MAX_NAME = 60;

export type IntentKind = 'spawn' | 'launch' | 'message';

/** One "this session started (or addressed) a session named `name`" fact from a transcript. */
export interface SpawnIntent {
  parentSessionId: string;
  kind: IntentKind;
  name: string;
  /** Timestamp of the assistant record carrying the tool_use. */
  at: Date;
  /** The child's cwd when the command states it (`launch --cwd`, or the `cd` before `launch`). */
  cwd: string | null;
}

export interface ParsedSwarmLaunch {
  kind: 'spawn' | 'launch';
  name: string;
  cwd: string | null;
}

/** The cc_sessions columns the linker reads. */
export interface LinkSession {
  sessionId: string;
  host: string;
  repo: string | null;
  cwd: string | null;
  name: string | null;
  customTitle: string | null;
  startedAt: Date | null;
  parentSessionId: string | null;
  parentLinkSource: string | null;
}

export interface PlannedLink {
  childSessionId: string;
  parentSessionId: string;
  intent: SpawnIntent;
}

export interface LinkPlan {
  links: PlannedLink[];
  /** Intents that found their child (linked now, or the child already had a parent). */
  resolved: Set<SpawnIntent>;
}

export interface TranscriptRef {
  sessionId: string;
  transcriptPath: string;
}

/** Everything the linker needs from the database; dbLinkStore is the real one, tests fake it. */
export interface LinkStore {
  sessionsByIds(ids: readonly string[]): Promise<LinkSession[]>;
  sessionsByNames(host: string, names: readonly string[]): Promise<LinkSession[]>;
  transcriptsOnHost(host: string): Promise<TranscriptRef[]>;
  setParent(childSessionId: string, parentSessionId: string): Promise<void>;
  readSetting(key: string): Promise<unknown>;
  writeSetting(key: string, value: unknown): Promise<void>;
}

/**
 * The slice of SessionsRepo the linker writes through (phase 1 owns the precedence rule and the
 * app_settings accessors; `SessionsRepo` satisfies this structurally).
 */
export interface HeuristicParentWriter {
  setParent(sessionId: string, parentSessionId: string, source: 'heuristic'): Promise<unknown>;
  getSetting(key: string): Promise<unknown | null>;
  putSetting(key: string, value: unknown): Promise<void>;
}

export interface LinkReport {
  intents: number;
  matched: number;
  linked: number;
}

/** What the ingester hands an observer after a batch commits (phase 3's IngestObserver.onBatch). */
export interface IngestBatchLike {
  sessionId: string;
  host?: string;
  records: readonly unknown[];
}

export interface LinkWorker {
  /** Ingest observer: extract intents from a committed batch and schedule a drain. Never throws. */
  onBatch(batch: IngestBatchLike): void;
  /** Ingest observer: a full pass finished. Runs the once-per-host backfill, then drains. Never rejects. */
  onPassComplete(pass?: { initial?: boolean }): Promise<void>;
  /** The backfill scan; null when the marker says it already ran (or the worker closed mid-way). */
  backfill(): Promise<LinkReport | null>;
  /** Resolve pending live intents now (tests; the debounce calls it otherwise). */
  drainNow(): Promise<LinkReport>;
  pendingCount(): number;
  /** Stops scheduling, then waits at most closeGraceMs for the in-flight drain/backfill. */
  close(): Promise<void>;
}

export interface LinkWorkerOptions {
  store: LinkStore;
  /** This daemon's host, as written in cc_sessions.host by the ingester. */
  host: string;
  /** Home used to expand `~` and `$HOME` in commands. Default os.homedir(). */
  home?: string;
  now?: () => Date;
  debounceMs?: number;
  closeGraceMs?: number;
  log?: (line: string) => void;
  onError?: (what: string, err: unknown) => void;
}

// ---------------------------------------------------------------------------------------------
// swarm.py naming

/** swarm.py `slugify`: runs of disallowed characters become '-', '-' and '.' trimmed, capped. */
export function swarmSlugify(name: string): string {
  const out = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return out.slice(0, SWARM_MAX_NAME) || 'swarm';
}

/** swarm.py `child_name`: the slug is truncated, never the `-pN` tail. */
export function swarmChildName(prefix: string, slug: string, phase: number): string {
  const tail = `-p${phase}`;
  const head = `${prefix}-${swarmSlugify(slug)}`;
  return head.slice(0, SWARM_MAX_NAME - tail.length) + tail;
}

// ---------------------------------------------------------------------------------------------
// shell parsing (only as much bash as the measured commands use)

interface ShellState {
  cwd: string | null;
  home: string;
  vars: Map<string, string>;
  loops: Map<string, string[]>;
}

const HEREDOC_RE = /(?<!<)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VAR_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const PYTHON_RE = /(^|\/)python[0-9.]*$/;
const SWARM_SCRIPT_RE = /(^|\/)swarm\.py$/;
const BRACE_RANGE_RE = /^\{(\d+)\.\.(\d+)\}$/;
const PHASE_RE = /^\d+$/;
const SEGMENT_OPS = new Set(['\n', ';', '&', '|', '(', ')']);
/** Words that may precede the command in a segment and change nothing we care about. */
const SKIP_LEADING = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', 'time', '!', '{', '}', 'exec', 'command', 'nohup', 'env', 'export', 'builtin']);
const VALUE_FLAGS = new Set(['name', 'slug', 'phase', 'prefix', 'cwd', 'prompt', 'repo', 'permission-mode', 'model']);
const MAX_RANGE = 200;

/** Drops heredoc bodies (they quote whole briefs, swarm commands included) up to their terminator. */
export function stripHeredocs(command: string): string {
  const out: string[] = [];
  let terminator: string | null = null;
  for (const line of command.split('\n')) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    out.push(line);
    const m = HEREDOC_RE.exec(line);
    if (m) terminator = m[2]!;
  }
  return out.join('\n');
}

/**
 * Splits a command into segments (at newline ; & | ( )) of words, honouring single and double
 * quotes, backslash escapes, backslash-newline continuations and `#` comments. Redirections stay
 * as ordinary words; the flag parser ignores anything that is not a flag it knows.
 */
export function tokenizeShell(input: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let cur = '';
  let has = false;
  const flushWord = (): void => {
    if (has) words.push(cur);
    cur = '';
    has = false;
  };
  const flushSegment = (): void => {
    flushWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      const stop = end < 0 ? input.length : end;
      cur += input.slice(i + 1, stop);
      has = true;
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < input.length && input[j] !== '"') {
        const d = input[j]!;
        if (d === '\\' && j + 1 < input.length) {
          const next = input[j + 1]!;
          if (next === '\n') {
            // continuation inside quotes: removed
          } else if (next === '$' || next === '`' || next === '"' || next === '\\') {
            cur += next;
          } else {
            cur += d + next;
          }
          j += 2;
          continue;
        }
        cur += d;
        j += 1;
      }
      has = true;
      i = j + 1;
      continue;
    }
    if (c === '\\') {
      const next = input[i + 1];
      if (next !== undefined && next !== '\n') {
        cur += next;
        has = true;
      }
      i += 2;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      flushWord();
      i += 1;
      continue;
    }
    if (SEGMENT_OPS.has(c)) {
      flushSegment();
      i += 1;
      continue;
    }
    if (c === '#' && !has) {
      const nl = input.indexOf('\n', i);
      i = nl < 0 ? input.length : nl;
      continue;
    }
    cur += c;
    has = true;
    i += 1;
  }
  flushSegment();
  return segments;
}

function lookupVar(name: string, state: ShellState): string[] | null {
  const v = state.vars.get(name);
  if (v !== undefined) return [v];
  const loop = state.loops.get(name);
  if (loop) return loop;
  if (name === 'HOME') return [state.home];
  return null;
}

/** Expands `~`, `$VAR`, `${VAR}` (loop variables fan out). Null when a variable is unknown. */
function expandWord(word: string, state: ShellState): string[] | null {
  let w = word;
  if (w === '~' || w.startsWith('~/')) w = state.home + w.slice(1);
  const refs = [...w.matchAll(VAR_REF_RE)];
  if (refs.length === 0) return [w];
  let results = [w];
  for (const ref of refs) {
    const name = ref[1] ?? ref[2];
    if (name === undefined) return null;
    const values = lookupVar(name, state);
    if (values === null) return null;
    const token = ref[0];
    results = results.flatMap((r) => values.map((v) => r.replace(token, () => v)));
  }
  return results;
}

function expandOne(word: string | undefined, state: ShellState): string | null {
  if (word === undefined) return null;
  const values = expandWord(word, state);
  return values && values.length === 1 ? values[0]! : null;
}

function resolveDir(word: string, state: ShellState): string | null {
  const dir = expandOne(word, state);
  if (dir === null || dir === '') return null;
  if (path.posix.isAbsolute(dir)) return path.posix.resolve(dir);
  if (state.cwd === null) return null;
  return path.posix.resolve(state.cwd, dir);
}

function applyCd(target: string | undefined, state: ShellState): void {
  if (target === undefined) {
    state.cwd = state.home;
    return;
  }
  if (target === '-') {
    state.cwd = null;
    return;
  }
  state.cwd = resolveDir(target, state);
}

function recordLoop(rest: readonly string[], state: ShellState): void {
  const name = rest[0];
  if (name === undefined || !VAR_NAME_RE.test(name) || rest[1] !== 'in') return;
  const values: string[] = [];
  for (const word of rest.slice(2)) {
    const range = BRACE_RANGE_RE.exec(word);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (Math.abs(b - a) > MAX_RANGE) continue;
      const step = a <= b ? 1 : -1;
      for (let n = a; step > 0 ? n <= b : n >= b; n += step) values.push(String(n));
      continue;
    }
    const expanded = expandWord(word, state);
    if (expanded) values.push(...expanded);
  }
  state.vars.delete(name);
  state.loops.set(name, values);
}

/** Index of the swarm.py word when the segment runs it (directly or via python), else -1. */
function swarmScriptIndex(words: readonly string[], start: number, state: ShellState): number {
  const first = words[start];
  if (first === undefined) return -1;
  let i = start;
  if (PYTHON_RE.test(first)) {
    i = start + 1;
    while (i < words.length && words[i]!.startsWith('-')) i += 1;
  }
  const script = expandOne(words[i], state);
  return script !== null && SWARM_SCRIPT_RE.test(script) ? i : -1;
}

function parseSwarmArgs(args: readonly string[], state: ShellState): ParsedSwarmLaunch[] {
  const sub = args[0];
  if (sub !== 'spawn' && sub !== 'launch') return [];
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 1; i < args.length; i += 1) {
    const w = args[i]!;
    if (w === '-h') {
      bools.add('help');
      continue;
    }
    if (!w.startsWith('--')) continue;
    const eq = w.indexOf('=');
    const key = eq < 0 ? w.slice(2) : w.slice(2, eq);
    if (VALUE_FLAGS.has(key)) {
      if (eq >= 0) {
        flags.set(key, w.slice(eq + 1));
      } else if (i + 1 < args.length) {
        flags.set(key, args[i + 1]!);
        i += 1;
      }
    } else {
      bools.add(key);
    }
  }
  if (bools.has('dry-run') || bools.has('help')) return [];

  if (sub === 'launch') {
    const raw = expandOne(flags.get('name'), state);
    if (raw === null || raw.trim() === '') return [];
    const cwdFlag = flags.get('cwd');
    const cwd = cwdFlag !== undefined ? resolveDir(cwdFlag, state) : state.cwd;
    return [{ kind: 'launch', name: swarmSlugify(raw), cwd }];
  }

  const slug = expandOne(flags.get('slug'), state);
  const prefixFlag = flags.get('prefix');
  const prefix = prefixFlag !== undefined ? expandOne(prefixFlag, state) : 'impl';
  const phaseWord = flags.get('phase');
  if (slug === null || prefix === null || phaseWord === undefined) return [];
  const phases = (expandWord(phaseWord, state) ?? []).filter((p) => PHASE_RE.test(p)).map(Number);
  const cwdFlag = flags.get('cwd');
  const cwd = cwdFlag !== undefined ? resolveDir(cwdFlag, state) : null;
  return phases.map((n) => ({ kind: 'spawn' as const, name: swarmChildName(prefix, slug, n), cwd }));
}

/**
 * The sessions a Bash command starts through swarm.py (`spawn` or `launch`, not `--dry-run` or
 * `--help`). `cwd` is the tool call's working directory; `cd` segments before the launch move it.
 */
export function parseSwarmCommand(command: string, opts: { cwd: string | null; home: string }): ParsedSwarmLaunch[] {
  if (!command.includes('swarm.py')) return [];
  const state: ShellState = { cwd: opts.cwd, home: opts.home, vars: new Map(), loops: new Map() };
  const out: ParsedSwarmLaunch[] = [];
  for (const words of tokenizeShell(stripHeredocs(command))) {
    let k = 0;
    while (k < words.length && SKIP_LEADING.has(words[k]!)) k += 1;
    while (k < words.length) {
      const m = ASSIGN_RE.exec(words[k]!);
      if (!m) break;
      const value = expandOne(m[2]!, state);
      if (value !== null) state.vars.set(m[1]!, value);
      else state.vars.delete(m[1]!);
      state.loops.delete(m[1]!);
      k += 1;
      while (k < words.length && SKIP_LEADING.has(words[k]!)) k += 1;
    }
    const cmd = words[k];
    if (cmd === undefined) continue;
    if (cmd === 'for') {
      recordLoop(words.slice(k + 1), state);
      continue;
    }
    if (cmd === 'cd') {
      applyCd(words[k + 1], state);
      continue;
    }
    if (cmd === 'unset') {
      for (const name of words.slice(k + 1)) {
        state.vars.delete(name);
        state.loops.delete(name);
      }
      continue;
    }
    const at = swarmScriptIndex(words, k, state);
    if (at < 0) continue;
    out.push(...parseSwarmArgs(words.slice(at + 1), state));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// transcript records -> intents

const TARGET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const IGNORED_TARGETS = new Set(['main', 'parent', 'user', 'all', 'lead', 'team-lead']);
const UNPARSED_TO_RE = /"to"\s*:\s*"([^"]+)"/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseTimestamp(v: unknown): Date | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The session name a SendMessage addresses, or null for sockets, agent ids we cannot name, 'main'... */
export function sendMessageTarget(input: unknown): string | null {
  if (!isObject(input)) return null;
  let to: string | null = null;
  if (typeof input.to === 'string') to = input.to;
  else if (typeof input.recipient === 'string') to = input.recipient;
  else if (isObject(input.__unparsedToolInput) && typeof input.__unparsedToolInput.raw === 'string') {
    to = UNPARSED_TO_RE.exec(input.__unparsedToolInput.raw)?.[1] ?? null;
  }
  if (to === null) return null;
  const name = to.trim();
  if (!TARGET_NAME_RE.test(name) || IGNORED_TARGETS.has(name.toLowerCase())) return null;
  return name;
}

/**
 * Spawn intents in one transcript record (an `assistant` record's Bash and SendMessage tool_uses).
 * `parentSessionId` defaults to the record's sessionId; callers pass the transcript's owner.
 */
export function extractIntents(record: unknown, ctx: { parentSessionId?: string; home: string }): SpawnIntent[] {
  if (!isObject(record) || record.type !== 'assistant') return [];
  const message = record.message;
  if (!isObject(message) || !Array.isArray(message.content)) return [];
  const parent = ctx.parentSessionId ?? (typeof record.sessionId === 'string' ? record.sessionId : null);
  if (!parent) return [];
  const at = parseTimestamp(record.timestamp);
  if (!at) return [];
  const cwd = typeof record.cwd === 'string' && record.cwd !== '' ? record.cwd : null;
  const out: SpawnIntent[] = [];
  for (const item of message.content) {
    if (!isObject(item) || item.type !== 'tool_use') continue;
    const input = item.input;
    if (item.name === 'Bash' && isObject(input) && typeof input.command === 'string') {
      for (const p of parseSwarmCommand(input.command, { cwd, home: ctx.home })) {
        out.push({ parentSessionId: parent, kind: p.kind, name: p.name, at, cwd: p.cwd });
      }
    } else if (item.name === 'SendMessage') {
      const name = sendMessageTarget(input);
      if (name !== null) out.push({ parentSessionId: parent, kind: 'message', name, at, cwd: null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// matching

const KIND_RANK: Record<IntentKind, number> = { spawn: 2, launch: 2, message: 1 };

export function intentWindow(intent: SpawnIntent): { from: Date; to: Date } {
  const t = intent.at.getTime();
  return intent.kind === 'message'
    ? { from: new Date(t - MESSAGE_BEFORE_MS), to: new Date(t + MESSAGE_AFTER_MS) }
    : { from: new Date(t - SPAWN_BEFORE_MS), to: new Date(t + SPAWN_AFTER_MS) };
}

/** Could `child` be the session `intent` (found in `parent`'s transcript) started or addressed? */
export function isPlausibleChild(intent: SpawnIntent, parent: LinkSession, child: LinkSession): boolean {
  if (child.sessionId === parent.sessionId) return false;
  if (child.host !== parent.host) return false;
  if (child.name !== intent.name && child.customTitle !== intent.name) return false;
  if (child.startedAt === null || parent.startedAt === null) return false;
  const started = child.startedAt.getTime();
  if (started <= parent.startedAt.getTime()) return false;
  if (parent.parentSessionId === child.sessionId) return false;
  const w = intentWindow(intent);
  if (started < w.from.getTime() || started > w.to.getTime()) return false;
  if (intent.cwd !== null && child.cwd === intent.cwd) return true;
  if (parent.repo !== null && child.repo !== null && parent.repo !== child.repo) return false;
  return true;
}

/** The child an intent points at: earliest after a spawn/launch, latest before a message. */
export function matchIntent(intent: SpawnIntent, parent: LinkSession, candidates: readonly LinkSession[]): LinkSession | null {
  const ok = candidates.filter((c) => isPlausibleChild(intent, parent, c));
  if (ok.length === 0) return null;
  ok.sort((a, b) =>
    intent.kind === 'message'
      ? b.startedAt!.getTime() - a.startedAt!.getTime()
      : a.startedAt!.getTime() - b.startedAt!.getTime(),
  );
  return ok[0]!;
}

/**
 * Turns intents into at most one link per child. Children that already have a parent count as
 * resolved but get no link. Intents whose parent row is missing stay unresolved.
 */
export function planLinks(
  intents: readonly SpawnIntent[],
  parents: ReadonlyMap<string, LinkSession>,
  candidates: readonly LinkSession[],
): LinkPlan {
  const byName = new Map<string, LinkSession[]>();
  const add = (key: string | null, s: LinkSession): void => {
    if (key === null) return;
    const list = byName.get(key);
    if (list) list.push(s);
    else byName.set(key, [s]);
  };
  for (const s of candidates) {
    add(s.name, s);
    if (s.customTitle !== s.name) add(s.customTitle, s);
  }

  const best = new Map<string, { link: PlannedLink; rank: number; gap: number }>();
  const resolved = new Set<SpawnIntent>();
  for (const intent of intents) {
    const parent = parents.get(intent.parentSessionId);
    if (!parent) continue;
    const child = matchIntent(intent, parent, byName.get(intent.name) ?? []);
    if (!child) continue;
    resolved.add(intent);
    if (child.parentSessionId !== null) continue;
    const rank = KIND_RANK[intent.kind];
    const gap = Math.abs(child.startedAt!.getTime() - intent.at.getTime());
    const prev = best.get(child.sessionId);
    if (!prev || rank > prev.rank || (rank === prev.rank && gap < prev.gap)) {
      best.set(child.sessionId, {
        link: { childSessionId: child.sessionId, parentSessionId: parent.sessionId, intent },
        rank,
        gap,
      });
    }
  }
  return { links: [...best.values()].map((b) => b.link), resolved };
}

// ---------------------------------------------------------------------------------------------
// transcript scan (backfill)

function mightCarryIntent(line: string): boolean {
  return line.includes('"tool_use"') && (line.includes('"SendMessage"') || line.includes('swarm.py'));
}

/**
 * Streams one transcript and returns its spawn intents. A missing or unreadable file yields [];
 * a trailing partial line fails JSON.parse and is skipped. `shouldStop` aborts between lines.
 */
export async function scanTranscriptForIntents(
  file: string,
  parentSessionId: string,
  opts: { home: string; shouldStop?: () => boolean },
): Promise<SpawnIntent[]> {
  let handle: FileHandle;
  try {
    handle = await open(file, 'r');
  } catch {
    return [];
  }
  const out: SpawnIntent[] = [];
  try {
    for await (const line of handle.readLines({ encoding: 'utf8' })) {
      if (opts.shouldStop?.()) break;
      if (!mightCarryIntent(line)) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      out.push(...extractIntents(record, { parentSessionId, home: opts.home }));
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// database

// Type aliases, not interfaces: db.execute<T> needs T assignable to Record<string, unknown>.
type SessionRow = {
  session_id: string;
  host: string;
  repo: string | null;
  cwd: string | null;
  name: string | null;
  custom_title: string | null;
  started_at: Date | string | null;
  parent_session_id: string | null;
  parent_link_source: string | null;
};
type TranscriptRow = { session_id: string; transcript_path: string };

const SESSION_COLUMNS = sql.raw(
  'session_id, host, repo, cwd, name, custom_title, started_at, parent_session_id, parent_link_source',
);

function textArray(values: readonly string[]) {
  return sql`array(select jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;
}

function toLinkSession(r: SessionRow): LinkSession {
  return {
    sessionId: r.session_id,
    host: r.host,
    repo: r.repo,
    cwd: r.cwd,
    name: r.name,
    customTitle: r.custom_title,
    startedAt: r.started_at === null ? null : new Date(r.started_at),
    parentSessionId: r.parent_session_id,
    parentLinkSource: r.parent_link_source,
  };
}

/** Reads cc_sessions directly; every write (parent links and the marker setting) goes through `writer` (SessionsRepo). */
export function dbLinkStore(db: Db, writer: HeuristicParentWriter): LinkStore {
  return {
    async sessionsByIds(ids) {
      if (ids.length === 0) return [];
      const res = await db.execute<SessionRow>(sql`
        select ${SESSION_COLUMNS} from cc_sessions where session_id = any(${textArray(ids)})
      `);
      return res.rows.map(toLinkSession);
    },
    async sessionsByNames(host, names) {
      if (names.length === 0) return [];
      const res = await db.execute<SessionRow>(sql`
        select ${SESSION_COLUMNS} from cc_sessions
        where host = ${host}
          and started_at is not null
          and (name = any(${textArray(names)}) or custom_title = any(${textArray(names)}))
      `);
      return res.rows.map(toLinkSession);
    },
    async transcriptsOnHost(host) {
      const res = await db.execute<TranscriptRow>(sql`
        select session_id, transcript_path from cc_sessions
        where host = ${host} and transcript_path is not null
        order by started_at asc nulls last, session_id asc
      `);
      return res.rows.map((r) => ({ sessionId: r.session_id, transcriptPath: r.transcript_path }));
    },
    async setParent(childSessionId, parentSessionId) {
      await writer.setParent(childSessionId, parentSessionId, 'heuristic');
    },
    async readSetting(key) {
      return writer.getSetting(key);
    },
    async writeSetting(key, value) {
      await writer.putSetting(key, value);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// worker

interface Pending {
  intent: SpawnIntent;
  /** How many full ingest passes had completed when the intent arrived. */
  seenPass: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function keepPending(p: Pending, resolved: ReadonlySet<SpawnIntent>, nowMs: number, passes: number): boolean {
  if (resolved.has(p.intent)) return false;
  const end = intentWindow(p.intent).to.getTime();
  if (nowMs > end + PENDING_RETAIN_MS) return false;
  // A full pass finished since it arrived, so every child on disk is ingested: no point waiting.
  if (passes > p.seenPass && nowMs > end) return false;
  return true;
}

export function startLinkWorker(opts: LinkWorkerOptions): LinkWorker {
  const home = opts.home ?? homedir();
  const now = opts.now ?? ((): Date => new Date());
  const debounceMs = opts.debounceMs ?? DEFAULT_LINK_DEBOUNCE_MS;
  const closeGraceMs = opts.closeGraceMs ?? DEFAULT_LINK_CLOSE_GRACE_MS;
  const log = opts.log ?? ((line: string): void => console.log(`[notesd] ${line}`));
  const onError =
    opts.onError ??
    ((what: string, err: unknown): void => {
      console.error(`[notesd] session links: ${what} failed: ${errorMessage(err)}`);
    });

  let pending: Pending[] = [];
  let passes = 0;
  let closed = false;
  let backfillDone = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  /** One drain or backfill at a time; a failed task does not poison the chain. */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task);
    chain = run.catch(() => undefined);
    return run;
  }

  async function resolveAndApply(
    intents: readonly SpawnIntent[],
  ): Promise<{ report: LinkReport; resolved: Set<SpawnIntent> }> {
    if (intents.length === 0) return { report: { intents: 0, matched: 0, linked: 0 }, resolved: new Set() };
    const parentRows = await opts.store.sessionsByIds([...new Set(intents.map((i) => i.parentSessionId))]);
    const parents = new Map(parentRows.map((p) => [p.sessionId, p] as const));
    const candidates = await opts.store.sessionsByNames(opts.host, [...new Set(intents.map((i) => i.name))]);
    const plan = planLinks(intents, parents, candidates);
    let linked = 0;
    for (const link of plan.links) {
      if (closed) break;
      await opts.store.setParent(link.childSessionId, link.parentSessionId);
      linked += 1;
    }
    return { report: { intents: intents.length, matched: plan.resolved.size, linked }, resolved: plan.resolved };
  }

  function drainNow(): Promise<LinkReport> {
    return enqueue(async () => {
      if (closed || pending.length === 0) return { intents: 0, matched: 0, linked: 0 };
      const batch = pending.slice();
      const { report, resolved } = await resolveAndApply(batch.map((p) => p.intent));
      const t = now().getTime();
      const inBatch = new Set(batch);
      pending = pending.filter((p) => !inBatch.has(p) || keepPending(p, resolved, t, passes));
      return report;
    });
  }

  function schedule(): void {
    // Before the first full pass the backfill scan will see everything anyway.
    if (closed || timer !== null || passes === 0 || pending.length === 0) return;
    timer = setTimeout(() => {
      timer = null;
      drainNow().catch((err: unknown) => onError('drain', err));
    }, debounceMs);
    timer.unref();
  }

  function backfill(): Promise<LinkReport | null> {
    return enqueue(async () => {
      if (closed) return null;
      const key = `${LINKS_MARKER_PREFIX}${opts.host}`;
      const marker = await opts.store.readSetting(key);
      if (isObject(marker) && marker.version === LINKS_BACKFILL_VERSION) return null;
      const startedMs = Date.now();
      const refs = await opts.store.transcriptsOnHost(opts.host);
      const intents: SpawnIntent[] = [];
      for (const ref of refs) {
        if (closed) return null;
        intents.push(
          ...(await scanTranscriptForIntents(ref.transcriptPath, ref.sessionId, { home, shouldStop: () => closed })),
        );
      }
      if (closed) return null;
      const { report } = await resolveAndApply(intents);
      // Interrupted while applying: no marker, so the next start re-runs it (idempotent).
      if (closed) return null;
      await opts.store.writeSetting(key, {
        version: LINKS_BACKFILL_VERSION,
        finishedAt: new Date().toISOString(),
        transcripts: refs.length,
        ...report,
      });
      const secs = Math.round((Date.now() - startedMs) / 1000);
      log(
        `session links backfilled on ${opts.host}: ${report.linked} heuristic parent links from ${report.intents} intents in ${refs.length} transcripts (${secs} s)`,
      );
      return report;
    });
  }

  return {
    onBatch(batch: IngestBatchLike): void {
      if (closed) return;
      try {
        for (const record of batch.records) {
          for (const intent of extractIntents(record, { parentSessionId: batch.sessionId, home })) {
            pending.push({ intent, seenPass: passes });
          }
        }
        if (pending.length > PENDING_CAP) pending = pending.slice(pending.length - PENDING_CAP);
      } catch (err) {
        onError('extract', err);
      }
      // Even a batch without intents may be the child a pending intent waits for.
      schedule();
    },

    async onPassComplete(): Promise<void> {
      if (closed) return;
      passes += 1;
      if (!backfillDone) {
        try {
          await backfill();
          backfillDone = true;
        } catch (err) {
          onError('backfill', err);
        }
      }
      try {
        await drainNow();
      } catch (err) {
        onError('drain', err);
      }
    },

    backfill,
    drainNow,
    pendingCount: () => pending.length,

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      }
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        chain,
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, closeGraceMs);
          grace.unref();
        }),
      ]);
      clearTimeout(grace);
    },
  };
}
