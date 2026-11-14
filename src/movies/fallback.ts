import { mkdir } from 'node:fs/promises';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { QueryFn } from '../chat/agent.js';
import { claudeEnv } from '../chat/env.js';
import { findClaudeBin } from '../sessions/summarize.js';
import type { TitleKind } from './tmdb.js';

/**
 * The Haiku fallback: asked for a title and year only when a file name found no confident TMDB
 * match (match.ts). Same Agent SDK setup as the session summarizer (src/sessions/summarize.ts):
 * the owner's login, no tools, no MCP servers, no settings, one turn, no persisted session.
 */

/** Agent SDK model alias; `config.movies.fallbackModel` (NOTESD_MOVIES_FALLBACK_MODEL) overrides it. */
export const DEFAULT_FALLBACK_MODEL = 'haiku';
/** Wall clock per question. */
export const DEFAULT_FALLBACK_TIMEOUT_MS = 60_000;

export const FALLBACK_SYSTEM_PROMPT = [
  'You identify films and TV series from the names of video files on a home computer.',
  'The user message gives one file name and the folder it sits in.',
  'Release tags such as 1080p, WEB-DL, x265, 6CH, BluRay or Pahe.in are not part of the title.',
  'Answer with one JSON object and nothing else:',
  '{"title": "<the title as TMDB lists it in English>", "year": <four-digit release year, or null>, "kind": "movie" or "tv"}.',
  'For a TV episode give the series title and the year the series first aired.',
  'Answer with the single word null when the file is not a released film or series (a phone clip, a screen recording, a personal video) or when you cannot tell.',
].join(' ');

export interface FallbackAnswer {
  title: string;
  year: number | null;
  kind: TitleKind | null;
}

/** The seam between matching and a model. Production: createHaikuFallback. Tests: a plain object. */
export interface NameFallback {
  /** Model id or alias, for logs. */
  readonly model: string;
  /** A title to search TMDB for, or null when the model has none. Never rejects: a failed call is logged and answers null. */
  resolve(fileName: string, dirName: string | null): Promise<FallbackAnswer | null>;
}

export interface HaikuFallbackOptions {
  /** `config.chat.claudeBin`. */
  claudeBin: string;
  /** `<dataDir>/movies-fallback`; created on first use, nothing is persisted there. */
  cwd: string;
  /** Default DEFAULT_FALLBACK_MODEL. */
  model?: string;
  /** Default: the SDK's query. Tests inject a fake. */
  query?: QueryFn;
  /** Env the child env is derived from (keys and parent-session markers stripped). Default process.env. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Default DEFAULT_FALLBACK_TIMEOUT_MS. */
  timeoutMs?: number;
  /** One line per failed call. Default console.warn. */
  log?: (line: string) => void;
}

const AnswerSchema = z.object({
  title: z.string(),
  year: z.union([z.number(), z.string()]).nullish(),
  kind: z.string().nullish(),
});

const MIN_ANSWER_YEAR = 1870;
const MAX_ANSWER_YEAR = 2100;

function toYear(value: number | string | null | undefined): number | null {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= MIN_ANSWER_YEAR && n <= MAX_ANSWER_YEAR ? n : null;
}

/** The model's user message. */
export function buildFallbackInput(fileName: string, dirName: string | null): string {
  return `File name: ${fileName}\nFolder: ${dirName ?? '(library root)'}`;
}

/**
 * The model's answer as a FallbackAnswer, or null for "null", prose, broken JSON or an empty title.
 * Tolerates a ```json fence, text around the object, and a year given as a string.
 */
export function parseFallbackAnswer(raw: string): FallbackAnswer | null {
  const textOnly = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  if (/^null\.?$/i.test(textOnly)) return null;
  const start = textOnly.indexOf('{');
  const end = textOnly.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let json: unknown;
  try {
    json = JSON.parse(textOnly.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = AnswerSchema.safeParse(json);
  if (!parsed.success) return null;
  const title = parsed.data.title.trim();
  if (title === '') return null;
  const kind = parsed.data.kind === 'movie' || parsed.data.kind === 'tv' ? parsed.data.kind : null;
  return { title, year: toYear(parsed.data.year), kind };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Haiku through the Agent SDK. Null when the claude binary cannot be found: matching then runs without a fallback. */
export function createHaikuFallback(opts: HaikuFallbackOptions): NameFallback | null {
  const baseEnv = opts.baseEnv ?? process.env;
  const claudeBin = findClaudeBin(opts.claudeBin, baseEnv.PATH);
  if (claudeBin === null) return null;
  const query: QueryFn = opts.query ?? sdkQuery;
  const model = opts.model ?? DEFAULT_FALLBACK_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS;
  const log = opts.log ?? ((line: string) => console.warn(line));

  function optionsFor(abortController: AbortController): Options {
    return {
      abortController,
      cwd: opts.cwd,
      env: claudeEnv(baseEnv),
      model,
      pathToClaudeCodeExecutable: claudeBin as string,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      tools: [],
      allowedTools: [],
      permissionMode: 'dontAsk',
      maxTurns: 1,
      thinking: { type: 'disabled' },
      systemPrompt: FALLBACK_SYSTEM_PROMPT,
      persistSession: false,
    };
  }

  /** The raw answer; rejects on an error result, a thrown SDK error or the timeout. */
  async function ask(input: string): Promise<string> {
    await mkdir(opts.cwd, { recursive: true });
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort('timeout');
    }, timeoutMs);
    timer.unref();

    let result: string | null = null;
    let failure: string | null = null;
    try {
      for await (const message of query({ prompt: input, options: optionsFor(controller) })) {
        if (message.type !== 'result') continue;
        if (message.subtype === 'success' && !message.is_error) result = message.result;
        else if (message.subtype === 'success') failure = message.result.trim() || 'the fallback failed without saying why';
        else failure = message.errors.join('; ').trim() || `the fallback failed (${message.subtype})`;
      }
    } catch (err) {
      // A CLI that exits non-zero after its result still produced that result: trust it.
      if (result === null && failure === null) failure = errorText(err);
    } finally {
      clearTimeout(timer);
    }
    if (result !== null) return result;
    if (timedOut) throw new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`);
    throw new Error(failure ?? 'ended without a result');
  }

  return {
    model,
    async resolve(fileName, dirName) {
      try {
        return parseFallbackAnswer(await ask(buildFallbackInput(fileName, dirName)));
      } catch (err) {
        log(`movies: name fallback (${model}) failed for ${fileName}: ${errorText(err)}`);
        return null;
      }
    },
  };
}
