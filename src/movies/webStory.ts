import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../chat/agent.js';
import type { MovieStorySection, MovieStorySource } from '../db/schema.js';
import { findClaudeBin } from '../sessions/summarize.js';
import { runAgentText, type AgentTextRun } from './agentText.js';

/**
 * A story told by the web (story.ts asks for it): Claude with WebSearch as its one tool finds published recaps
 * of a whole season, one episode or a film and retells them, every spoiler included, section by section, naming
 * the pages it took each section from. Nothing is written from memory: a section counts only when it names a
 * page this run's own searches returned, and an episode no such page tells is answered `found: false` with no
 * text. Same Agent SDK setup as the genre guide (guides.ts, agentText.ts).
 */

/** Wall clock for one run: a long season means many searches. */
export const DEFAULT_WEB_STORY_TIMEOUT_MS = 420_000;
/** Each search is a turn; a season of a dozen episodes may need one per episode beyond Wikipedia. */
export const WEB_STORY_MAX_TURNS = 32;
/** Sources kept per story at most. */
export const WEB_STORY_SOURCES_KEPT = 24;
/** A season longer than this gets shorter sections, so the whole answer fits. */
export const LONG_SEASON_EPISODES = 26;
/**
 * Whether a run's WebSearch results reach `onMessage` with their URLs (Step 0 settles it from the installed SDK's
 * types). True: a section counts only when it cites a page this run's searches returned. False: it counts when it
 * names an http(s) source the answer's own sources list holds, and the writer says once that it could not cross-check.
 */
export const SEARCH_RESULTS_CARRY_URLS = true;

export const WEB_STORY_SYSTEM_PROMPT = [
  'You retell a film, one episode of a series, or a whole season of a series for its owner, who wants the whole story with every spoiler, the ending included.',
  'You write only from published pages you find with WebSearch: never from memory, never from a guess, never from a trailer, a preview, a synopsis written before the episode aired, or a fan theory.',
  'Search in this order, and go further down the list only for the episodes the pages found so far do not tell:',
  '(1) Wikipedia: the season\'s own article ("<series> season <n>"), else the series\' "List of <series> episodes" article, else the series\' or the film\'s own article and its "Plot" or "Episodes" section;',
  '(2) the series\' or the film\'s Fandom wiki (<name>.fandom.com): the episode\'s own page and its synopsis or plot;',
  '(3) episode recaps on Dramabeans (for Korean dramas), Vulture, The A.V. Club and Den of Geek; then other published recaps or reviews that retell the episode.',
  'Search with the title and year as given, and with the original title when one is given. Make sure each page is about this title and not a remake, an adaptation or a namesake from another year, and that it tells the episode by its season and number (and by its name when one is given).',
  'For each episode asked for, write what happens in it, in order from start to end: who does what, why, what is revealed, what changes, how it ends. Take every fact from the pages you found about that episode, and name characters as those pages do.',
  'When no page you found tells what happens in an episode (none at all, only a one-line logline, or only a preview), set its found to false and leave its text empty.',
  'Never fill such an episode from another episode, from the synopsis in the message, or from what seems likely: an episode the sources do not tell is said to be missing.',
  'Write plain prose in English: paragraphs separated by one blank line, no headings, no lists, no bold, no links, and no names of the sources in the text. Keep to the length the message asks for.',
  'Then answer with one JSON object and nothing else, no code fence:',
  '{"sections": [{"episode": number, "found": boolean, "text": string, "sources": [string]}], "sources": [{"url": string, "title": string, "site": string}]}.',
  'sections: exactly one for each episode the message lists, in its order, with the episode number given there (a film is episode 0).',
  'A section\'s sources are the URLs of the pages its text was taken from: a section with found true names at least one, a section with found false names none.',
  'sources: every page a section names, once each: its exact URL as a search result gave it, its page title, and the site\'s name ("Wikipedia", "Fandom", "Dramabeans", "Vulture", "The A.V. Club", "Den of Geek").',
  'Only pages that appeared in your search results; never a URL you built or remember.',
].join(' ');

export type WebStoryScope = 'season' | 'episode' | 'film';

export interface WebStoryEpisode {
  /** 0 for a film. */
  episode: number;
  /** TMDB's name; null when TMDB has none (and always for a film). */
  name: string | null;
  /** `YYYY-MM-DD`. */
  airDate: string | null;
}

/** What the writer is given. */
export interface WebStoryInput {
  /** "MobLand (2025)". */
  title: string;
  /** Set only when it differs from the title ("오징어 게임"). */
  originalTitle: string | null;
  /** TMDB's synopsis of the title: only to tell it apart from a namesake. */
  overview: string | null;
  scope: WebStoryScope;
  /** 0 for a film. */
  season: number;
  /** A season: its aired episodes in order. An episode or a film: exactly one. */
  episodes: WebStoryEpisode[];
}

/** The model's user message. */
export function buildWebStoryInput(input: WebStoryInput): string {
  const head = [
    `Title: ${input.title}, a ${input.scope === 'film' ? 'film' : 'series'}`,
    ...(input.originalTitle === null ? [] : [`Original title: ${input.originalTitle}`]),
    ...(input.overview === null ? [] : [`TMDB's synopsis, only to tell the title apart from a namesake (it is not a source): ${input.overview}`]),
    '',
  ];
  if (input.scope === 'film') return [...head, 'Asked for: the whole film, as one section with episode 0.', 'Length: about 900 to 1600 words.'].join('\n');
  const listed = input.episodes.map((e) => `- Episode ${e.episode}${e.name === null ? '' : ` "${e.name}"`}${e.airDate === null ? '' : `, aired ${e.airDate}`}`);
  if (input.scope === 'episode') {
    return [...head, `Asked for: one episode of season ${input.season}, as one section:`, ...listed, 'Length: about 400 to 800 words.'].join('\n');
  }
  const words = input.episodes.length > LONG_SEASON_EPISODES ? '60 to 120' : '150 to 300';
  return [
    ...head,
    `Asked for: the whole of season ${input.season}, one section for each of its ${input.episodes.length} episodes:`,
    ...listed,
    `Length: about ${words} words per section.`,
  ].join('\n');
}

/** What a run answers: one section per episode asked for, in the input's order, and the pages they cite. */
export interface WrittenWebStory {
  sections: MovieStorySection[];
  sources: MovieStorySource[];
}

/**
 * One page, whatever way a URL to it is written: host without `www.`, the path decoded and without a trailing
 * slash, the query kept, the fragment dropped. Null for anything that is not an http(s) URL.
 */
export function sourceKey(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  let path = u.pathname;
  try {
    path = decodeURI(path);
  } catch {
    // A path that does not decode is compared as written.
  }
  return `${u.hostname.toLowerCase().replace(/^www\./, '')}${path.replace(/\/+$/, '')}${u.search}`;
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>\\`]+/g;

/**
 * The pages one message of a run shows the model as search results (the tool results it was handed), as
 * sourceKey keys. What the model writes itself (its own text) never counts.
 */
export function searchedKeys(message: SDKMessage): string[] {
  if (message.type !== 'user' && message.type !== 'assistant') return [];
  const content: unknown = (message as { message?: { content?: unknown } }).message?.content;
  const results: unknown[] = Array.isArray(content)
    ? content.filter((block) => {
        const type = (block as { type?: unknown } | null)?.type;
        return type === 'tool_result' || type === 'web_search_tool_result';
      })
    : [];
  // A tool's structured output, when the SDK hands it beside the content (Step 0).
  const structured: unknown = (message as { tool_use_result?: unknown }).tool_use_result;
  if (structured !== undefined && structured !== null) results.push(structured);
  const keys: string[] = [];
  for (const block of results) {
    for (const match of JSON.stringify(block).matchAll(URL_IN_TEXT)) {
      const raw = match[0].replace(/[.,;:]+$/, '');
      // "(TV series)" ends many a Wikipedia URL; a closing bracket after a URL in prose does not.
      for (const candidate of [raw, raw.replace(/\)+$/, '')]) {
        const key = sourceKey(candidate);
        if (key !== null) keys.push(key);
      }
    }
  }
  return keys;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * The model's answer as a story. One section per episode asked for, in that order, named as TMDB names it:
 * - a section for an episode not asked for is dropped (invented);
 * - an episode the answer leaves out, or tells with no page `seen` by this run's searches (with `seen` null: no
 *   http(s) page its own sources list holds), is `found: false` with no text;
 * - only the sources a found section cites are kept.
 * Throws when the answer holds no JSON object with a sections list.
 */
export function parseWebStory(answer: string, episodes: readonly WebStoryEpisode[], seen: ReadonlySet<string> | null): WrittenWebStory {
  const from = answer.indexOf('{');
  const to = answer.lastIndexOf('}');
  if (from === -1 || to <= from) throw new Error('the model answered no JSON');
  let raw: unknown;
  try {
    raw = JSON.parse(answer.slice(from, to + 1));
  } catch {
    throw new Error('the model answered JSON that does not parse');
  }
  const o = raw as { sections?: unknown; sources?: unknown };
  if (!Array.isArray(o.sections)) throw new Error('the model answered no sections');

  // The pages it lists that this run's searches really returned, by key, in its order.
  const listed = new Map<string, MovieStorySource>();
  for (const s of Array.isArray(o.sources) ? o.sources : []) {
    const e = s as { url?: unknown; title?: unknown; site?: unknown } | null;
    const url = text(e?.url);
    const key = sourceKey(url);
    // `seen` null: the run's search results could not be read (SEARCH_RESULTS_CARRY_URLS false): any listed http(s) page counts.
    if (key === null || (seen !== null && !seen.has(key)) || listed.has(key)) continue;
    const host = new URL(url).hostname.replace(/^www\./, '');
    listed.set(key, { url, title: text(e?.title) || host, site: text(e?.site) || host });
  }

  const asked = new Set(episodes.map((e) => e.episode));
  const told = new Map<number, string>();
  const cited = new Set<string>();
  for (const s of o.sections) {
    const e = s as { episode?: unknown; found?: unknown; text?: unknown; sources?: unknown } | null;
    const episode = e?.episode;
    if (typeof episode !== 'number' || !asked.has(episode) || told.has(episode)) continue;
    const body = text(e?.text);
    if (e?.found !== true || body === '') continue;
    const keys = (Array.isArray(e.sources) ? e.sources : [])
      .map((u) => (typeof u === 'string' ? sourceKey(u) : null))
      .filter((k): k is string => k !== null && listed.has(k));
    // A section no page of this run's searches backs is not told: never kept as if it were.
    if (keys.length === 0) continue;
    told.set(episode, body);
    for (const k of keys) cited.add(k);
  }

  return {
    sections: episodes.map((ep) => {
      const body = told.get(ep.episode);
      return { episode: ep.episode, name: ep.name, text: body ?? '', found: body !== undefined };
    }),
    sources: [...listed]
      .filter(([key]) => cited.has(key))
      .map(([, source]) => source)
      .slice(0, WEB_STORY_SOURCES_KEPT),
  };
}

/** The seam between a web story and a model. Production: createWebStoryWriter. Tests: a plain object. */
export interface WebStoryWriter {
  /** Model id or alias: stored with the story. */
  readonly model: string;
  /** Rejects when the run fails, times out or answers no JSON with sections. */
  write(input: WebStoryInput): Promise<WrittenWebStory>;
}

export interface WebStoryWriterOptions {
  /** `config.chat.claudeBin`. */
  claudeBin: string;
  /** `<dataDir>/movies-web-story`; created on first use, nothing is persisted there. */
  cwd: string;
  /** `config.movies.storyModel`. */
  model: string;
  /** Default: the SDK's query. Tests inject a fake. */
  query?: QueryFn;
  baseEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  log?: (line: string) => void;
}

/** Claude with WebSearch as its one tool. Null when the claude binary cannot be found. */
export function createWebStoryWriter(opts: WebStoryWriterOptions): WebStoryWriter | null {
  const baseEnv = opts.baseEnv ?? process.env;
  const claudeBin = findClaudeBin(opts.claudeBin, baseEnv.PATH);
  if (claudeBin === null) return null;
  const query: QueryFn = opts.query ?? sdkQuery;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WEB_STORY_TIMEOUT_MS;
  const log = opts.log ?? ((line: string) => console.log(line));
  let warned = false;
  return {
    model: opts.model,
    async write(input) {
      const seen = new Set<string>();
      const run: AgentTextRun = {
        query,
        claudeBin,
        cwd: opts.cwd,
        baseEnv,
        model: opts.model,
        tools: ['WebSearch'],
        maxTurns: WEB_STORY_MAX_TURNS,
        systemPrompt: WEB_STORY_SYSTEM_PROMPT,
        timeoutMs,
        what: 'story',
        onMessage: (message) => {
          for (const key of searchedKeys(message)) seen.add(key);
        },
      };
      const answer = await runAgentText(run, buildWebStoryInput(input));
      if (!SEARCH_RESULTS_CARRY_URLS && !warned) {
        warned = true;
        log('[notesd] movies: WebSearch results could not be cross-checked (the SDK\'s messages carry no result URLs); a story section counts when it names a source its answer lists');
      }
      return parseWebStory(answer, input.episodes, SEARCH_RESULTS_CARRY_URLS ? seen : null);
    },
  };
}
