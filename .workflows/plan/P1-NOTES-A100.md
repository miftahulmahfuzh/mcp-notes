> Adopted from `.workflows/plan/SESSION_CONTEXT_ROT_PLAN.md` phase 3. Source: `.workflows/plan/session-context-rot/phase-3.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 3: Handoff carry-over for Spawn fresh

**Plan set:** `SESSION_CONTEXT_ROT_PLAN.md`
**Analysis:** `.workflows/analyze/20261112-093143-CR7T_code_analyzer.md`
**Satisfies:** R4: "Spawn fresh with this context" carries as much of the old session as the new session's context can hold, all prompt→reply pairs on a 1M window
**Criteria:** R4.1, R4.2, R4.3, R4.4, R4.5, R4.6, R4.7
**Depends on:** Phase 1
**Difficulty:** HARD
**Package:** `src/sessions`

---

## Goal

Today "Spawn fresh" sends one prompt of up to 12 KB: summary, plan docs and commits. Then the notes-prompt hook sees the node id and repeats most of it. After this phase a fresh spawn writes a handoff file under `<dataDir>/handoffs/`. The file holds the node's header (id, title, cwd/repo, transcript path, the summary and its age, plan docs, commits, `git status` / `git diff --stat`) and every stored prompt with Claude's reply. When those exchanges do not fit `0.5 × window − baseline`, it holds the first exchange and the newest ones that fit, plus a note saying how many were left out. The file goes into the new session's system prompt through `--append-system-prompt-file`. The first prompt is short and starts with the `[notesd handoff]` marker line, and the hook skips node-id resolution on that line. `GET /api/sessions/:nodeId/handoff` returns the same budget computation as a dry-run estimate.

## Interface Contract

**Deletes:** the old body of `freshPrompt` (`src/sessions/resume.ts:255-279`): the summary, plan docs, commits and "Continue the work of …" text no longer go into the first prompt. They are in the handoff file.
**Renames:** none
**Creates:**
- `src/sessions/handoff.ts` (new): `HANDOFF_MARKER`, `HANDOFF_WINDOW_SHARE`, `DEFAULT_BASELINE_TOKENS`, `BASELINE_SAMPLE_SESSIONS`, `CHARS_PER_TOKEN`, `INTRO_RESERVE_TOKENS`, `MIN_FIRST_EXCHANGE_CHARS`, `CLIP_NOTE_TOKENS`, `GIT_TIMEOUT_MS`, `GIT_TEXT_MAX_CHARS`, `HANDOFFS_DIR`, `HANDOFF_MAX_AGE_MS`, `MAX_HANDOFF_COMMITS`, `MAX_HANDOFF_PLAN_DOCS`; types `HandoffExchange`, `HandoffContextEvidence`, `HandoffSource`, `GitState`, `HandoffEstimate`, `HandoffEstimateBody`, `BuiltHandoff`, `BuildHandoffOptions`; functions `estimateTokens`, `handoffBudget`, `formatAge`, `buildHandoff`, `handoffEstimateBody`, `gitState`, `handoffFileName`, `pruneHandoffs`, `writeHandoff`, `repoBaseline`, `loadHandoffSource`
- `src/sessions/resume.ts`: `prepareHandoff(deps, node, cwd)`
- `src/http/sessionResume.ts`: `handoffSourceLookup(db, repo)`, `SessionResumeRoutesOptions.handoffSource`, route `GET /api/sessions/:nodeId/handoff` → 200 `{node_id, tokens, window, percent, baseline, exchanges_included, exchanges_total, truncated}` | 400 `{error:'invalid_node_id'}` | 404 `{error:'not_found', node_id}`
- `claude/hooks/notes-prompt.mjs`: `HANDOFF_MARKER`, `isHandoffPrompt(prompt)` (+ `.d.mts` declarations)
**Signature changes:**
- `freshPrompt(node: ResumeNode, userPrompt?: string): string` → `freshPrompt(node: Pick<ResumeNode, 'nodeId' | 'title'>, handoffFile: string, userPrompt?: string): string`
- `interface ResumeDeps` gains `dataDir: string` and `loadHandoff(node: ResumeNode): Promise<HandoffSource>`
- `interface DefaultResumeDepsInput` gains `dataDir: string` and `loadHandoff: ResumeDeps['loadHandoff']`
- `resumeNode` fresh branch: argv becomes `['--append-system-prompt-file', <file>, ...promptArgs(freshPrompt(node, file, prompt))]`. Env `CC_PARENT_SESSION` and window name `<node>-new` are unchanged.
**Requires (from earlier phases):**
- Phase 1: `src/sessions/contextWindow.ts` exports `contextWindowFor(input: { model: string | null; peakTokens: number | null; longBeta: boolean }): { window: number; source: 'model' | 'peak' | 'beta' | 'default' }`. Its rules, which my tests rely on: peak > 200,000 gives 1,000,000. An unknown model (`glm-5.3`) with no evidence gives 200,000. It also exports `contextPercent(tokens, window)` (one decimal, 0..100), which this phase uses for the estimate's `percent`.
- Phase 1: `cc_sessions` columns `context_model text null`, `context_peak_tokens bigint null`, `context_first_tokens bigint null`, `context_long_beta boolean not null default false` (migration `0016`). This phase reads them only through raw SQL by column name, so it does not depend on Phase 1's Drizzle property names.
**Leaves alone (owned by others):** ingest/transcript/merge/repo/schema/migrations (Phase 1). `view.ts`, `readModel.ts`, `sessionsApi.ts`, `src/sessions/events.ts`, `deps.ts`/`daemon.ts`/`background.ts` wiring (Phase 2; this phase only *imports* the existing `normalizePrompts` from `view.ts`). `web/` including `web/src/sessionDetailApi.ts`, `README.md`, `.claude/skills/verify-notesd/features/*` (Phase 4). `src/http/app.ts` needs no change: the new GET route sits in `sessionResumeRoutes`, which is already mounted.

## Files

| File | Action | What changes |
|---|---|---|
| `src/sessions/handoff.ts` | create | loader, pure builder with budget, git state, writer + prune, estimate body |
| `src/sessions/resume.ts` | modify | `ResumeDeps.dataDir` + `loadHandoff`; `freshPrompt` becomes the marker prompt; `prepareHandoff`; fresh branch of `resumeNode`; `defaultResumeDeps` input |
| `src/http/sessionResume.ts` | modify | `defaultSessionResumer` passes `dataDir` + `loadHandoff`; `handoffSourceLookup`; `GET /api/sessions/:nodeId/handoff` |
| `src/mcp/sessionTools.ts` | modify | `session_resume` description and `fresh` describe now say what fresh carries |
| `claude/hooks/notes-prompt.mjs` | modify | `HANDOFF_MARKER`, `isHandoffPrompt`; `runPrompt` skips node ids for a marker prompt; header comment |
| `claude/hooks/notes-prompt.d.mts` | modify | declare `HANDOFF_MARKER`, `isHandoffPrompt` |
| `tests/unit/sessions/handoff.test.ts` | create | builder budget / all / truncation / first-cut / legacy / header, gitState ok / fail / timeout, writeHandoff path + prune, marker parity |
| `tests/unit/sessions/resume.test.ts` | modify | fake runner answers git; deps get `dataDir` + `loadHandoff`; freshPrompt and fresh-spawn tests rewritten; git-fail, no-tmux, load-fail tests |
| `tests/unit/sessions/sessionResumeRoute.test.ts` | modify | GET handoff route tests |
| `tests/unit/hooks/notesPrompt.test.ts` | modify | marker prompt adds nothing and does no I/O; same text without marker still resolves |
| `tests/integration/sessions.resume.int.test.ts` | rewrite | real rows + fake tmux/git: 1M carries all, 200k truncates, git fail, estimate route, baseline median |

## Implementation Steps

### Step 1: The handoff module
**File:** `src/sessions/handoff.ts` (new)
**Change:** Create the whole module. It holds the DB loader (raw SQL by column name, like `readModel.ts`), the pure builder, git state through the injectable `CommandRunner`, and the file writer with a 14-day prune. Types from `resume.ts` are imported with `import type` only, so there is no runtime import cycle (`resume.ts` imports this module at runtime).

Budget rules, all in `buildHandoff`:
- `window = contextWindowFor({model, peakTokens, longBeta}).window` of the OLD session.
- `budget = max(0, floor(0.5 × window − baseline))`. Tokens are estimated as `ceil(chars / 4)`.
- `room = budget − tokens(header) − INTRO_RESERVE_TOKENS`.
- If every exchange fits `room`, all are carried.
- Otherwise the first exchange is always carried. If it alone is bigger than `room`, it is cut to `max(MIN_FIRST_EXCHANGE_CHARS, (room − CLIP_NOTE_TOKENS) × 4)` chars. After it comes the longest contiguous run of newest exchanges that fits. The intro states how many were left out and names the transcript path as the source of truth.
- `percent = contextPercent(baseline + tokens, window)` (Phase 1's helper: one decimal, 0..100), where `tokens = estimateTokens(text)` of the final text. No local percent arithmetic (reconciled).

**Code:**
```ts
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
```
**Impact:** New module only. It imports Phase 1's `contextWindow.ts`, so it compiles only after Phase 1 has landed (`depends_on: [1]`).

### Step 2: `ResumeDeps` gains `dataDir` and `loadHandoff`
**File:** `src/sessions/resume.ts:1-7` (imports) and `:117-136` (`ResumeDeps`)
**Change:** Add the import after line 7 (`import { resolveExecutable } from '../chat/env.js';`):
```ts
import { buildHandoff, gitState, HANDOFF_MARKER, writeHandoff, type HandoffSource } from './handoff.js';
```
Replace the `ResumeDeps` interface (lines 117-136) with:
```ts
/** Every OS touch point of resume. Tests inject fakes; the daemon uses defaultResumeDeps(). */
export interface ResumeDeps {
  /** os.hostname() of this machine; a node with another host is not_on_this_machine. */
  host: string;
  /** tmux and git go through this (git for the fresh handoff's git state). */
  run: CommandRunner;
  tmuxBin: string;
  /** NOTESD_TMUX_SOCKET: passed as `-S <path>` to every tmux call. Null: tmux's default socket. */
  tmuxSocket: string | null;
  /** Absolute path of the claude executable (what the tmux window execs). */
  claudeBin: string;
  homeDir: string;
  /** Root of `<root>/<repo>/<slug>` worktrees; never chosen as a fallback cwd. */
  worktreesDir: string;
  /** NOTES_DATA_DIR: fresh handoffs are written under `<dataDir>/handoffs/`. */
  dataDir: string;
  /** The live registry entry of a session on this host, or null. */
  live(sessionId: string): Promise<LiveEntry | null>;
  isDir(p: string): Promise<boolean>;
  /** Cwds of the repo's sessions on this host, newest first (fallback candidates for a deleted cwd). */
  repoCwds(repo: string): Promise<string[]>;
  /** The node's handoff source (stored prompts, replies, context evidence, baseline). DB access lives here so unit tests stay DB-free. */
  loadHandoff(node: ResumeNode): Promise<HandoffSource>;
  now(): number;
}
```
Also replace the `ResumeRequest.prompt` doc comment at line 46 with:
```ts
  /** Typed into a live session, or passed to `claude --resume <sid> <prompt>`, or the task line of a fresh session's first prompt. */
```
and line 48:
```ts
  /** Start a new session carrying the node's handoff (--append-system-prompt-file) instead of resuming it. */
```
**Impact:** Every `ResumeDeps` literal must now set `dataDir` and `loadHandoff`. There are three: `defaultResumeDeps` (Step 5), `tests/unit/sessions/resume.test.ts` `makeDeps` (Step 9), and `tests/integration/sessions.resume.int.test.ts` `deps` (Step 12).

### Step 3: `freshPrompt` becomes the short marker prompt
**File:** `src/sessions/resume.ts:255-279`
**Change:** Replace the doc comment and the function with the version below. The summary, plan docs and commits leave the prompt, because the handoff carries them.
**Code:**
```ts
/**
 * First prompt of a fresh session. Its first line is exactly HANDOFF_MARKER, so the notes-prompt
 * hook adds no node-id context (the handoff in the system prompt already has it). Then the node,
 * its title and the handoff file, then the user's task. Clipped to TMUX_TEXT_MAX_BYTES.
 */
export function freshPrompt(node: Pick<ResumeNode, 'nodeId' | 'title'>, handoffFile: string, userPrompt?: string): string {
  const head = [
    HANDOFF_MARKER,
    `You continue Claude Code session ${node.nodeId}${node.title ? ` ("${node.title}")` : ''}.`,
    "Its full handoff (summary, plan docs, commits, git state, and the stored prompts with Claude's replies) " +
      `is in your system prompt; the same text is in ${handoffFile}.`,
  ].join('\n');
  const tail =
    userPrompt !== undefined && userPrompt !== '' ? `Task: ${userPrompt}` : 'Read the handoff, then wait for my next instruction.';
  return clipUtf8(`${head}\n\n${tail}`, TMUX_TEXT_MAX_BYTES);
}
```
**Impact:** The signature changes. The only callers are `resumeNode` (Step 4) and `resume.test.ts` (Step 9).

### Step 4: `prepareHandoff` and the fresh branch of `resumeNode`
**File:** `src/sessions/resume.ts:571-649`
**Change:** Insert `prepareHandoff` right after `function ok(...)` (lines 571-573). Then replace lines 627-645, from `const session = await pickTmuxSession(deps);` through the `return ok({...});`, with the block below. The order stays tmux session → cwd → handoff, so a missing tmux server returns `no_tmux` before anything is written. Git state is read from the cwd the new window runs in (`place.cwd`). A `loadHandoff` or write failure throws into the existing `catch` and becomes `500 spawn_failed`. Update the `resumeNode` doc comment's last line (line 584) to: `` * `claude --resume <sid> [prompt]`, or with fresh a new claude carrying the node's handoff (prepareHandoff) via --append-system-prompt-file. ``
**Code:**
```ts
/**
 * Loads, builds and writes the node's handoff (git state of `cwd`), returning the file path.
 * Throws only when loading or writing fails; a git failure is written into the handoff.
 */
export async function prepareHandoff(deps: ResumeDeps, node: ResumeNode, cwd: string): Promise<string> {
  const now = new Date(deps.now());
  const [source, git] = await Promise.all([deps.loadHandoff(node), gitState(deps.run, cwd)]);
  const handoff = buildHandoff(source, { now, git });
  return writeHandoff(deps.dataDir, node.nodeId, handoff.text, now);
}
```
```ts
    const session = await pickTmuxSession(deps);
    if (session === null) return { status: 409, body: { error: 'no_tmux' } };
    const place = await resolveCwd(deps, node);
    let created: { window: string; paneId: string | null };
    if (fresh) {
      const file = await prepareHandoff(deps, node, place.cwd);
      created = await openClaudeWindow(
        deps,
        session,
        place.cwd,
        windowName(node, true),
        ['--append-system-prompt-file', file, ...promptArgs(freshPrompt(node, file, prompt))],
        { CC_PARENT_SESSION: node.sessionId },
      );
    } else {
      created = await openClaudeWindow(deps, session, place.cwd, windowName(node, false), [
        '--resume',
        node.sessionId,
        ...promptArgs(prompt),
      ]);
      if (created.paneId !== null) recent.set(node.sessionId, { at: deps.now(), paneId: created.paneId });
    }
    return ok({
      action: fresh ? 'spawned' : 'resumed',
      ...(created.window !== '' ? { window: created.window } : {}),
      cwd: place.cwd,
      ...(place.missing && node.cwd !== null ? { original_cwd: node.cwd } : {}),
    });
```
**Impact:** The fresh tmux argv changes shape. The resume branch behaves exactly as before: `recent.set` still runs only for a non-fresh spawn with a pane id.

### Step 5: `defaultResumeDeps` takes `dataDir` and `loadHandoff`
**File:** `src/sessions/resume.ts:683-718`
**Change:** Replace `DefaultResumeDepsInput` and `defaultResumeDeps` with:
```ts
export interface DefaultResumeDepsInput {
  /** config.chat.claudeBin (NOTESD_CLAUDE_BIN); resolved against PATH to an absolute path. */
  claudeBin: string;
  worktreesDir: string;
  /** config.dataDir (NOTES_DATA_DIR): handoffs go under `<dataDir>/handoffs/`. */
  dataDir: string;
  live: ResumeDeps['live'];
  repoCwds: ResumeDeps['repoCwds'];
  loadHandoff: ResumeDeps['loadHandoff'];
  /** Defaults to process.env (NOTESD_TMUX_SOCKET, NOTESD_TMUX_BIN, PATH). */
  env?: Readonly<Record<string, string | undefined>>;
}
```
(`isDirectory` at lines 693-699 stays as is.)
```ts
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
    dataDir: input.dataDir,
    live: input.live,
    isDir: isDirectory,
    repoCwds: input.repoCwds,
    loadHandoff: input.loadHandoff,
    now: () => Date.now(),
  };
}
```
**Impact:** `defaultSessionResumer` must pass both fields (Step 6). `runCommand`'s 5 s timeout also applies to git, and `gitState` adds its own `GIT_TIMEOUT_MS` race on top.

### Step 6: Daemon wiring and the dry-run estimate route
**File:** `src/http/sessionResume.ts:1-18` (imports), `:26-29` (options), `:50-72` (`defaultSessionResumer`), `:85-111` (doc + routes)
**Change:** Replace the import block (lines 1-18) with:
```ts
import os from 'node:os';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { AppDeps } from '../deps.js';
import { handoffEstimateBody, loadHandoffSource, type HandoffSource } from '../sessions/handoff.js';
import { normalizeNodeId } from '../sessions/ids.js';
import { backgroundJobId, readLiveSessions, type PidAliveCheck } from '../sessions/registry.js';
import { SessionsRepo } from '../sessions/repo.js';
import {
  createSessionResumer,
  defaultResumeDeps,
  RESUME_PROMPT_MAX_CHARS,
  toResumeNode,
  type ResumeDeps,
  type ResumeNode,
  type SessionResumer,
} from '../sessions/resume.js';
import { describeIssues } from './api.js';
import { sameOriginOnly } from './sameOrigin.js';
```
Replace `SessionResumeRoutesOptions` (lines 26-29) with:
```ts
export interface SessionResumeRoutesOptions {
  /** Defaults to defaultSessionResumer(deps). createApp passes the one it shares with the MCP tool. */
  resumer?: SessionResumer;
  /** Canonical node id -> handoff source, or null for an unknown node. Defaults to handoffSourceLookup(deps.db, …). */
  handoffSource?: (nodeId: string) => Promise<HandoffSource | null>;
}
```
Insert after `sessionLookup` (after line 37):
```ts
/** Node id -> HandoffSource from the DB only (any host's node; no git, no file). Null for an unknown node. */
export function handoffSourceLookup(
  db: Db,
  repo: Pick<SessionsRepo, 'getByNodeId'>,
): (nodeId: string) => Promise<HandoffSource | null> {
  const lookup = sessionLookup(repo);
  return async (nodeId) => {
    const node = await lookup(nodeId);
    return node === null ? null : loadHandoffSource(db, node);
  };
}
```
Replace `defaultSessionResumer` (lines 50-72) with:
```ts
/** The daemon's resumer: cc_sessions via SessionsRepo, live status via the registry, real tmux and git, handoffs under config.dataDir. */
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
        dataDir: deps.config.dataDir,
        live: registryLive(deps.config.sessions.claudeHome),
        repoCwds: async (name) =>
          (await repo().listForRepo(name, { limit: 200 }))
            .filter((item) => item.host === host && item.cwd !== null)
            .map((item) => item.cwd as string),
        loadHandoff: (node) => loadHandoffSource(deps.db, node),
      }),
  });
}
```
Replace lines 85-111 (route doc comment and `sessionResumeRoutes`) with:
```ts
/**
 * POST /api/sessions/:nodeId/resume {prompt?, fresh?} (own Origin only)
 * -> 200 {action: focused|messaged|resumed|spawned|attached, window?, cwd?, original_cwd?, job_id?, prompt_delivered?}
 *    (attached: a live background job got a new `claude attach <job_id>` window; prompt_delivered:false
 *    when a prompt was given, since that window cannot take it yet; spawned: a fresh session started
 *    with the node's handoff file via --append-system-prompt-file)
 * | 404 not_found | 404 not_on_this_machine {host} | 409 no_tmux | 409 live_outside_tmux {pid}
 * | 500 spawn_failed {message} | 400 invalid_json | 400 invalid_body {message} | 403 forbidden_origin.
 *
 * GET /api/sessions/:nodeId/handoff (any host, read only: no file, no git)
 * -> 200 {node_id, tokens, window, percent, baseline, exchanges_included, exchanges_total, truncated}:
 *    what a fresh spawn would carry and where the new session would start (percent of the old
 *    session's inferred window, baseline + handoff tokens)
 * | 400 invalid_node_id | 404 not_found {node_id}.
 */
export function sessionResumeRoutes(deps: AppDeps, opts: SessionResumeRoutesOptions = {}): Hono {
  let resumer = opts.resumer;
  const getResumer = (): SessionResumer => {
    resumer ??= defaultSessionResumer(deps);
    return resumer;
  };
  let handoffSource = opts.handoffSource;
  const getHandoffSource = (): ((nodeId: string) => Promise<HandoffSource | null>) => {
    handoffSource ??= handoffSourceLookup(deps.db, new SessionsRepo(deps.db));
    return handoffSource;
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

  r.get('/api/sessions/:nodeId/handoff', async (c) => {
    const nodeId = normalizeNodeId(c.req.param('nodeId'));
    if (nodeId === null) return c.json({ error: 'invalid_node_id' }, 400);
    const source = await getHandoffSource()(nodeId);
    if (source === null) return c.json({ error: 'not_found', node_id: nodeId }, 404);
    return c.json(handoffEstimateBody(source, new Date()));
  });

  return r;
}
```
**Impact:** A new read route with no Origin check, like the other session reads in `sessionsApi.ts`. `createApp` (`src/http/app.ts:120`) already mounts `sessionResumeRoutes(deps, { resumer })`, so the default `handoffSource` is used there. Phase 2's `/api/sessions/:nodeId/context` routes live in a different router on a different path, so they do not collide.

### Step 7: `session_resume` tool description
**File:** `src/mcp/sessionTools.ts:329` and `:340`
**Change:** In the `description` string at line 329, replace this sentence:
`fresh=true starts a new session whose first prompt is this node's summary, commits and plan docs (plus prompt) instead of resuming.`
with:
`fresh=true starts a new session instead of resuming: notesd writes a handoff file under its data dir (handoffs/) holding the node id, title, cwd and repo, transcript path, the stored summary with its age, plan docs, commits, the cwd's git status and git diff --stat, and every stored prompt with Claude's reply to it (when they do not fit half the node's context window, the first exchange and the newest ones that fit, with a note of how many were left out), loads it with --append-system-prompt-file, and sends a short first prompt that names the node and the file, then prompt as the task.`
Leave the rest of the string as it is. Replace line 340 with:
```ts
          .describe("true: start a new session carrying this node's handoff (summary, commits, git state, stored prompts and Claude's replies) instead of resuming it. Default false."),
```
**Impact:** Text only. `sessionResumeTool.test.ts` asserts no description text.

### Step 8: notes-prompt hook skips node ids for a handoff prompt
**File:** `claude/hooks/notes-prompt.mjs:6-10` (header), after `:314` (constants), `:462-477` (`runPrompt`); `claude/hooks/notes-prompt.d.mts:99`
**Change:** In the header comment, replace paragraph A (lines 6-10) with:
```js
 * A. Node ids (any prompt). A prompt that quotes a Claude Code session node id such as A0-3G
 *    (see the "Node ids" section below for what counts as one) gets that node's summary, plan
 *    docs, commits and transcript path from GET /api/sessions/context?ids=... (CONTEXT_TIMEOUT_MS,
 *    fail soft). Ids the daemon does not know add nothing. Finding candidates is one regex test on
 *    the prompt, so a prompt without one costs nothing. A prompt whose first line is exactly
 *    HANDOFF_MARKER (the first prompt of a "Spawn fresh" session, whose handoff is already in its
 *    system prompt) gets no node-id context: one string test, no I/O.
```
Insert after `NODE_TOOLS_HINT` (after line 314, before the `nodeIdCandidates` doc comment):
```js
/** First line of a "Spawn fresh" first prompt. Same text as src/sessions/handoff.ts HANDOFF_MARKER. */
export const HANDOFF_MARKER = '[notesd handoff]';

/** True when the prompt's first line is exactly HANDOFF_MARKER (a trailing \r tolerated). Pure: no I/O. */
export function isHandoffPrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.startsWith(HANDOFF_MARKER)) return false;
  const end = prompt.indexOf('\n');
  const first = end < 0 ? prompt : prompt.slice(0, end);
  return first.replace(/\r$/, '') === HANDOFF_MARKER;
}
```
Replace the `runPrompt` doc comment and its first two body lines (lines 462-477) so they read:
```js
/**
 * The hook output for one UserPromptSubmit input, or null to add nothing. Never throws.
 * Neither `/n` nor a node-id candidate: null before any I/O (no read, no fetch, no clock, no log).
 * A handoff prompt (isHandoffPrompt) counts as having no node-id candidate.
 */
export async function runPrompt({
  input,
  env,
  fetchImpl = globalThis.fetch,
  readText = (file) => readFile(file, 'utf8'),
  sleep = delay,
  now = Date.now,
  contextTimeoutMs = CONTEXT_TIMEOUT_MS,
}) {
  const prompt = input !== null && typeof input === 'object' && typeof input.prompt === 'string' ? input.prompt : '';
  const nodeIds = isHandoffPrompt(prompt) ? [] : nodeIdCandidates(prompt);
```
The rest of `runPrompt` is unchanged, so `/n` image handling is untouched. In `notes-prompt.d.mts`, insert before line 99 (`export function nodeIdCandidates…`):
```ts
export const HANDOFF_MARKER: string;
export function isHandoffPrompt(prompt: unknown): boolean;
```
**Impact:** Invariant 5 still holds: a marker prompt does no I/O either. `install.sh` symlinks/merges the hook from the repo, so the installed hook picks up the change once the code is deployed.

### Step 9: Resume unit tests
**File:** `tests/unit/sessions/resume.test.ts`
**Change:**
(a) Replace line 1 and add these imports after it:
```ts
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HANDOFF_MARKER, type HandoffSource } from '../../../src/sessions/handoff.js';
```
(b) Replace lines 29-77 (`SID` … end of `makeDeps`) with:
```ts
const SID = '6f1c2d3e-0000-4000-8000-00000000abcd';
const CLAUDE = '/opt/claude/claude.exe';
const GIT_STATUS = '## main...origin/main\n M src/sessions/resume.ts\n';
const GIT_DIFF_STAT = ' src/sessions/resume.ts | 12 ++++++------\n 1 file changed, 6 insertions(+), 6 deletions(-)\n';

let DATA_DIR = '';
beforeAll(async () => {
  DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'resume-handoffs-'));
});
afterAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

type Handler = (args: string[]) => string;

/**
 * A tmux that answers per subcommand; records every call (with any -S stripped in `sub`).
 * git calls go to `git` and are recorded apart in `gitCalls`.
 */
function fakeTmux(
  over: Partial<Record<string, Handler>> = {},
  git: Handler = (a) => (a.includes('status') ? GIT_STATUS : GIT_DIFF_STAT),
) {
  const calls: string[][] = [];
  const gitCalls: string[][] = [];
  const handlers: Record<string, Handler> = {
    'list-sessions': () => '100 work\n200 note\n 0 never\n',
    'list-clients': () => '50 /dev/pts/1\n90 /dev/pts/2\n',
    'list-panes': () => '%1\n%7\n',
    'display-message': (a) => (a.includes('#{pane_in_mode}') ? '0\n' : 'note:1\n'),
    'new-window': () => 'note:3 %12\n',
    ...over,
  } as Record<string, Handler>;
  const run: CommandRunner = async (cmd, args) => {
    if (cmd === 'git') {
      gitCalls.push([...args]);
      return git([...args]);
    }
    expect(cmd).toBe('tmux');
    calls.push([...args]);
    const a = args[0] === '-S' ? args.slice(2) : [...args];
    const h = handlers[a[0]!];
    return h === undefined ? '' : h(a);
  };
  const sub = (name: string): string[][] =>
    calls.map((c) => (c[0] === '-S' ? c.slice(2) : c)).filter((c) => c[0] === name);
  return { run, calls, sub, gitCalls };
}

/** Two stored exchanges of a 1M node. */
function handoffSource(n: ResumeNode): HandoffSource {
  return {
    node: n,
    summarizedAt: new Date(0),
    promptsComplete: true,
    exchanges: [
      { seq: 1, at: null, prompt: 'make photos deletable', promptTruncated: false, reply: 'Photos now have a delete button.', replyTruncated: false },
      { seq: 2, at: null, prompt: 'add an undo toast', promptTruncated: false, reply: 'Added the undo toast.', replyTruncated: false },
    ],
    context: { model: 'claude-opus-5-5', peakTokens: 300_000, longBeta: false },
    baselineTokens: 48_000,
  };
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
    dataDir: DATA_DIR,
    live: async () => over.liveEntry ?? null,
    isDir: async (p) => dirs.has(p),
    repoCwds: async () => [],
    loadHandoff: async (n) => handoffSource(n),
    now: () => clock.t,
    ...over,
  };
}

/** The handoff file named after --append-system-prompt-file in a claude argv. */
function handoffFileOf(argv: string[]): string {
  const i = argv.indexOf('--append-system-prompt-file');
  expect(i).toBeGreaterThan(-1);
  return argv[i + 1]!;
}
```
(c) Replace the `freshPrompt` test (lines 172-184) with:
```ts
  it('freshPrompt: marker first line, node, title and handoff file, then the task, within the byte budget', () => {
    const file = '/data/handoffs/A0-3G-20261112T030000.md';
    const p = freshPrompt(node(), file, 'add tests');
    expect(p.split('\n')[0]).toBe('[notesd handoff]');
    expect(p.split('\n')[0]).toBe(HANDOFF_MARKER);
    expect(p).toContain('A0-3G');
    expect(p).toContain('"wall editing"');
    expect(p).toContain(file);
    expect(p).toContain('system prompt');
    expect(p.endsWith('Task: add tests')).toBe(true);
    expect(p).not.toContain('Built the photo delete flow.');
    expect(freshPrompt(node(), file).endsWith('Read the handoff, then wait for my next instruction.')).toBe(true);
    const huge = freshPrompt(node(), file, 'x'.repeat(50_000));
    expect(Buffer.byteLength(huge, 'utf8')).toBeLessThanOrEqual(12_000);
    expect(huge.startsWith(`${HANDOFF_MARKER}\n`)).toBe(true);
  });
});
```
(d) Replace the fresh test (lines 260-277) with these four tests:
```ts
  it('fresh: writes the handoff and starts claude with --append-system-prompt-file and the marker prompt, child of the node, even while live', async () => {
    const t = fakeTmux();
    const out = await resumeNode(makeDeps(t.run, { liveEntry: { pid: 42, tmux: 'note:@0.%7' } }), node(), {
      fresh: true,
      prompt: 'write the README',
    });
    expect(out).toEqual({ status: 200, body: { action: 'spawned', window: 'note:3', cwd: '/home/u/mcp-notes' } });
    const [nw] = t.sub('new-window');
    const file = handoffFileOf(nw!);
    expect(path.dirname(file)).toBe(path.join(DATA_DIR, 'handoffs'));
    expect(path.basename(file)).toBe('A0-3G-19700101T001640.md');
    expect(nw).toEqual(
      newWindowArgv(
        '/home/u/mcp-notes',
        'A0-3G-new',
        claudeCommand(CLAUDE, ['--append-system-prompt-file', file, freshPrompt(node(), file, 'write the README')], {
          CC_PARENT_SESSION: SID,
        }),
      ),
    );
    expect(t.sub('select-window')).toEqual([]);
    const text = await readFile(file, 'utf8');
    expect(text).toContain('make photos deletable');
    expect(text).toContain('Added the undo toast.');
    expect(text).toContain('## main...origin/main');
    expect(text).toContain('1 file changed');
    expect(t.gitCalls).toEqual([
      ['--no-optional-locks', '-C', '/home/u/mcp-notes', 'status', '--porcelain=v1', '-b'],
      ['--no-optional-locks', '-C', '/home/u/mcp-notes', 'diff', '--stat'],
    ]);
  });

  it('fresh: a failing git still spawns, and the handoff says git state is unavailable', async () => {
    const t = fakeTmux({}, () => {
      throw new Error('fatal: not a git repository');
    });
    const out = await resumeNode(makeDeps(t.run), node(), { fresh: true });
    expect(out.body).toMatchObject({ action: 'spawned' });
    const text = await readFile(handoffFileOf(t.sub('new-window')[0]!), 'utf8');
    expect(text).toContain('Git state unavailable');
    expect(text).toContain('not a git repository');
    expect(text).not.toContain('## main...origin/main');
  });

  it('fresh with no tmux server writes no handoff', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'resume-nohandoff-'));
    try {
      const t = fakeTmux({
        'list-sessions': () => {
          throw new Error('no server running on /tmp/tmux-1000/default');
        },
      });
      const out = await resumeNode(makeDeps(t.run, { dataDir }), node(), { fresh: true });
      expect(out).toEqual({ status: 409, body: { error: 'no_tmux' } });
      expect(await readdir(dataDir)).toEqual([]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('fresh: a failing handoff load is spawn_failed and opens no window', async () => {
    const t = fakeTmux();
    const deps = makeDeps(t.run, {
      loadHandoff: async () => {
        throw new Error('db down');
      },
    });
    expect(await resumeNode(deps, node(), { fresh: true })).toEqual({
      status: 500,
      body: { error: 'spawn_failed', message: 'db down' },
    });
    expect(t.sub('new-window')).toEqual([]);
  });
```
The other tests (the PATH test that spawns fresh, the background-job fresh test at lines 470-476, `builds lazy deps once`) keep passing unchanged: their fresh spawns now write into `DATA_DIR`.
**Impact:** The test file only. 1,000,000 ms is `1970-01-01T00:16:40Z`, hence `A0-3G-19700101T001640.md`.

### Step 10: Handoff unit tests
**File:** `tests/unit/sessions/handoff.test.ts` (new)
**Code:**
```ts
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HANDOFF_MARKER as HOOK_MARKER } from '../../../claude/hooks/notes-prompt.mjs';
import {
  buildHandoff,
  DEFAULT_BASELINE_TOKENS,
  estimateTokens,
  formatAge,
  gitState,
  handoffBudget,
  handoffEstimateBody,
  handoffFileName,
  HANDOFF_MARKER,
  HANDOFF_MAX_AGE_MS,
  writeHandoff,
  type GitState,
  type HandoffExchange,
  type HandoffSource,
} from '../../../src/sessions/handoff.js';
import type { CommandRunner, ResumeNode } from '../../../src/sessions/resume.js';

const NOW = new Date('2026-11-12T03:00:00Z');
const SID = '6f1c2d3e-0000-4000-8000-00000000abcd';
const TRANSCRIPT = `/home/u/.claude/projects/-home-u-mcp-notes/${SID}.jsonl`;
const ONE_M = { model: 'claude-opus-5-5', peakTokens: 300_000, longBeta: false };
const UNKNOWN_200K = { model: 'glm-5.3', peakTokens: 10_000, longBeta: false };
const COLLECTED: GitState = {
  kind: 'collected',
  cwd: '/home/u/mcp-notes',
  status: '## main...origin/main\n M src/x.ts',
  diffStat: ' src/x.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)',
};

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
    transcriptPath: TRANSCRIPT,
    commits: ['abc123def456 feat: delete photos'],
    planDocs: ['docs/plans/WALL_PLAN.md'],
    ...over,
  };
}

/** n exchanges, each prompt and reply `chars` long, tagged <<PROMPT-k>> / <<REPLY-k>>. */
function exchanges(n: number, chars: number): HandoffExchange[] {
  return Array.from({ length: n }, (_, i) => ({
    seq: i + 1,
    at: new Date(NOW.getTime() - (n - i) * 60_000),
    prompt: `<<PROMPT-${i + 1}>> ${'p'.repeat(chars)}`,
    promptTruncated: false,
    reply: `<<REPLY-${i + 1}>> ${'r'.repeat(chars)}`,
    replyTruncated: false,
  }));
}

function source(over: Partial<HandoffSource> = {}): HandoffSource {
  return {
    node: node(),
    summarizedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    promptsComplete: true,
    exchanges: exchanges(3, 100),
    context: ONE_M,
    baselineTokens: DEFAULT_BASELINE_TOKENS,
    ...over,
  };
}

const keptSeqs = (text: string): number[] => [...text.matchAll(/^### Prompt (\d+)/gm)].map((m) => Number(m[1]));

describe('buildHandoff', () => {
  it('R4.1: a 1M node whose exchanges fit carries every prompt and reply', () => {
    const { text, estimate } = buildHandoff(source({ exchanges: exchanges(40, 2000) }), { now: NOW, git: COLLECTED });
    expect(estimate.window).toBe(1_000_000);
    expect(estimate).toMatchObject({ exchanges_included: 40, exchanges_total: 40, truncated: false });
    for (let k = 1; k <= 40; k += 1) {
      expect(text).toContain(`<<PROMPT-${k}>>`);
      expect(text).toContain(`<<REPLY-${k}>>`);
    }
    expect(text).toContain('All 40 stored exchanges follow');
    expect(estimate.tokens).toBe(estimateTokens(text));
    expect(estimate.percent).toBe(Math.round(((DEFAULT_BASELINE_TOKENS + estimate.tokens) / 1_000_000) * 1000) / 10);
  });

  it('R4.2: over budget it keeps the first exchange and the newest that fit, and says what was left out', () => {
    const { text, estimate } = buildHandoff(source({ exchanges: exchanges(60, 4000), context: UNKNOWN_200K }), {
      now: NOW,
      git: COLLECTED,
    });
    expect(estimate.window).toBe(200_000);
    expect(estimate.truncated).toBe(true);
    const kept = keptSeqs(text);
    expect(kept.length).toBe(estimate.exchanges_included);
    expect(kept.length).toBeGreaterThan(2);
    expect(kept.length).toBeLessThan(60);
    expect(kept[0]).toBe(1);
    expect(kept.slice(1)).toEqual(Array.from({ length: kept.length - 1 }, (_, i) => 60 - (kept.length - 2) + i));
    expect(text).toContain('<<REPLY-1>>');
    expect(text).not.toContain('<<PROMPT-2>>');
    expect(text).toContain(`${60 - kept.length} exchanges were left out`);
    expect(text).toContain(`Read the transcript ${TRANSCRIPT} for what was left out`);
    expect(estimate.tokens).toBeLessThanOrEqual(handoffBudget(200_000, DEFAULT_BASELINE_TOKENS));
    expect(estimate.percent).toBeLessThanOrEqual(50);
  });

  it('a first exchange bigger than the budget is cut to fit, and nothing newer is carried', () => {
    const giant: HandoffExchange = { ...exchanges(1, 0)[0]!, prompt: `<<PROMPT-1>> ${'g'.repeat(300_000)}` };
    const rest = exchanges(6, 100).slice(1);
    const { text, estimate } = buildHandoff(source({ exchanges: [giant, ...rest], context: UNKNOWN_200K }), {
      now: NOW,
      git: COLLECTED,
    });
    expect(keptSeqs(text)).toEqual([1]);
    expect(text).toContain('more characters left out');
    expect(text).toContain('The first exchange was cut to fit.');
    expect(estimate).toMatchObject({ exchanges_included: 1, exchanges_total: 6, truncated: true });
    expect(estimate.tokens).toBeLessThanOrEqual(handoffBudget(200_000, DEFAULT_BASELINE_TOKENS));
  });

  it('R4.3: the header names node, title, cwd, repo, transcript, summary with age, plan docs, commits and git state', () => {
    const { text } = buildHandoff(source(), { now: NOW, git: COLLECTED });
    for (const part of [
      'A0-3G',
      '"wall editing"',
      '- Cwd: /home/u/mcp-notes',
      '- Repo: mcp-notes',
      `- Transcript: ${TRANSCRIPT}`,
      'Written 2 hours ago (2026-11-12T01:00:00.000Z)',
      'may be older than the latest exchanges',
      'Built the photo delete flow.',
      '- docs/plans/WALL_PLAN.md',
      '- abc123def456 feat: delete photos',
      '`git status --porcelain=v1 -b`:',
      '## main...origin/main',
      '`git diff --stat`:',
      '1 file changed, 1 insertion(+), 1 deletion(-)',
    ]) {
      expect(text).toContain(part);
    }
    expect(buildHandoff(source({ node: node({ summary: null }) }), { now: NOW, git: COLLECTED }).text).toContain('Not summarized yet.');
  });

  it('R4.6: unavailable git state is said in the handoff; the estimate notes git is collected at spawn', () => {
    const failed = buildHandoff(source(), {
      now: NOW,
      git: { kind: 'unavailable', cwd: '/tmp/x', reason: 'git timed out after 5000 ms' },
    }).text;
    expect(failed).toContain('Git state unavailable for /tmp/x: git timed out after 5000 ms.');
    expect(failed).not.toContain('`git status --porcelain=v1 -b`:');
    expect(buildHandoff(source(), { now: NOW, git: { kind: 'not_collected' } }).text).toContain('collected at spawn time');
  });

  it('a legacy row says only excerpts are stored and marks missing replies', () => {
    const legacy = exchanges(2, 50).map((e) => ({ ...e, reply: null }));
    const { text, estimate } = buildHandoff(source({ promptsComplete: false, exchanges: legacy }), { now: NOW, git: COLLECTED });
    expect(text).toContain("Only excerpts of this session's prompts are stored");
    expect(text).toContain('(no reply stored)');
    expect(estimate).toMatchObject({ exchanges_included: 2, exchanges_total: 2, truncated: false });
  });

  it('no exchanges: says so and still estimates', () => {
    const { text, estimate } = buildHandoff(source({ exchanges: [] }), { now: NOW, git: COLLECTED });
    expect(text).toContain('No exchanges are stored for this session.');
    expect(estimate).toMatchObject({ exchanges_included: 0, exchanges_total: 0, truncated: false });
  });

  it('R4.7: handoffEstimateBody is the dry-run shape with the baseline', () => {
    const body = handoffEstimateBody(source({ baselineTokens: 40_000 }), NOW);
    expect(Object.keys(body).sort()).toEqual(
      ['baseline', 'exchanges_included', 'exchanges_total', 'node_id', 'percent', 'tokens', 'truncated', 'window'],
    );
    expect(body).toMatchObject({ node_id: 'A0-3G', baseline: 40_000, window: 1_000_000, exchanges_total: 3 });
  });

  it('formatAge', () => {
    expect(formatAge(-5)).toBe('0 minutes');
    expect(formatAge(60_000)).toBe('1 minute');
    expect(formatAge(2 * 3_600_000)).toBe('2 hours');
    expect(formatAge(3 * 86_400_000)).toBe('3 days');
  });

  it('the marker is the same text the notes-prompt hook tests for', () => {
    expect(HANDOFF_MARKER).toBe('[notesd handoff]');
    expect(HOOK_MARKER).toBe(HANDOFF_MARKER);
  });
});

describe('gitState', () => {
  it('runs status and diff --stat in the cwd', async () => {
    const calls: Array<[string, string[]]> = [];
    const run: CommandRunner = async (cmd, args) => {
      calls.push([cmd, [...args]]);
      return args.includes('status') ? '## main\n M a.ts\n' : ' a.ts | 1 +\n';
    };
    expect(await gitState(run, '/repo')).toEqual({ kind: 'collected', cwd: '/repo', status: '## main\n M a.ts', diffStat: ' a.ts | 1 +' });
    expect(calls).toEqual([
      ['git', ['--no-optional-locks', '-C', '/repo', 'status', '--porcelain=v1', '-b']],
      ['git', ['--no-optional-locks', '-C', '/repo', 'diff', '--stat']],
    ]);
  });

  it('R4.6: a failing git is unavailable with the reason, never a throw', async () => {
    const run: CommandRunner = async () => {
      throw new Error('Command failed: git -C /tmp status\nfatal: not a git repository');
    };
    expect(await gitState(run, '/tmp')).toEqual({
      kind: 'unavailable',
      cwd: '/tmp',
      reason: 'Command failed: git -C /tmp status fatal: not a git repository',
    });
  });

  it('R4.6: a git that never answers times out as unavailable', async () => {
    const run: CommandRunner = () => new Promise<string>(() => undefined);
    expect(await gitState(run, '/repo', 20)).toEqual({ kind: 'unavailable', cwd: '/repo', reason: 'git timed out after 20 ms' });
  });
});

describe('writeHandoff', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'handoff-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('R4.4: writes <dataDir>/handoffs/<NODE>-<stamp>.md, creating the folder', async () => {
    expect(handoffFileName('A0-3G', NOW)).toBe('A0-3G-20261112T030000.md');
    const file = await writeHandoff(dir, 'A0-3G', 'hello handoff', NOW);
    expect(file).toBe(path.join(dir, 'handoffs', 'A0-3G-20261112T030000.md'));
    expect(await readFile(file, 'utf8')).toBe('hello handoff');
  });

  it('prunes handoffs older than 14 days and keeps fresh ones and other files', async () => {
    const hdir = path.join(dir, 'handoffs');
    await mkdir(hdir, { recursive: true });
    const old = path.join(hdir, 'B1-2C-20261020T000000.md');
    const fresh = path.join(hdir, 'B1-2C-20261110T000000.md');
    const other = path.join(hdir, 'keep.txt');
    for (const f of [old, fresh, other]) await writeFile(f, 'x');
    const oldTime = new Date(NOW.getTime() - HANDOFF_MAX_AGE_MS - 60_000);
    await utimes(old, oldTime, oldTime);
    await utimes(other, oldTime, oldTime);
    const recent = new Date(NOW.getTime() - 2 * 86_400_000);
    await utimes(fresh, recent, recent);
    await writeHandoff(dir, 'A0-3G', 'new', NOW);
    expect((await readdir(hdir)).sort()).toEqual(['A0-3G-20261112T030000.md', 'B1-2C-20261110T000000.md', 'keep.txt']);
  });
});
```
**Impact:** A new test file. The 200k test relies on Phase 1 inferring 200,000 for `glm-5.3` with peak 10,000 and no beta (R2.4). The 1M tests rely on peak 300,000 giving 1,000,000 (R2.2).

### Step 11: Route and hook unit tests
**File:** `tests/unit/sessions/sessionResumeRoute.test.ts` (append after line 78, before `describe('registryLive …`), plus imports; `tests/unit/hooks/notesPrompt.test.ts` (imports at lines 10-35, new describe after the `runPrompt: node ids` describe, before line 669)
**Change:** In `sessionResumeRoute.test.ts`, add to the imports:
```ts
import { DEFAULT_BASELINE_TOKENS, type HandoffSource } from '../../../src/sessions/handoff.js';
```
and append:
```ts
describe('GET /api/sessions/:nodeId/handoff', () => {
  function source(nodeId: string, baselineTokens = 40_000): HandoffSource {
    return {
      node: {
        sessionId: '6f1c2d3e-0000-4000-8000-00000000abcd',
        nodeId,
        host: 'GPD',
        repo: 'mcp-notes',
        cwd: '/home/u/mcp-notes',
        name: null,
        title: 'estimate',
        summary: null,
        firstPrompt: null,
        transcriptPath: null,
        commits: [],
        planDocs: [],
      },
      summarizedAt: null,
      promptsComplete: true,
      exchanges: [1, 2, 3].map((seq) => ({ seq, at: null, prompt: `p${seq}`, promptTruncated: false, reply: `r${seq}`, replyTruncated: false })),
      context: { model: 'claude-opus-5-5', peakTokens: 300_000, longBeta: false },
      baselineTokens,
    };
  }

  it('answers the dry-run estimate for any spelling of the id, with no Origin needed', async () => {
    const asked: string[] = [];
    const app = sessionResumeRoutes(NO_DEPS, {
      handoffSource: async (id) => {
        asked.push(id);
        return source(id);
      },
    });
    const res = await app.request('/api/sessions/a03g/handoff');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(asked).toEqual(['A0-3G']);
    expect(Object.keys(body).sort()).toEqual(
      ['baseline', 'exchanges_included', 'exchanges_total', 'node_id', 'percent', 'tokens', 'truncated', 'window'],
    );
    expect(body).toMatchObject({
      node_id: 'A0-3G',
      window: 1_000_000,
      baseline: 40_000,
      exchanges_included: 3,
      exchanges_total: 3,
      truncated: false,
    });
    expect(body.percent).toBe(Math.round(((40_000 + (body.tokens as number)) / 1_000_000) * 1000) / 10);
  });

  it('400 invalid_node_id for a non-id, 404 not_found for an unknown one', async () => {
    const app = sessionResumeRoutes(NO_DEPS, { handoffSource: async () => null });
    const bad = await app.request('/api/sessions/not-a-node-id/handoff');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_node_id' });
    const missing = await app.request('/api/sessions/ZZ-ZZ/handoff');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found', node_id: 'ZZ-ZZ' });
  });

  it('a repo with no baseline sample is estimated at the default baseline', async () => {
    const app = sessionResumeRoutes(NO_DEPS, { handoffSource: async (id) => source(id, DEFAULT_BASELINE_TOKENS) });
    expect(((await (await app.request('/api/sessions/A0-3G/handoff')).json()) as { baseline: number }).baseline).toBe(48_000);
  });
});
```
In `notesPrompt.test.ts`, add `HANDOFF_MARKER,` and `isHandoffPrompt,` to the import list from `notes-prompt.mjs`, and add before line 669:
```ts
describe('runPrompt: a Spawn fresh handoff prompt', () => {
  const HANDOFF_PROMPT = [
    HANDOFF_MARKER,
    'You continue Claude Code session A0-3G ("wall editing").',
    "Its full handoff (summary, plan docs, commits, git state, and the stored prompts with Claude's replies) is in your system prompt; the same text is in /d/handoffs/A0-3G-20261112T030000.md.",
    '',
    'Read the handoff, then wait for my next instruction.',
  ].join('\n');

  it('isHandoffPrompt takes only an exact first line', () => {
    expect(isHandoffPrompt(HANDOFF_PROMPT)).toBe(true);
    expect(isHandoffPrompt(`${HANDOFF_MARKER}\r\ncontinue A0-3G`)).toBe(true);
    expect(isHandoffPrompt(HANDOFF_MARKER)).toBe(true);
    expect(isHandoffPrompt(`${HANDOFF_MARKER} A0-3G`)).toBe(false);
    expect(isHandoffPrompt(` ${HANDOFF_MARKER}\nA0-3G`)).toBe(false);
    expect(isHandoffPrompt(`continue A0-3G\n${HANDOFF_MARKER}`)).toBe(false);
    expect(isHandoffPrompt(undefined)).toBe(false);
  });

  it('R4.5: adds no node-id context and does no I/O for a handoff prompt that names a node', async () => {
    const daemon = fakeContextDaemon([NODE]);
    let reads = 0;
    const readText = async (): Promise<string> => {
      reads += 1;
      return '';
    };
    const out = await runPrompt({ input: hookInput(HANDOFF_PROMPT), env, fetchImpl: daemon.fetchImpl, readText, ...fakeClock() });
    expect(out).toBeNull();
    expect(daemon.urls).toEqual([]);
    expect(reads).toBe(0);
    expect(existsSync(path.join(tmp, 'state'))).toBe(false);
  });

  it('the same text without the marker line still resolves the node', async () => {
    const daemon = fakeContextDaemon([NODE]);
    const withoutMarker = HANDOFF_PROMPT.split('\n').slice(1).join('\n');
    const out = await runPrompt({ input: hookInput(withoutMarker), env, fetchImpl: daemon.fetchImpl, ...fakeClock() });
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: NODE_BLOCK } });
  });
});
```
**Impact:** Test files only.

### Step 12: Integration test with real rows
**File:** `tests/integration/sessions.resume.int.test.ts` (whole file replaced)
**Change:** Keep the two existing behaviours (row → ResumeNode, local resume plus other-host refusal) and add fresh-spawn and estimate journeys against real `cc_sessions` / `cc_session_prompts` / `cc_session_replies` rows. tmux and git are a fake runner. Phase 1's columns are set with raw SQL by column name.
**Code:**
```ts
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ccSessionPrompts, ccSessionReplies, ccSessions } from '../../src/db/schema.js';
import type { AppDeps } from '../../src/deps.js';
import { sessionLookup, sessionResumeRoutes } from '../../src/http/sessionResume.js';
import { DEFAULT_BASELINE_TOKENS, HANDOFF_MARKER, loadHandoffSource } from '../../src/sessions/handoff.js';
import { generateNodeId, normalizeNodeId } from '../../src/sessions/ids.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createSessionResumer, type CommandRunner, type ResumeDeps } from '../../src/sessions/resume.js';
import { PROMPTS_VERSION } from '../../src/sessions/types.js';
import { closeTestDb, openTestDb } from './setup.js';

const db = openTestDb();
const created: string[] = [];
let dataDir = '';

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'resume-int-'));
});

afterAll(async () => {
  if (created.length > 0) await db.delete(ccSessions).where(inArray(ccSessions.sessionId, created));
  await rm(dataDir, { recursive: true, force: true });
  await closeTestDb(db);
});

interface InsertOptions {
  host: string;
  repo?: string;
  model?: string | null;
  peak?: number | null;
  first?: number | null;
  /** Marks the row a fork (fork_detected_by = 'job'); the baseline leaves it out. */
  fork?: boolean;
  exchanges?: number;
  chars?: number;
}

async function insert(opts: InsertOptions): Promise<{ sessionId: string; nodeId: string; transcriptPath: string }> {
  const sessionId = randomUUID();
  const nodeId = generateNodeId();
  const transcriptPath = `/home/u/.claude/projects/x/${sessionId}.jsonl`;
  const exchanges = opts.exchanges ?? 0;
  created.push(sessionId);
  await db.insert(ccSessions).values({
    sessionId,
    nodeId,
    host: opts.host,
    repo: opts.repo ?? 'mcp-notes',
    cwd: '/nonexistent/worktree',
    name: 'impl-x-p9',
    aiTitle: 'resume test',
    summary: 'A summary.',
    summarizedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    transcriptPath,
    commits: [{ sha: 'abc123def4567890', subject: 'feat: resume', at: null }],
    planDocs: ['docs/plans/PROJECT_SESSION_GRAPH_PLAN.md'],
    entrypoint: 'cli',
    startedAt: new Date(),
    promptsVersion: exchanges > 0 ? PROMPTS_VERSION : 0,
  });
  await db.execute(sql`
    update cc_sessions
    set context_model = ${opts.model ?? null}, context_peak_tokens = ${opts.peak ?? null},
        context_first_tokens = ${opts.first ?? null},
        fork_detected_by = ${opts.fork === true ? 'job' : null}
    where session_id = ${sessionId}`);
  if (exchanges > 0) {
    const chars = opts.chars ?? 100;
    const seqs = Array.from({ length: exchanges }, (_, i) => i + 1);
    await db.insert(ccSessionPrompts).values(seqs.map((seq) => ({ sessionId, seq, text: `<<PROMPT-${seq}>> ${'p'.repeat(chars)}` })));
    await db.insert(ccSessionReplies).values(seqs.map((seq) => ({ sessionId, seq, text: `<<REPLY-${seq}>> ${'r'.repeat(chars)}` })));
  }
  return { sessionId, nodeId, transcriptPath };
}

interface FakeRun {
  run: CommandRunner;
  tmux: string[][];
  git: string[][];
}

/** tmux answers list-sessions / new-window; git answers status / diff --stat, or fails. */
function fakeRun(gitFails = false): FakeRun {
  const tmux: string[][] = [];
  const git: string[][] = [];
  const run: CommandRunner = async (cmd, args) => {
    if (cmd === 'git') {
      git.push([...args]);
      if (gitFails) throw new Error('Command failed: git status\nfatal: not a git repository');
      return args.includes('status') ? '## main...origin/main\n M src/x.ts\n' : ' src/x.ts | 2 +-\n 1 file changed\n';
    }
    tmux.push([...args]);
    if (args[0] === 'list-sessions') return '10 note\n';
    if (args[0] === 'new-window') return 'note:5 %30\n';
    return '';
  };
  return { run, tmux, git };
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
    dataDir,
    live: async () => null,
    isDir: async (p) => p === '/home/u',
    repoCwds: async () => [],
    loadHandoff: (node) => loadHandoffSource(db, node),
    now: () => Date.now(),
  };
}

function spawnedArgv(f: FakeRun): string[] {
  const argv = f.tmux.find((a) => a[0] === 'new-window');
  expect(argv).toBeDefined();
  return argv!;
}

function handoffFile(argv: string[]): string {
  const i = argv.indexOf('--append-system-prompt-file');
  expect(i).toBeGreaterThan(-1);
  return argv[i + 1]!;
}

async function unusedNodeId(repo: SessionsRepo): Promise<string> {
  let id = generateNodeId();
  while ((await repo.getByNodeId(id)) !== null) id = generateNodeId();
  return id;
}

describe('session resume against cc_sessions', () => {
  const repo = new SessionsRepo(db);
  const lookup = sessionLookup(repo);

  it('maps a real row into a ResumeNode', async () => {
    const { sessionId, nodeId } = await insert({ host: 'this-host' });
    expect(await lookup(nodeId)).toMatchObject({
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
    const local = await insert({ host: 'this-host' });
    const remote = await insert({ host: 'GPD' });
    const f = fakeRun();
    const resumer = createSessionResumer({ normalize: normalizeNodeId, lookup, deps: deps(f.run) });
    expect(await resumer.resume(local.nodeId.toLowerCase().replace('-', ''), {})).toEqual({
      status: 200,
      body: { action: 'resumed', window: 'note:5', cwd: '/home/u', original_cwd: '/nonexistent/worktree' },
    });
    const before = f.tmux.length;
    expect(await resumer.resume(remote.nodeId, {})).toEqual({ status: 404, body: { error: 'not_on_this_machine', host: 'GPD' } });
    expect(f.tmux.length).toBe(before);
    expect(await resumer.resume(await unusedNodeId(repo), {})).toEqual({ status: 404, body: { error: 'not_found' } });
  });

  it('R4.1/R4.3/R4.4: spawn fresh from a 1M node carries every stored exchange, the header and git state, through --append-system-prompt-file', async () => {
    const n = await insert({ host: 'this-host', model: 'claude-opus-5-5', peak: 300_000, exchanges: 30, chars: 2000 });
    const f = fakeRun();
    const resumer = createSessionResumer({ normalize: normalizeNodeId, lookup, deps: deps(f.run) });
    expect(await resumer.resume(n.nodeId, { fresh: true, prompt: 'finish the tests' })).toEqual({
      status: 200,
      body: { action: 'spawned', window: 'note:5', cwd: '/home/u', original_cwd: '/nonexistent/worktree' },
    });
    const argv = spawnedArgv(f);
    const file = handoffFile(argv);
    expect(path.dirname(file)).toBe(path.join(dataDir, 'handoffs'));
    expect(path.basename(file)).toMatch(new RegExp(`^${n.nodeId}-\\d{8}T\\d{6}\\.md$`));
    expect(argv).toContain(`CC_PARENT_SESSION=${n.sessionId}`);
    const first = argv[argv.length - 1]!;
    expect(first.split('\n')[0]).toBe(HANDOFF_MARKER);
    expect(first).toContain(n.nodeId);
    expect(first).toContain(file);
    expect(first.endsWith('Task: finish the tests')).toBe(true);
    const text = await readFile(file, 'utf8');
    for (let seq = 1; seq <= 30; seq += 1) {
      expect(text).toContain(`<<PROMPT-${seq}>>`);
      expect(text).toContain(`<<REPLY-${seq}>>`);
    }
    expect(text).toContain('All 30 stored exchanges follow');
    for (const part of [
      n.nodeId,
      '"resume test"',
      '- Cwd: /nonexistent/worktree',
      '- Repo: mcp-notes',
      `- Transcript: ${n.transcriptPath}`,
      'A summary.',
      'Written 2 hours ago',
      'may be older than the latest exchanges',
      '- docs/plans/PROJECT_SESSION_GRAPH_PLAN.md',
      '- abc123def456 feat: resume',
      '`git status --porcelain=v1 -b`:',
      '## main...origin/main',
      '`git diff --stat`:',
      '1 file changed',
    ]) {
      expect(text).toContain(part);
    }
    expect(f.git).toEqual([
      ['--no-optional-locks', '-C', '/home/u', 'status', '--porcelain=v1', '-b'],
      ['--no-optional-locks', '-C', '/home/u', 'diff', '--stat'],
    ]);
  });

  it('R4.2: spawn fresh from a 200k node carries the first exchange and the newest that fit, and says what was left out', async () => {
    const n = await insert({ host: 'this-host', model: 'glm-5.3', peak: 20_000, exchanges: 80, chars: 4000 });
    const f = fakeRun();
    const resumer = createSessionResumer({ normalize: normalizeNodeId, lookup, deps: deps(f.run) });
    expect((await resumer.resume(n.nodeId, { fresh: true })).body).toMatchObject({ action: 'spawned' });
    const text = await readFile(handoffFile(spawnedArgv(f)), 'utf8');
    const kept = [...text.matchAll(/^### Prompt (\d+)/gm)].map((m) => Number(m[1]));
    expect(kept[0]).toBe(1);
    expect(kept[kept.length - 1]).toBe(80);
    expect(kept.length).toBeGreaterThan(2);
    expect(kept.length).toBeLessThan(80);
    expect(kept.slice(1)).toEqual(Array.from({ length: kept.length - 1 }, (_, i) => 80 - (kept.length - 2) + i));
    expect(text).toContain('<<REPLY-1>>');
    expect(text).not.toContain('<<PROMPT-2>>');
    expect(text).toContain(`${80 - kept.length} exchanges were left out`);
    expect(text).toContain(n.transcriptPath);
  });

  it('R4.6: a failing git still spawns; the handoff has no git state and says so', async () => {
    const n = await insert({ host: 'this-host', model: 'claude-opus-5-5', peak: 300_000, exchanges: 2 });
    const f = fakeRun(true);
    const resumer = createSessionResumer({ normalize: normalizeNodeId, lookup, deps: deps(f.run) });
    expect((await resumer.resume(n.nodeId, { fresh: true })).body).toMatchObject({ action: 'spawned' });
    const text = await readFile(handoffFile(spawnedArgv(f)), 'utf8');
    expect(text).toContain('Git state unavailable for /home/u');
    expect(text).toContain('not a git repository');
    expect(text).not.toContain('## main...origin/main');
  });

  it('R4.7: GET /api/sessions/:nodeId/handoff answers the estimate from real rows, on any host, writing no file', async () => {
    const repoName = `handoff-int-${randomUUID().slice(0, 8)}`;
    for (const first of [30_000, 40_000, 50_000]) await insert({ host: 'GPD', repo: repoName, first });
    // Forks carry their parent's history in their first message: two big ones must not move the median.
    for (const first of [400_000, 500_000]) await insert({ host: 'GPD', repo: repoName, first, fork: true });
    const n = await insert({ host: 'GPD', repo: repoName, model: 'claude-opus-5-5', peak: 300_000, exchanges: 12, chars: 500 });
    const estDir = await mkdtemp(path.join(os.tmpdir(), 'handoff-est-'));
    try {
      const app = sessionResumeRoutes({ db, config: { dataDir: estDir } } as unknown as AppDeps);
      const res = await app.request(`/api/sessions/${n.nodeId.toLowerCase().replace('-', '')}/handoff`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tokens: number; percent: number };
      expect(body).toMatchObject({
        node_id: n.nodeId,
        window: 1_000_000,
        baseline: 40_000,
        exchanges_included: 12,
        exchanges_total: 12,
        truncated: false,
      });
      expect(body.tokens).toBeGreaterThan((12 * 2 * 500) / 4);
      expect(body.percent).toBe(Math.round(((40_000 + body.tokens) / 1_000_000) * 1000) / 10);
      expect(existsSync(path.join(estDir, 'handoffs'))).toBe(false);

      const lonely = await insert({ host: 'GPD', repo: `handoff-int-${randomUUID().slice(0, 8)}` });
      const lonelyBody = await (await app.request(`/api/sessions/${lonely.nodeId}/handoff`)).json();
      expect(lonelyBody).toMatchObject({ baseline: DEFAULT_BASELINE_TOKENS, exchanges_total: 0, truncated: false });

      const unknown = await app.request(`/api/sessions/${await unusedNodeId(repo)}/handoff`);
      expect(unknown.status).toBe(404);
      expect(((await unknown.json()) as { error: string }).error).toBe('not_found');
    } finally {
      await rm(estDir, { recursive: true, force: true });
    }
  });
});
```
**Impact:** Integration only. It needs Phase 1's migration `0016` applied, which `scripts/test-int.sh` does through `migrateTestDb`.

## Principles applied

- Subtract before you add: `freshPrompt` loses its summary/plan-docs/commits body rather than keeping it next to the handoff. The handoff is the one carrier, and the first prompt only points at it (Step 3). The hook marker also removes the second copy the notes-prompt hook used to add (Step 8).
- Laziness protocol: `loadHandoffSource` takes the `ResumeNode` the resumer already looked up, so title, commits and plan docs come from the existing `toResumeNode`, and legacy excerpts reuse `view.ts` `normalizePrompts` instead of new parsers. The route reuses `sessionLookup`. `app.ts` is not touched because the GET route joins the router that is already mounted.
- Make illegal states unrepresentable: git state is the union `collected | unavailable | not_collected`, not a nullable pair of strings plus a flag. The dry-run estimate passes `not_collected`, so "the estimate ran git" cannot be built, and an unavailable state always carries its reason for the handoff text (Step 1).
- Boundary discipline: the node id is normalized once in the route (`normalizeNodeId`, 400 on null). DB values (bigint strings, timestamps, unredacted legacy excerpts) are normalized and redacted once in `loadHandoffSource`. `buildHandoff` trusts its typed `HandoffSource` and stays pure (clock and git passed in).
- Encode lessons in structure: the marker string lives in two places (server `handoff.ts`, hook `.mjs`, which cannot import TS). A unit test asserts they are equal (`handoff.test.ts` "the marker is the same text"), as `notesPrompt.test.ts` already does for `CONTEXT_HEADER`.
- Test behavior, not implementation: the tests assert the tmux argv, the written file's text, the HTTP body and the hook's output. None of them spy on `buildHandoff`/`gitState` calls inside `resumeNode`.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test && npm run test:int -- tests/integration/sessions.resume.int.test.ts`
**Proof:** The real daemon from this checkout, with a fake tmux binary and `/bin/true` as claude so nothing real spawns, writes the handoff file and answers the estimate. The real hook process gets the marker prompt against that daemon.
- Harness: `.claude/skills/verify-notesd`. The harness's "never drive resume" gotcha exists because resume spawns real tmux windows. These journeys start the run with `NOTESD_TMUX_BIN` pointing at a logging fake and `NOTESD_CLAUDE_BIN=/bin/true` (`up` passes the caller's environment through to the daemon). J0 checks the daemon really has them before any POST.
- Feature-map entries: none in this phase. `features/projects.md` belongs to Phase 4 (see Handoffs).
- Setup (run once, from the worktree root; every journey below uses these variables):
  ```sh
  cd /home/miftah/.worktrees/mcp-notes/session-context-rot
  V=.claude/skills/verify-notesd/scripts/verify.sh
  S=$(mktemp -d)                                   # scratch for the fake tmux, its log, the seed SQL
  cat > "$S/fake-tmux" <<EOF
  #!/usr/bin/env bash
  { echo "--- call"; printf '%s\n' "\$@"; } >> "$S/tmux.log"
  case "\$1" in
    list-sessions) echo "100 verify" ;;
    new-window) echo "verify:1 %99" ;;
  esac
  exit 0
  EOF
  chmod +x "$S/fake-tmux"
  eval "$(NOTESD_TMUX_BIN="$S/fake-tmux" NOTESD_CLAUDE_BIN=/bin/true $V up | grep -E '^(RUN|URL|EVIDENCE)=')"
  D="$HOME/.local/state/notesd-verify/$RUN"; PORT=$(cat "$D/port")
  HOST=$(node -p 'require("os").hostname()'); WT=$(pwd)
  cat > "$S/seed.sql" <<EOF
  insert into cc_sessions (session_id,node_id,host,repo,cwd,ai_title,summary,summarized_at,transcript_path,entrypoint,prompts_version,commits,plan_docs,started_at,context_model,context_peak_tokens,context_first_tokens) values
   ('11111111-1111-4111-8111-111111111111','ZH-1M','$HOST','verify-repo','$WT','handoff 1m','The 1M summary.',now()-interval '2 hours','/tmp/verify-handoff/ZH-1M.jsonl','cli',3,'[{"sha":"abc123def4567890","subject":"feat: verify handoff","at":null}]','["docs/plans/VERIFY_PLAN.md"]',now(),'claude-opus-5-5',300000,40000),
   ('22222222-2222-4222-8222-222222222222','ZH-2K','$HOST','verify-repo','$WT','handoff 200k','The 200k summary.',now()-interval '3 hours','/tmp/verify-handoff/ZH-2K.jsonl','cli',3,'[]','[]',now(),'glm-5.3',20000,null),
   ('33333333-3333-4333-8333-333333333333','ZH-GF','$HOST','verify-repo','/tmp','handoff nogit',null,null,'/tmp/verify-handoff/ZH-GF.jsonl','cli',3,'[]','[]',now(),'claude-opus-5-5',300000,null);
  insert into cc_session_prompts (session_id,seq,text) select '11111111-1111-4111-8111-111111111111', g, '<<PROMPT-'||g||'>> '||repeat('p',2000) from generate_series(1,30) g;
  insert into cc_session_replies (session_id,seq,text) select '11111111-1111-4111-8111-111111111111', g, '<<REPLY-'||g||'>> '||repeat('r',2000) from generate_series(1,30) g;
  insert into cc_session_prompts (session_id,seq,text) select '22222222-2222-4222-8222-222222222222', g, '<<PROMPT-'||g||'>> '||repeat('p',4000) from generate_series(1,80) g;
  insert into cc_session_replies (session_id,seq,text) select '22222222-2222-4222-8222-222222222222', g, '<<REPLY-'||g||'>> '||repeat('r',4000) from generate_series(1,80) g;
  insert into cc_session_prompts (session_id,seq,text) values ('33333333-3333-4333-8333-333333333333',1,'<<PROMPT-1>> hi');
  EOF
  $V exec "$RUN" "$(cat "$S/seed.sql")"
  ```
- Safety gate (not a journey): `tr '\0' '\n' < /proc/$(cat "$D/pid")/environ | grep -x "NOTESD_TMUX_BIN=$S/fake-tmux"` must print the line, and the same check must pass for `NOTESD_CLAUDE_BIN=/bin/true`. If either prints nothing, run `$V down "$RUN"` and stop: do not POST resume.
- Journeys:
  - **J1** · traces R4.7 — `$V api "$RUN" GET /api/sessions/zh1m/handoff; ls "$D/data/handoffs" 2>&1; $V api "$RUN" GET /api/sessions/not-an-id/handoff; $V api "$RUN" GET /api/sessions/ZZ-ZZ/handoff` → passes when the first answer is 200 with `node_id` `"ZH-1M"`, `window` 1000000, `baseline` 40000, `exchanges_included` 30, `exchanges_total` 30, `truncated` false, and `percent` equal to `round1((40000+tokens)/1000000*100)`; `ls` reports `No such file or directory`; the second is 400 `{"error":"invalid_node_id"}`; the third is 404 with `"error":"not_found"`.
  - **J2** · traces R4.1, R4.3, R4.4 — `$V api "$RUN" POST /api/sessions/ZH-1M/resume '{"fresh":true,"prompt":"finish the tests"}'; F=$(ls "$D"/data/handoffs/ZH-1M-*.md); grep -c '^### Prompt ' "$F"; grep -c '<<REPLY-' "$F"; grep -A1 -- '--append-system-prompt-file' "$S/tmux.log"; grep -n -E 'ZH-1M|handoff 1m|Cwd: |Repo: verify-repo|/tmp/verify-handoff/ZH-1M.jsonl|Written 2 hours ago|VERIFY_PLAN.md|abc123def456 feat: verify handoff|git status --porcelain=v1 -b|git diff --stat|^## [^A-Z]' "$F"` → passes when the POST answers 200 `{"action":"spawned",…}`. Exactly one `ZH-1M-<yyyymmddThhmmss>.md` exists under `$D/data/handoffs/`. Both counts print `30`. The tmux log shows `--append-system-prompt-file` followed by that same path. The next logged argument starts with the line `[notesd handoff]` and names `ZH-1M` and the file. The grep shows node id, title, cwd (`$WT`), repo, transcript path, "Written 2 hours ago", the plan doc, the commit, both git headings, and a lower-case `## <branch>` line from the worktree's real `git status` (the handoff's own headings are capitalized).
  - **J3** · traces R4.2 — `$V api "$RUN" GET /api/sessions/ZH-2K/handoff; $V api "$RUN" POST /api/sessions/ZH-2K/resume '{"fresh":true}'; F=$(ls "$D"/data/handoffs/ZH-2K-*.md); grep -o '^### Prompt [0-9]*' "$F" | head -2; grep -o '^### Prompt [0-9]*' "$F" | tail -1; grep -c '<<PROMPT-2>>' "$F"; grep -o '[0-9]* exchanges were left out' "$F"; grep -c '/tmp/verify-handoff/ZH-2K.jsonl' "$F"` → passes when the estimate says `window` 200000, `truncated` true, `exchanges_total` 80, `exchanges_included` < 80. The file's first heading is `### Prompt 1` and its second is a number above 2. The last is `### Prompt 80`. `<<PROMPT-2>>` counts `0`. "N exchanges were left out" prints N = 80 − included. The transcript path counts at least 1.
  - **J4** · traces R4.6 — `$V api "$RUN" POST /api/sessions/ZH-GF/resume '{"fresh":true}'; grep -n 'Git state unavailable for /tmp' "$D"/data/handoffs/ZH-GF-*.md` → passes when the POST answers 200 spawned and the grep prints one line containing `not a git repository` (the real `git -C /tmp status` failed and the handoff says so).
  - **J5** · traces R4.5 — `printf '%s' '{"session_id":"s","transcript_path":"/nonexistent","prompt":"[notesd handoff]\nYou continue Claude Code session ZH-1M (\"handoff 1m\").\n\nRead the handoff, then wait for my next instruction."}' | NOTESD_PORT=$PORT XDG_STATE_HOME="$S/state" node claude/hooks/notes-prompt.mjs; echo "exit=$?"; printf '%s' '{"session_id":"s","transcript_path":"/nonexistent","prompt":"You continue Claude Code session ZH-1M (\"handoff 1m\")."}' | NOTESD_PORT=$PORT XDG_STATE_HOME="$S/state" node claude/hooks/notes-prompt.mjs` → passes when the first run prints only `exit=0` (no JSON line) and the control run without the marker prints one JSON line whose `additionalContext` contains `ZH-1M`. That shows the daemon knows the node and the marker alone suppressed the block.
  - **J6** · traces R4.6 — `npx vitest run tests/unit/sessions/handoff.test.ts -t "gitState"` → passes when the three gitState tests pass, including `a git that never answers times out as unavailable` (the timeout half of R4.6, which no real git can be made to show on demand).
  - **J7** · traces R4.1, R4.2, R4.3, R4.4, R4.6, R4.7 — `npm run test:int -- tests/integration/sessions.resume.int.test.ts` → passes when all 7 tests pass against the Docker Postgres (real rows, fake tmux/git, real files under a temp dataDir).
- Neighbor check: plain resume must be unchanged. `$V api "$RUN" POST /api/sessions/ZH-1M/resume '{}'`, then `tail -n 12 "$S/tmux.log"` → 200 `{"action":"resumed",…}`, the last `new-window` call ends with `/bin/true` (resolved claude), `--resume`, `11111111-1111-4111-8111-111111111111`, and it has no `--append-system-prompt-file`. Also `npx vitest run tests/unit/sessions/resume.test.ts tests/unit/hooks/notesPrompt.test.ts` stays green, which covers the background-job attach paths and the `/n` image paths.
- Cleanup: `$V down "$RUN"; rm -rf "$S"`.
- Cost: none (no LLM turns, no embeddings).
**Exit criteria:** `npm run typecheck`, `npm test` and `npm run test:int` pass. On a throwaway daemon, a fresh spawn of a 1M node writes `<dataDir>/handoffs/<NODE>-<stamp>.md` holding all 30 exchanges and the full header. A 200k node's handoff holds prompt 1 plus a contiguous newest tail and the left-out count. tmux receives `--append-system-prompt-file <that file>` and a first prompt whose first line is `[notesd handoff]`. `GET /api/sessions/:nodeId/handoff` answers the estimate and creates no `handoffs/` folder. The hook prints nothing for the marker prompt.

## Handoffs

- **Phase 4 (README):** add the `GET /api/sessions/:nodeId/handoff` row (any host; 200 `{node_id, tokens, window, percent, baseline, exchanges_included, exchanges_total, truncated}`, 400 `invalid_node_id`, 404 `not_found`). Rewrite the fresh-spawn description in the resume row and in the MCP `session_resume` table to match Step 7's tool text.
- **Phase 4 (feature map):** `.claude/skills/verify-notesd/features/projects.md` needs a "Spawn fresh handoff" sub-feature (what the handoff carries, `<dataDir>/handoffs/`, 14-day prune, the marker prompt, the estimate route) with the J1–J5 recipe above as its proof. That includes the fake-tmux `NOTESD_TMUX_BIN` trick, which makes resume drivable without spawning anything. This is the feature-map update for this phase's user-facing change, deferred to Phase 4 by the set's scope split.
- **Phase 4 (web):** `web/src/sessionDetailApi.ts:88` still says "seeded with this node's context". `fetchHandoffEstimate` should type the body exactly as above. `percent` is already rounded to one decimal and is `(baseline + tokens) / window` of the OLD session's inferred window. R4.8 (the second bar) is Phase 4's criterion and is not traced here.
- **Phase 1 (assumed done):** `contextWindowFor` and the four `cc_sessions` columns as stated under **Requires**. If Phase 1 names the function or its input fields differently, only the single `contextWindowFor({...})` call in `buildHandoff` changes.

## Rollback

Revert this phase's commit. That restores the old `freshPrompt`, the plain fresh argv, the route file, the tool text and the hook. Nothing here touches the schema. Handoff files under `<dataDir>/handoffs/` are inert and can be deleted at any time (`rm -rf ~/mcp-notes-data/handoffs`).
