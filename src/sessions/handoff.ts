import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { contextPercent, contextWindowFor } from './contextWindow.js';
import { redactSecrets } from './redact.js';
import type { CommandRunner, ResumeNode } from './resume.js';
import { PROMPTS_VERSION, PROMPTS_VERSION_EXCERPTS } from './types.js';
import { normalizePrompts } from './view.js';

/*
 * The "Spawn fresh with this context" handoff (session-context-rot phase 3).
 *
 * MEASURED 2026-11-12 (analysis 20261112-093143-CR7T): `claude --append-system-prompt-file <file>`
 * loads the file verbatim into the system prompt. The Read tool cannot take a 100k+ token file in
 * one call and may ask for permission outside the cwd, so the handoff travels as a system-prompt
 * file and the first prompt only names it. A fresh session's first assistant message starts near
 * 48,815 tokens (median of 56 mcp-notes sessions: system prompt + tools + CLAUDE.md + memory),
 * which is why the budget subtracts a per-repo baseline.
 */

/** First line of a fresh session's first prompt. claude/hooks/notes-prompt.mjs skips node-id resolution on it. */
export const HANDOFF_MARKER = '[notesd handoff]';
/** Share of the old session's window the new session may start at (baseline + handoff). */
export const HANDOFF_WINDOW_SHARE = 0.5;
/** Baseline when the repo has no session with a recorded first-message context. */
export const DEFAULT_BASELINE_TOKENS = 48_000;
/** The baseline is the median first-message context of the repo's latest this-many non-fork sessions (any host). */
export const BASELINE_SAMPLE_SESSIONS = 20;
export const CHARS_PER_TOKEN = 4;
/** Room kept for the exchanges heading, intro sentence and the gap marker. */
export const INTRO_RESERVE_TOKENS = 200;
/** A first exchange bigger than the room left is cut, but never below this many characters. */
export const MIN_FIRST_EXCHANGE_CHARS = 4_000;
/** Room kept for the "[... N more characters ...]" note appended to a cut first exchange. */
export const CLIP_NOTE_TOKENS = 32;
export const GIT_TIMEOUT_MS = 5_000;
/** Each git output is cut to this many characters in the handoff. */
export const GIT_TEXT_MAX_CHARS = 8_000;
export const HANDOFFS_DIR = 'handoffs';
export const HANDOFF_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_HANDOFF_COMMITS = 200;
export const MAX_HANDOFF_PLAN_DOCS = 50;

/** One stored prompt and Claude's reply to it (both already redacted). */
export interface HandoffExchange {
  /** The prompt's number in the session, from 1. */
  seq: number;
  at: Date | null;
  prompt: string;
  /** The prompt was cut at the storage ceiling when it was stored. */
  promptTruncated: boolean;
  /** Claude's stored reply to this prompt; null when none is stored. */
  reply: string | null;
  replyTruncated: boolean;
}

/** Phase 1's stored window evidence of the OLD session (window is inferred at read time, Invariant 9). */
export interface HandoffContextEvidence {
  model: string | null;
  peakTokens: number | null;
  longBeta: boolean;
}

/** Everything a handoff is built from. Loaded by loadHandoffSource; built by hand in unit tests. */
export interface HandoffSource {
  node: ResumeNode;
  summarizedAt: Date | null;
  /** False when only excerpts are stored (legacy or pruned row): prompts may be cut or missing, replies missing. */
  promptsComplete: boolean;
  /** Oldest first. */
  exchanges: HandoffExchange[];
  context: HandoffContextEvidence;
  /** Expected starting context of a fresh session in this repo, before the handoff. */
  baselineTokens: number;
}

/**
 * Git state of the directory the new session runs in. `not_collected` is the dry-run estimate
 * (the route runs no git). The estimate is therefore smaller than a spawn's by at most
 * 2 × GIT_TEXT_MAX_CHARS / CHARS_PER_TOKEN tokens.
 */
export type GitState =
  | { kind: 'collected'; cwd: string; status: string; diffStat: string }
  | { kind: 'unavailable'; cwd: string; reason: string }
  | { kind: 'not_collected' };

export interface HandoffEstimate {
  tokens: number;
  window: number;
  percent: number;
  exchanges_included: number;
  exchanges_total: number;
  truncated: boolean;
}

/** GET /api/sessions/:nodeId/handoff body. */
export interface HandoffEstimateBody extends HandoffEstimate {
  node_id: string;
  baseline: number;
}

export interface BuiltHandoff {
  text: string;
  estimate: HandoffEstimate;
}

export interface BuildHandoffOptions {
  now: Date;
  git: GitState;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Tokens the handoff text may take: HANDOFF_WINDOW_SHARE of the window minus the baseline, never negative. */
export function handoffBudget(window: number, baselineTokens: number): number {
  return Math.max(0, Math.floor(HANDOFF_WINDOW_SHARE * window - baselineTokens));
}

/** "N minutes" / "N hours" / "N days" for a non-negative duration (negative counts as 0). */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.round(hours / 24)} days`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `text` cut to `max` characters (never through a surrogate pair) with a note saying how much was left out. */
function clipChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max);
  const code = text.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}\n[... ${text.length - end} more characters left out; see the transcript]`;
}

function renderGit(git: GitState): string[] {
  switch (git.kind) {
    case 'collected':
      return [
        `Of ${git.cwd}, read when this handoff was written.`,
        '',
        '`git status --porcelain=v1 -b`:',
        '```',
        clipChars(git.status, GIT_TEXT_MAX_CHARS) || '(nothing)',
        '```',
        '',
        '`git diff --stat`:',
        '```',
        clipChars(git.diffStat, GIT_TEXT_MAX_CHARS) || '(no unstaged changes)',
        '```',
      ];
    case 'unavailable':
      return [`Git state unavailable for ${git.cwd}: ${git.reason}. Run git yourself if you need it.`];
    case 'not_collected':
      return ['Git state is collected at spawn time (this is an estimate only).'];
  }
}

function renderHeader(source: HandoffSource, opts: BuildHandoffOptions): string {
  const n = source.node;
  const title = n.title !== null && n.title !== '' ? n.title : null;
  const lines: string[] = [
    `# notesd handoff: Claude Code session ${n.nodeId}`,
    '',
    `You are continuing the work of Claude Code session ${n.nodeId}${title !== null ? ` ("${title}")` : ''}. ` +
      `notesd wrote this handoff at ${opts.now.toISOString()} when the user chose "Spawn fresh with this context". ` +
      "The exchanges below are the user's prompts and Claude's replies from that session, redacted, oldest first.",
    '',
    `- Node id: ${n.nodeId} (session ${n.sessionId}, host ${n.host})`,
    `- Title: ${title ?? '(none)'}`,
    `- Cwd: ${n.cwd ?? '(unknown)'}`,
    `- Repo: ${n.repo ?? '(none)'}`,
    n.transcriptPath !== null
      ? `- Transcript: ${n.transcriptPath} (the source of truth; read the parts you need)`
      : '- Transcript: (path not recorded)',
    '',
    '## Summary',
  ];
  const summary = n.summary?.trim() ?? '';
  if (summary === '') {
    lines.push('Not summarized yet.');
  } else {
    lines.push(
      source.summarizedAt !== null
        ? `Written ${formatAge(opts.now.getTime() - source.summarizedAt.getTime())} ago (${source.summarizedAt.toISOString()}). ` +
            'It may be older than the latest exchanges below; where they disagree, the exchanges win.'
        : 'Written at an unknown time; it may be older than the latest exchanges below.',
      '',
      summary,
    );
  }
  lines.push('', '## Plan docs');
  if (n.planDocs.length === 0) lines.push('(none recorded)');
  else lines.push(...n.planDocs.slice(0, MAX_HANDOFF_PLAN_DOCS).map((d) => `- ${d}`));
  lines.push('', '## Commits (oldest first)');
  if (n.commits.length === 0) {
    lines.push('(none recorded)');
  } else {
    const shown = n.commits.slice(-MAX_HANDOFF_COMMITS);
    if (shown.length < n.commits.length) lines.push(`(${n.commits.length - shown.length} older commits not listed)`);
    lines.push(...shown.map((c) => `- ${c}`));
  }
  lines.push('', '## Git state', ...renderGit(opts.git));
  return lines.join('\n');
}

function renderExchange(ex: HandoffExchange): string {
  const lines = [`### Prompt ${ex.seq}${ex.at !== null ? ` (${ex.at.toISOString()})` : ''}`, '[user]', ex.prompt];
  if (ex.promptTruncated) lines.push('[this prompt was cut when it was stored]');
  lines.push('[claude]', ex.reply ?? '(no reply stored)');
  if (ex.reply !== null && ex.replyTruncated) lines.push('[this reply was cut when it was stored]');
  return lines.join('\n');
}

function exchangesIntro(source: HandoffSource, total: number, included: number, firstCut: boolean): string {
  const omitted = total - included;
  const where =
    source.node.transcriptPath !== null
      ? `the transcript ${source.node.transcriptPath}`
      : "the old session's transcript (its path was not recorded)";
  const parts: string[] = [];
  if (total === 0) {
    parts.push('No exchanges are stored for this session.');
  } else if (omitted === 0 && !firstCut) {
    parts.push(`All ${plural(total, 'stored exchange follows', 'stored exchanges follow')}, oldest first: each is the user's prompt and Claude's reply to it.`);
  } else {
    if (omitted > 0) {
      parts.push(
        `${included} of ${total} stored exchanges follow: the first one and the newest ${included - 1}. ` +
          `${plural(omitted, 'exchange was', 'exchanges were')} left out to keep this session's context small.`,
      );
    }
    if (firstCut) parts.push('The first exchange was cut to fit.');
    parts.push(`Read ${where} for what was left out; it is the source of truth.`);
  }
  if (!source.promptsComplete) {
    parts.push(
      "Only excerpts of this session's prompts are stored (it was ingested before full prompts were kept, or its " +
        `transcript was pruned), and Claude's replies may be missing; read ${where} when you need the full text.`,
    );
  }
  return parts.join(' ');
}

/**
 * The handoff text and its estimate. Pure: no I/O, no clock (opts.now), no git (opts.git).
 * Carries every exchange when they fit the budget; otherwise the first exchange (cut if it alone is
 * too big) and the longest run of newest exchanges that fits, and says what was left out.
 */
export function buildHandoff(source: HandoffSource, opts: BuildHandoffOptions): BuiltHandoff {
  const { window } = contextWindowFor({
    model: source.context.model,
    peakTokens: source.context.peakTokens,
    longBeta: source.context.longBeta,
  });
  const budget = handoffBudget(window, source.baselineTokens);
  const header = renderHeader(source, opts);
  const blocks = source.exchanges.map(renderExchange);
  const total = blocks.length;
  const room = budget - estimateTokens(header) - INTRO_RESERVE_TOKENS;
  // +1 token per block pays for the blank line that joins it.
  const cost = (block: string): number => estimateTokens(block) + 1;
  const allCost = blocks.reduce((sum, block) => sum + cost(block), 0);

  let picked: number[];
  let firstCut = false;
  if (total === 0 || allCost <= room) {
    picked = blocks.map((_, i) => i);
  } else {
    const firstMax = Math.max(MIN_FIRST_EXCHANGE_CHARS, (room - CLIP_NOTE_TOKENS) * CHARS_PER_TOKEN);
    if (blocks[0]!.length > firstMax) {
      blocks[0] = clipChars(blocks[0]!, firstMax);
      firstCut = true;
    }
    let left = room - cost(blocks[0]!);
    const tail: number[] = [];
    for (let i = total - 1; i >= 1; i -= 1) {
      const c = cost(blocks[i]!);
      if (c > left) break;
      tail.unshift(i);
      left -= c;
    }
    picked = [0, ...tail];
  }

  const omitted = total - picked.length;
  const parts: string[] = [header, '', '## Exchanges', exchangesIntro(source, total, picked.length, firstCut)];
  if (picked.length > 0) {
    parts.push('', blocks[picked[0]!]!);
    if (omitted > 0) parts.push('', `[... ${plural(omitted, 'exchange', 'exchanges')} left out here; read them in the transcript ...]`);
    for (const idx of picked.slice(1)) parts.push('', blocks[idx]!);
  }
  const text = `${parts.join('\n')}\n`;
  const tokens = estimateTokens(text);
  return {
    text,
    estimate: {
      tokens,
      window,
      percent: contextPercent(source.baselineTokens + tokens, window),
      exchanges_included: picked.length,
      exchanges_total: total,
      truncated: omitted > 0 || firstCut,
    },
  };
}

/** The dry-run estimate the route answers: same budget as a spawn, no git, no file. */
export function handoffEstimateBody(source: HandoffSource, now: Date): HandoffEstimateBody {
  const { estimate } = buildHandoff(source, { now, git: { kind: 'not_collected' } });
  return { node_id: source.node.nodeId, ...estimate, baseline: source.baselineTokens };
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `git status --porcelain=v1 -b` and `git diff --stat` of `cwd` through the injectable runner, both
 * under one timeout. `--no-optional-locks` keeps a status refresh from taking index.lock while the
 * user's own session works in the same tree. Never throws: a failure or timeout is `unavailable`.
 */
export async function gitState(run: CommandRunner, cwd: string, timeoutMs: number = GIT_TIMEOUT_MS): Promise<GitState> {
  try {
    const [status, diffStat] = await withTimeout(
      Promise.all([
        run('git', ['--no-optional-locks', '-C', cwd, 'status', '--porcelain=v1', '-b']),
        run('git', ['--no-optional-locks', '-C', cwd, 'diff', '--stat']),
      ]),
      timeoutMs,
      'git',
    );
    return { kind: 'collected', cwd, status: status.trimEnd(), diffStat: diffStat.trimEnd() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'unavailable', cwd, reason: message.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown error' };
  }
}

/** `<NODE>-<yyyymmddThhmmss>.md`, UTC. */
export function handoffFileName(nodeId: string, at: Date): string {
  const stamp = at.toISOString().replace(/\.\d{3}Z$/, '').replace(/[-:]/g, '');
  return `${nodeId}-${stamp}.md`;
}

/** Deletes `*.md` files in `dir` older than HANDOFF_MAX_AGE_MS. Best effort: every error is ignored. */
export async function pruneHandoffs(dir: string, nowMs: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(dir, name);
    try {
      if (nowMs - (await stat(file)).mtimeMs > HANDOFF_MAX_AGE_MS) await unlink(file);
    } catch {
      // another daemon or the user may have removed it; pruning never fails a spawn
    }
  }
}

/** Writes the handoff to `<dataDir>/handoffs/<NODE>-<stamp>.md` (mkdir -p, mode 0600), after pruning old ones. Returns the path. */
export async function writeHandoff(dataDir: string, nodeId: string, text: string, now: Date = new Date()): Promise<string> {
  const dir = path.join(dataDir, HANDOFFS_DIR);
  await mkdir(dir, { recursive: true });
  await pruneHandoffs(dir, now.getTime());
  const file = path.join(dir, handoffFileName(nodeId, now));
  await writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
  return file;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' && value !== '') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Median `context_first_tokens` of the repo's latest BASELINE_SAMPLE_SESSIONS non-fork sessions that
 * have one (any host), else the default. Forks (`fork_detected_by is not null`) are left out: a
 * fork's first own message already holds the copied parent history, so it is not a start-up cost.
 */
export async function repoBaseline(db: Db, repo: string | null): Promise<number> {
  if (repo === null || repo === '') return DEFAULT_BASELINE_TOKENS;
  const res = await db.execute<{ median: number | string | null }>(sql`
    select percentile_cont(0.5) within group (order by first_tokens) as median
    from (
      select context_first_tokens as first_tokens from cc_sessions
      where repo = ${repo} and context_first_tokens is not null and context_first_tokens > 0
        and coalesce(entrypoint, 'cli') = 'cli'
        and fork_detected_by is null
      order by coalesce(started_at, created_at) desc
      limit ${BASELINE_SAMPLE_SESSIONS}
    ) recent`);
  const median = toNumberOrNull(res.rows[0]?.median ?? null);
  return median === null ? DEFAULT_BASELINE_TOKENS : Math.round(median);
}

type HandoffHeadRow = {
  summarized_at: Date | string | null;
  prompts_version: number | string;
  excerpts: unknown;
  context_model: string | null;
  context_peak_tokens: number | string | null;
  context_long_beta: boolean | null;
};

type ExchangeRow = {
  seq: number | string;
  at: Date | string | null;
  text: string;
  truncated: boolean | null;
  reply: string | null;
  reply_truncated: boolean | null;
};

async function storedExchanges(db: Db, sessionId: string): Promise<HandoffExchange[]> {
  const res = await db.execute<ExchangeRow>(sql`
    select p.seq, p.at, p.text, p.truncated, r.text as reply, r.truncated as reply_truncated
    from cc_session_prompts p
    left join cc_session_replies r on r.session_id = p.session_id and r.seq = p.seq
    where p.session_id = ${sessionId}
    order by p.seq`);
  return res.rows.map((r) => ({
    seq: Number(r.seq),
    at: toDate(r.at),
    prompt: r.text,
    promptTruncated: r.truncated === true,
    reply: r.reply !== null && r.reply.trim() !== '' ? r.reply : null,
    replyTruncated: r.reply_truncated === true,
  }));
}

/** A legacy row's excerpts (unredacted when stored), redacted here; no replies are stored for such a row. */
function legacyExchanges(excerpts: unknown): HandoffExchange[] {
  return normalizePrompts(excerpts).map((p, i) => ({
    seq: i + 1,
    at: toDate(p.at),
    prompt: redactSecrets(p.text),
    promptTruncated: false,
    reply: null,
    replyTruncated: false,
  }));
}

/**
 * The handoff source of a node, from the DB only (works for any host's node). Prompts paired with
 * replies by seq from cc_session_prompts / cc_session_replies when prompts_version >=
 * PROMPTS_VERSION_EXCERPTS; a legacy row (0) falls back to its cc_sessions.prompts excerpts.
 * promptsComplete mirrors readModel.sessionPrompts: complete only at PROMPTS_VERSION.
 */
export async function loadHandoffSource(db: Db, node: ResumeNode): Promise<HandoffSource> {
  const head = await db.execute<HandoffHeadRow>(sql`
    select summarized_at, prompts_version,
      case when prompts_version >= ${PROMPTS_VERSION_EXCERPTS} then null else prompts end as excerpts,
      context_model, context_peak_tokens, context_long_beta
    from cc_sessions where session_id = ${node.sessionId} limit 1`);
  const row = head.rows[0];
  const version = row === undefined ? 0 : Number(row.prompts_version);
  const exchanges =
    row === undefined
      ? []
      : version >= PROMPTS_VERSION_EXCERPTS
        ? await storedExchanges(db, node.sessionId)
        : legacyExchanges(row.excerpts);
  return {
    node,
    summarizedAt: toDate(row?.summarized_at ?? null),
    promptsComplete: version >= PROMPTS_VERSION,
    exchanges,
    context: {
      model: row?.context_model ?? null,
      peakTokens: toNumberOrNull(row?.context_peak_tokens ?? null),
      longBeta: row?.context_long_beta === true,
    },
    baselineTokens: await repoBaseline(db, node.repo),
  };
}
