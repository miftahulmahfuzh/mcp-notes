import { mkdir } from 'node:fs/promises';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../chat/agent.js';
import { DEFAULT_MOVIES_STORY_MODEL } from '../config.js';
import { claudeEnv } from '../chat/env.js';
import { dialoguePage } from '../directStream/dialogue.js';
import type { StoredDialogue } from '../directStream/dialogueStore.js';
import { findClaudeBin } from '../sessions/summarize.js';
import type { MoviesRepo } from './repo.js';
import type { StreamRef } from '../directStream/types.js';
import type { TitleMetadata } from './types.js';

/**
 * The story of a film or an episode, written by Claude from its dialogue (the English subtitle a
 * stream source carried, src/directStream/dialogue.ts) when the owner presses the book icon of an
 * episode. One model call per story, and the story is kept on the dialogue's row, so it is never
 * paid for twice. Same Agent SDK setup as the Haiku fallback (fallback.ts): the owner's login, no
 * tools, no MCP servers, no settings, one turn, no persisted session.
 */

/** Agent SDK model alias; `config.movies.storyModel` (NOTESD_MOVIES_STORY_MODEL) overrides it. */
export const DEFAULT_STORY_MODEL = DEFAULT_MOVIES_STORY_MODEL;
/** Wall clock for one story: a film's dialogue is long. */
export const DEFAULT_STORY_TIMEOUT_MS = 240_000;
/** Characters of dialogue handed to the model: a three-hour film fits; anything longer is cut at a whole minute. */
export const STORY_DIALOGUE_CHARS = 400_000;

export const STORY_SYSTEM_PROMPT = [
  'You retell one film or one episode of a series for its owner, who wants the whole story with every spoiler.',
  'The user message gives the title, what TMDB says about it, some of its characters, and the complete English subtitle: every line said, each with the minute it is said.',
  'Write what happens, in order, from start to end, the ending included: who does what, why, what is revealed, what changes.',
  'Work only from the lines given. Name a character when the lines or the cast make clear who it is; when you cannot tell who speaks, say what is said without guessing a name.',
  'Say when something is a flashback, a recap of earlier events or a preview of the next episode. Leave out opening and ending song lyrics.',
  'Subtitles do not describe silent action: do not invent what the lines do not show.',
  'Plain prose in English: paragraphs separated by one blank line, no headings, no lists, no bold. Begin with one sentence that says what this film or episode is about, then the story.',
  'An episode takes about 400 to 800 words, a film about 900 to 1600.',
].join(' ');

/** What the writer is given about one title. */
export interface StoryInput {
  /** "One Piece (1999)". */
  title: string;
  /** "S18E760", or null for a film. */
  code: string | null;
  episodeName: string | null;
  airDate: string | null;
  /** TMDB's synopsis of the episode, else of the title. */
  overview: string | null;
  /** "Monkey D. Luffy (voice)", from the cast's character names. */
  characters: string[];
  /** `[mm:ss] line` per cue. */
  dialogue: string;
}

/** The model's user message. */
export function buildStoryInput(input: StoryInput): string {
  return [
    `Title: ${input.title}`,
    ...(input.code === null ? [] : [`Episode: ${input.code}${input.episodeName === null ? '' : ` "${input.episodeName}"`}${input.airDate === null ? '' : `, aired ${input.airDate}`}`]),
    ...(input.overview === null || input.overview.trim() === '' ? [] : [`TMDB's synopsis: ${input.overview.trim()}`]),
    ...(input.characters.length === 0 ? [] : [`Characters of the title: ${input.characters.join('; ')}`]),
    '',
    'The subtitle, every line with its minute:',
    input.dialogue,
  ].join('\n');
}

/** The seam between a story and a model. Production: createStoryWriter. Tests: a plain object. */
export interface StoryWriter {
  /** Model id or alias: stored with the story. */
  readonly model: string;
  /** The story as plain paragraphs. Rejects when the model call fails or times out. */
  write(input: StoryInput): Promise<string>;
}

export interface StoryWriterOptions {
  /** `config.chat.claudeBin`. */
  claudeBin: string;
  /** `<dataDir>/movies-story`; created on first use, nothing is persisted there. */
  cwd: string;
  model?: string;
  /** Default: the SDK's query. Tests inject a fake. */
  query?: QueryFn;
  baseEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Claude through the Agent SDK. Null when the claude binary cannot be found: the story route then answers story_off. */
export function createStoryWriter(opts: StoryWriterOptions): StoryWriter | null {
  const baseEnv = opts.baseEnv ?? process.env;
  const claudeBin = findClaudeBin(opts.claudeBin, baseEnv.PATH);
  if (claudeBin === null) return null;
  const query: QueryFn = opts.query ?? sdkQuery;
  const model = opts.model ?? DEFAULT_STORY_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_STORY_TIMEOUT_MS;

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
      systemPrompt: STORY_SYSTEM_PROMPT,
      persistSession: false,
    };
  }

  return {
    model,
    async write(input) {
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
        for await (const message of query({ prompt: buildStoryInput(input), options: optionsFor(controller) })) {
          if (message.type !== 'result') continue;
          if (message.subtype === 'success' && !message.is_error) result = message.result;
          else if (message.subtype === 'success') failure = message.result.trim() || 'the model failed without saying why';
          else failure = message.errors.join('; ').trim() || `the model failed (${message.subtype})`;
        }
      } catch (err) {
        // A CLI that exits non-zero after its result still produced that result: trust it.
        if (result === null && failure === null) failure = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }
      const story = (result ?? '').trim();
      if (story !== '') return story;
      throw new Error(timedOut ? `no story within ${Math.round(timeoutMs / 1000)} s` : (failure ?? 'the model answered nothing'));
    },
  };
}

/** A story as the wall and the tools read it. */
export interface StoryView {
  season: number;
  episode: number;
  text: string;
  model: string | null;
  written_at: string | null;
  /** The stream provider whose subtitle it was written from, and how many lines that was. */
  provider: string;
  cues: number;
}

/** Why a story could not be given: the route answers `code`. */
export class StoryError extends Error {
  override readonly name = 'StoryError';
  constructor(
    readonly code: 'not_found' | 'story_off' | 'no_dialogue' | 'story_failed',
    message: string,
  ) {
    super(message);
  }
}

export interface MovieStoriesOptions {
  repo: Pick<MoviesRepo, 'dialogue' | 'saveStory' | 'loadTitleMetadata'>;
  /**
   * The title's dialogue, read from a stream source when it is not stored yet
   * (dialogueStore.ts loadDialogue). Null from it: none is stored and none can be read here
   * (direct streaming is off). It throws DirectStreamError when the title cannot be resolved.
   */
  dialogue: (target: StreamRef) => Promise<StoredDialogue | null>;
  /** Null: NOTESD_MOVIES_STORY_MODEL=off, or no claude binary. Stored stories are still read. */
  writer: StoryWriter | null;
  now?: () => Date;
  log?: (line: string) => void;
}

const pad = (n: number): string => String(n).padStart(2, '0');

function storyInput(meta: TitleMetadata, season: number, episode: number, dialogue: string): StoryInput {
  const ep = meta.kind === 'tv' ? (meta.episodes.find((e) => e.season === season && e.episode === episode) ?? null) : null;
  return {
    title: meta.year === null ? meta.title : `${meta.title} (${meta.year})`,
    code: meta.kind === 'tv' ? `S${pad(season)}E${pad(episode)}` : null,
    episodeName: ep?.name ?? null,
    airDate: ep?.airDate ?? null,
    overview: ep?.overview ?? (meta.kind === 'movie' ? meta.overview : null),
    characters: meta.credits.filter((c) => c.role === 'cast' && c.character !== null).slice(0, 40).map((c) => c.character as string),
    dialogue,
  };
}

/** The stories of the library: read from the store, and written once on request. Holds only the writes in flight. */
export class MovieStories {
  private readonly inFlight = new Map<string, Promise<{ story: StoryView; cached: boolean }>>();
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: MovieStoriesOptions) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  /** The stored story of a film (season 0, episode 0) or an episode, or null. Never calls a model. */
  async get(titleId: string, season: number, episode: number): Promise<StoryView | null> {
    const row = await this.opts.repo.dialogue(titleId, season, episode);
    if (row === null || row.story === null) return null;
    return { season, episode, text: row.story, model: row.storyModel, written_at: row.storyAt?.toISOString() ?? null, provider: row.provider, cues: row.cues };
  }

  /**
   * The story: the stored one (`cached: true`, no model call), else read the dialogue, have it
   * written and keep it. Two requests for the same story share one write. Throws StoryError, or
   * the DirectStreamError of a dialogue that cannot be read.
   */
  async write(titleId: string, season: number, episode: number): Promise<{ story: StoryView; cached: boolean }> {
    const stored = await this.get(titleId, season, episode);
    if (stored !== null) return { story: stored, cached: true };
    const key = `${titleId} ${season} ${episode}`;
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;
    const job = this.writeNew(titleId, season, episode).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }

  private async writeNew(titleId: string, season: number, episode: number): Promise<{ story: StoryView; cached: boolean }> {
    const writer = this.opts.writer;
    if (writer === null) throw new StoryError('story_off', 'Stories are off on this machine (NOTESD_MOVIES_STORY_MODEL=off, or no claude binary).');
    const meta = await this.opts.repo.loadTitleMetadata(titleId);
    if (meta === null) throw new StoryError('not_found', `No title ${titleId} is stored.`);
    const target: StreamRef =
      meta.kind === 'movie' ? { kind: 'movie', tmdbId: meta.tmdbId } : { kind: 'tv', tmdbId: meta.tmdbId, season, episode };
    const dialogue = await this.opts.dialogue(target);
    if (dialogue === null) throw new StoryError('no_dialogue', 'Its dialogue is not stored, and direct streaming is off here, so it cannot be read.');
    const page = dialoguePage(dialogue.body, 0, STORY_DIALOGUE_CHARS);
    let text: string;
    try {
      text = await writer.write(storyInput(meta, season, episode, page.text));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[notesd] movies: the story of ${titleId} S${pad(season)}E${pad(episode)} was not written: ${message}`);
      throw new StoryError('story_failed', `The story could not be written: ${message}`);
    }
    const at = this.now();
    const kept = await this.opts.repo.saveStory(titleId, season, episode, text, writer.model, at);
    this.log(`[notesd] movies: wrote the story of ${titleId} S${pad(season)}E${pad(episode)} with ${writer.model} from ${dialogue.cues} lines (${text.length} characters${kept ? '' : ', not kept: no dialogue row'})`);
    return { story: { season, episode, text, model: writer.model, written_at: at.toISOString(), provider: dialogue.provider, cues: dialogue.cues }, cached: false };
  }
}
