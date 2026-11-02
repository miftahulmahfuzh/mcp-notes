import { createHash } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../chat/agent.js';
import { claudeEnv, resolveExecutable } from '../chat/env.js';
import { embedInput } from '../embeddings/state.js';
import { redactSecrets } from './redact.js';

/** The Agent SDK model alias for summaries. */
export const SUMMARY_MODEL = 'haiku';
/** Bump when the system prompt or input layout changes: every session is then re-summarized once. */
export const SUMMARY_PROMPT_VERSION = 'v1';
/** `<dataDir>/session-summaries`: the fixed cwd of every summarizer run (nothing is persisted there). */
export const SUMMARIES_SUBDIR = 'session-summaries';
/** Wall clock per summary call. */
export const DEFAULT_SUMMARY_TIMEOUT_MS = 90_000;

/** Caps on the summarizer input; the whole input never exceeds MAX_INPUT_CHARS. */
const MAX_PROMPTS = 40;
const HEAD_PROMPTS = 10;
const MAX_PROMPT_CHARS = 1_500;
const MAX_LIST_ITEMS = 60;
const MAX_ITEM_CHARS = 300;
const MAX_FINAL_CHARS = 4_000;
const MAX_INPUT_CHARS = 24_000;
/** Stored summary cap. */
const MAX_SUMMARY_CHARS = 1_500;
/** Per-prompt cap inside the embed text (embedInput then clamps the whole to 8000). */
const MAX_EMBED_PROMPT_CHARS = 500;

export const SUMMARY_SYSTEM_PROMPT = [
  'You summarize one Claude Code session for its owner\'s personal index of past sessions.',
  'The user message lists the session\'s repository, titles, the human prompts in order, the commits it made, the files it edited, the plan documents it touched and the final assistant message.',
  'Write 2 to 4 plain sentences, no heading, no bullet list, no preamble such as "This session".',
  'Say what the user wanted, what was actually done (name features, files, commands, plan or task ids), and where it ended: finished, abandoned, or what was left open.',
  'Never repeat secrets, keys, tokens or passwords; the input already shows them as [redacted].',
  'Answer with the summary only.',
].join(' ');

/** The cc_sessions columns a summary and an embedding are built from (phase 3 fills them). */
export interface SessionSummarySource {
  sessionId: string;
  nodeId: string;
  repo: string | null;
  branch: string | null;
  name: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  firstPrompt: string | null;
  /** jsonb: human prompts, oldest first (strings, or objects with a text/prompt field). */
  prompts: unknown;
  /** jsonb: commits made (strings, or objects with sha/subject/message). */
  commits: unknown;
  /** jsonb: paths edited. */
  filesEdited: unknown;
  /** jsonb: plan docs touched. */
  planDocs: unknown;
  finalMessage: string | null;
  summary: string | null;
  summarySha: string | null;
}

export interface SummarizeRequest {
  sessionId: string;
  /** Output of buildSummaryInput: already redacted and capped. */
  input: string;
  /** Aborts the call (daemon shutdown). */
  signal: AbortSignal;
}

/**
 * The one seam between session summaries and a model. Production: createAgentSummarizer
 * (Haiku through the Agent SDK). Tests: tests/helpers/fakeSummarizer.ts.
 * Rejects on any failure; the worker records it and retries later.
 */
export interface Summarizer {
  /** Model id or alias, for logs. */
  readonly model: string;
  /** The raw model answer; the worker cleans and redacts it with cleanSummary. */
  summarize(req: SummarizeRequest): Promise<string>;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function oneLine(text: string, max: number): string {
  return clip(text.replace(/\s+/g, ' '), max);
}

const ITEM_FIELDS = ['sha', 'hash', 'subject', 'message', 'path', 'file', 'text', 'prompt'] as const;

/** A jsonb list (or single value) as display lines; tolerant of strings and objects. */
export function asLines(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const items: unknown[] = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      if (item.trim() !== '') out.push(item.trim());
      continue;
    }
    if (item !== null && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of ITEM_FIELDS) {
        const v = rec[key];
        if (typeof v === 'string' && v.trim() !== '') parts.push(key === 'sha' || key === 'hash' ? v.trim().slice(0, 10) : v.trim());
      }
      out.push(parts.length > 0 ? parts.join(' ') : JSON.stringify(item));
      continue;
    }
    if (typeof item === 'number' || typeof item === 'boolean') out.push(String(item));
  }
  return out;
}

function pickPrompts(prompts: string[]): { shown: string[]; skipped: number } {
  if (prompts.length <= MAX_PROMPTS) return { shown: prompts, skipped: 0 };
  const tail = MAX_PROMPTS - HEAD_PROMPTS;
  return {
    shown: [...prompts.slice(0, HEAD_PROMPTS), ...prompts.slice(prompts.length - tail)],
    skipped: prompts.length - MAX_PROMPTS,
  };
}

function titleOf(s: SessionSummarySource): string | null {
  return s.customTitle ?? s.aiTitle ?? s.name ?? null;
}

/**
 * The summarizer's user message: repo, titles, prompts, commits, files, plan docs, final
 * message; capped and redacted. Null when the session has nothing a summary could say (no
 * prompt and no final message), so the worker skips it.
 */
export function buildSummaryInput(s: SessionSummarySource): string | null {
  let prompts = asLines(s.prompts);
  if (prompts.length === 0 && s.firstPrompt !== null && s.firstPrompt.trim() !== '') prompts = [s.firstPrompt.trim()];
  const final = s.finalMessage?.trim() ?? '';
  if (prompts.length === 0 && final === '') return null;

  const lines: string[] = [];
  lines.push(`Node: ${s.nodeId}`);
  if (s.repo !== null) lines.push(`Repository: ${s.repo}`);
  if (s.branch !== null) lines.push(`Branch: ${s.branch}`);
  if (s.name !== null) lines.push(`Session name: ${s.name}`);
  if (s.customTitle !== null) lines.push(`Title: ${s.customTitle}`);
  if (s.aiTitle !== null && s.aiTitle !== s.customTitle) lines.push(`Auto title: ${s.aiTitle}`);

  const { shown, skipped } = pickPrompts(prompts);
  if (shown.length > 0) {
    lines.push('', 'Human prompts, in order:');
    shown.forEach((p, i) => {
      if (skipped > 0 && i === HEAD_PROMPTS) lines.push(`(${skipped} more prompts omitted)`);
      lines.push(`${i + 1}. ${clip(p, MAX_PROMPT_CHARS)}`);
    });
  }
  const sections: Array<[string, string[]]> = [
    ['Commits made:', asLines(s.commits)],
    ['Files edited:', asLines(s.filesEdited)],
    ['Plan documents touched:', asLines(s.planDocs)],
  ];
  for (const [heading, items] of sections) {
    if (items.length === 0) continue;
    lines.push('', heading);
    for (const item of items.slice(0, MAX_LIST_ITEMS)) lines.push(`- ${oneLine(item, MAX_ITEM_CHARS)}`);
    if (items.length > MAX_LIST_ITEMS) lines.push(`- (${items.length - MAX_LIST_ITEMS} more)`);
  }
  if (final !== '') lines.push('', 'Final assistant message:', clip(final, MAX_FINAL_CHARS));

  return clip(redactSecrets(lines.join('\n')), MAX_INPUT_CHARS);
}

/** Hex sha256 of the prompt version and the input: equal sha = nothing new to summarize. */
export function summaryInputSha(input: string): string {
  return createHash('sha256').update(`${SUMMARY_PROMPT_VERSION}\n${input}`, 'utf8').digest('hex');
}

/** The stored summary: trimmed, no "Summary:" lead-in, blank runs collapsed, capped, redacted. */
export function cleanSummary(raw: string): string {
  const t = raw
    .trim()
    .replace(/^\**\s*summary\s*\**\s*:\s*\**\s*/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return redactSecrets(clip(t, MAX_SUMMARY_CHARS));
}

/**
 * What gets embedded for a session: title/name/repo, the summary, then the prompts; redacted,
 * then trimmed and clamped by embedInput. Null when nothing is left.
 */
export function buildEmbedText(s: SessionSummarySource): string | null {
  const head = [titleOf(s), s.name !== titleOf(s) ? s.name : null, s.repo].filter(
    (v): v is string => v !== null && v.trim() !== '',
  );
  const parts: string[] = [];
  if (head.length > 0) parts.push(head.join(' | '));
  if (s.summary !== null && s.summary.trim() !== '') parts.push(s.summary.trim());
  let prompts = asLines(s.prompts);
  if (prompts.length === 0 && s.firstPrompt !== null) prompts = [s.firstPrompt];
  for (const p of prompts) parts.push(oneLine(p, MAX_EMBED_PROMPT_CHARS));
  return embedInput(redactSecrets(parts.join('\n')));
}

/** Hex sha256 of the embed text; stored in cc_session_embeddings.sha. */
export function embedTextSha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Absolute path of an executable claude binary, or null. A bare name is looked up on PATH
 * (chat's resolveExecutable); a path must exist and be executable.
 */
export function findClaudeBin(bin: string, pathEnv: string | undefined): string | null {
  const resolved = resolveExecutable(bin, pathEnv);
  if (!resolved.includes('/')) return null;
  try {
    accessSync(resolved, constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

export interface AgentSummarizerOptions {
  /** `config.chat.claudeBin`. */
  claudeBin: string;
  /** `<dataDir>/session-summaries`; created on first use. */
  cwd: string;
  /** Default: the SDK's query. Tests inject a fake. */
  query?: QueryFn;
  /** Env the child env is derived from (keys and parent-session markers stripped). Default process.env. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Default DEFAULT_SUMMARY_TIMEOUT_MS. */
  timeoutMs?: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Haiku through the Claude Agent SDK, on the owner's login like the chat brain: no tools, no
 * MCP servers, no settings, one turn, no persisted session. Null when the claude binary cannot
 * be found; the caller logs that once and runs without summaries.
 */
export function createAgentSummarizer(opts: AgentSummarizerOptions): Summarizer | null {
  const baseEnv = opts.baseEnv ?? process.env;
  const claudeBin = findClaudeBin(opts.claudeBin, baseEnv.PATH);
  if (claudeBin === null) return null;
  const query: QueryFn = opts.query ?? sdkQuery;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS;
  let cwdReady: Promise<unknown> | null = null;

  function optionsFor(abortController: AbortController): Options {
    return {
      abortController,
      cwd: opts.cwd,
      env: claudeEnv(baseEnv),
      model: SUMMARY_MODEL,
      pathToClaudeCodeExecutable: claudeBin as string,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      tools: [],
      allowedTools: [],
      permissionMode: 'dontAsk',
      maxTurns: 1,
      thinking: { type: 'disabled' },
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      persistSession: false,
    };
  }

  return {
    model: SUMMARY_MODEL,
    async summarize(req: SummarizeRequest): Promise<string> {
      if (req.signal.aborted) throw new Error('summary aborted');
      cwdReady ??= mkdir(opts.cwd, { recursive: true });
      await cwdReady;
      // An abort during the mkdir above fired before the relay below exists.
      if (req.signal.aborted) throw new Error('summary aborted');
      const controller = new AbortController();
      const relay = (): void => controller.abort(req.signal.reason);
      req.signal.addEventListener('abort', relay, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort('timeout');
      }, timeoutMs);
      timer.unref();

      let result: string | null = null;
      let failure: string | null = null;
      try {
        for await (const message of query({ prompt: req.input, options: optionsFor(controller) })) {
          if (message.type !== 'result') continue;
          if (message.subtype === 'success' && !message.is_error) result = message.result;
          else if (message.subtype === 'success') failure = message.result.trim() || 'the summarizer failed without saying why';
          else failure = message.errors.join('; ').trim() || `the summarizer failed (${message.subtype})`;
        }
      } catch (err) {
        // A CLI that exits non-zero after its result still produced that result: trust it.
        if (result === null && failure === null) failure = errorText(err);
      } finally {
        clearTimeout(timer);
        req.signal.removeEventListener('abort', relay);
      }
      if (result !== null) return result;
      if (req.signal.aborted) throw new Error('summary aborted');
      if (timedOut) throw new Error(`the summarizer gave no answer within ${Math.round(timeoutMs / 1000)} s`);
      throw new Error(failure ?? 'the summarizer ended without a result');
    },
  };
}
