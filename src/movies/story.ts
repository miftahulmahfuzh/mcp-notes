import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../chat/agent.js';
import { DEFAULT_MOVIES_STORY_MODEL } from '../config.js';
import type { MovieStorySection, MovieStorySource } from '../db/schema.js';
import { dialoguePage } from '../directStream/dialogue.js';
import type { StoredDialogue } from '../directStream/dialogueStore.js';
import { DirectStreamError, type DirectStreamErrorCode, type StreamRef } from '../directStream/types.js';
import { findClaudeBin } from '../sessions/summarize.js';
import { runAgentText, type AgentTextRun } from './agentText.js';
import type { MoviesRepo } from './repo.js';
import type { TitleMetadata } from './types.js';
import type { WebStoryInput, WebStoryWriter, WrittenWebStory } from './webStory.js';

/**
 * The story of a film, an episode or a whole season, with every spoiler, written once on the owner's click and
 * kept in `movie_stories` (MoviesRepo.saveStory), so it is never paid for twice and a stored one is answered with
 * no model call. Web first (webStory.ts): Claude with WebSearch retells it from published recaps and names its
 * sources. A season is only ever written from the web. An episode or a film the web has no recap of is written
 * from its dialogue instead (the English subtitle a stream source carried, src/directStream/dialogue.ts), by one
 * more model call with no tools: the owner's login, no MCP servers, no settings, one turn.
 */

/** Agent SDK model alias; `config.movies.storyModel` (NOTESD_MOVIES_STORY_MODEL) overrides it. */
export const DEFAULT_STORY_MODEL = DEFAULT_MOVIES_STORY_MODEL;
/** Wall clock for one story from dialogue: a film's dialogue is long. */
export const DEFAULT_STORY_TIMEOUT_MS = 240_000;
/** Characters of dialogue handed to the model: a three-hour film fits; anything longer is cut at a whole minute. */
export const STORY_DIALOGUE_CHARS = 400_000;
/** What a season's text says for an episode no published recap told. */
export const NO_RECAP_TEXT = 'No published recap was found for this episode.';

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

/** What the dialogue writer is given about one title. */
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

/** The dialogue writer's user message. */
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

/** The seam between a story from dialogue and a model. Production: createStoryWriter. Tests: a plain object. */
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

/** Claude through the Agent SDK, no tools, one turn. Null when the claude binary cannot be found. */
export function createStoryWriter(opts: StoryWriterOptions): StoryWriter | null {
  const baseEnv = opts.baseEnv ?? process.env;
  const claudeBin = findClaudeBin(opts.claudeBin, baseEnv.PATH);
  if (claudeBin === null) return null;
  const query: QueryFn = opts.query ?? sdkQuery;
  const model = opts.model ?? DEFAULT_STORY_MODEL;
  const run: AgentTextRun = {
    query,
    claudeBin,
    cwd: opts.cwd,
    baseEnv,
    model,
    tools: [],
    maxTurns: 1,
    systemPrompt: STORY_SYSTEM_PROMPT,
    timeoutMs: opts.timeoutMs ?? DEFAULT_STORY_TIMEOUT_MS,
    what: 'story',
  };
  return {
    model,
    async write(input) {
      return runAgentText(run, buildStoryInput(input));
    },
  };
}

/** Where a story was written from. */
export type StoryOrigin = 'web' | 'dialogue';

/** A story as the wall and the tools read it. */
export interface StoryView {
  season: number;
  /** 0 for a season's story (season > 0) and for a film's (season 0). */
  episode: number;
  /** The story. A season's: every section under its "S01E02 · name" heading (seasonText), for a reader of plain text. */
  text: string;
  origin: StoryOrigin;
  /** The pages a web story was written from; [] for a story from dialogue. */
  sources: MovieStorySource[];
  /** A season's story: one per aired episode, in order (`found: false` and no text where no recap told it); [] otherwise. */
  sections: MovieStorySection[];
  model: string | null;
  written_at: string | null;
  /** A story from dialogue: the stream provider whose subtitle it was written from, and how many lines that was. Null for a web story. */
  provider: string | null;
  cues: number | null;
}

/** Why a story could not be given: the route answers `code`. */
export class StoryError extends Error {
  override readonly name = 'StoryError';
  constructor(
    readonly code: 'not_found' | 'story_off' | 'no_story_source' | 'story_failed',
    message: string,
  ) {
    super(message);
  }
}

export interface MovieStoriesOptions {
  repo: Pick<MoviesRepo, 'story' | 'saveStory' | 'dialogue' | 'loadTitleMetadata'>;
  /**
   * The title's dialogue, read from a stream source when it is not stored yet
   * (dialogueStore.ts loadDialogue). Null from it: none is stored and none can be read here
   * (direct streaming is off). It throws DirectStreamError when the title cannot be resolved.
   */
  dialogue: (target: StreamRef) => Promise<StoredDialogue | null>;
  /** Writes an episode or a film from its dialogue when the web has no recap. Null: NOTESD_MOVIES_STORY_MODEL=off, or no claude binary. */
  writer: StoryWriter | null;
  /** Writes from published recaps (webStory.ts): a season always, an episode or a film first. Null as `writer`. Stored stories are still read. */
  webWriter: WebStoryWriter | null;
  now?: () => Date;
  log?: (line: string) => void;
}

type Written = { story: StoryView; cached: boolean };

/** One stored story, without its title. */
interface StoryRecord {
  season: number;
  episode: number;
  text: string;
  sections: MovieStorySection[];
  sources: MovieStorySource[];
  origin: StoryOrigin;
  model: string | null;
  writtenAt: Date;
}

/** A dialogue that cannot be read because there is none: with no recap on the web either, nothing tells the story. */
const NOTHING_TO_READ: ReadonlySet<DirectStreamErrorCode> = new Set<DirectStreamErrorCode>(['no_source', 'no_subtitle', 'no_episode']);

const pad = (n: number): string => String(n).padStart(2, '0');

/** A season's sections as one text, each under its "S01E02 · name" heading; an untold one says so. */
export function seasonText(season: number, sections: readonly MovieStorySection[]): string {
  return sections.map((s) => `S${pad(season)}E${pad(s.episode)}${s.name === null ? '' : ` · ${s.name}`}\n\n${s.found ? s.text : NO_RECAP_TEXT}`).join('\n\n');
}

function viewOf(r: StoryRecord, dialogue: { provider: string; cues: number } | null): StoryView {
  return {
    season: r.season,
    episode: r.episode,
    text: r.text,
    origin: r.origin,
    sources: r.sources,
    sections: r.sections,
    model: r.model,
    written_at: r.writtenAt.toISOString(),
    provider: dialogue?.provider ?? null,
    cues: dialogue?.cues ?? null,
  };
}

function labelOf(meta: TitleMetadata, season: number, episode: number): string {
  if (meta.kind === 'movie') return meta.title;
  return episode === 0 ? `${meta.title} season ${season}` : `${meta.title} S${pad(season)}E${pad(episode)}`;
}

/** What every web story is told about its title. */
function webTitle(meta: TitleMetadata): Pick<WebStoryInput, 'title' | 'originalTitle' | 'overview'> {
  const original = meta.originalTitle.trim();
  return {
    title: meta.year === null ? meta.title : `${meta.title} (${meta.year})`,
    originalTitle: original !== '' && original !== meta.title ? original : null,
    overview: meta.overview.trim() === '' ? null : meta.overview.trim(),
  };
}

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
  private readonly inFlight = new Map<string, Promise<Written>>();
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: MovieStoriesOptions) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  /** The stored story of a film (0, 0), an episode, or a season (season, 0), or null. Never calls a model. */
  async get(titleId: string, season: number, episode: number): Promise<StoryView | null> {
    const row = await this.opts.repo.story(titleId, season, episode);
    if (row === null) return null;
    const record: StoryRecord = {
      season: row.season,
      episode: row.episode,
      text: row.text,
      sections: row.sections ?? [],
      sources: row.sources ?? [],
      origin: row.origin === 'web' ? 'web' : 'dialogue',
      model: row.model,
      writtenAt: row.writtenAt,
    };
    const dialogue = record.origin === 'dialogue' ? await this.opts.repo.dialogue(titleId, season, episode) : null;
    return viewOf(record, dialogue);
  }

  /**
   * The story: the stored one (`cached: true`, no model call), else written now and kept. `episode` 0 with a
   * season above 0 is that season's story (writeSeason). Two requests for the same story share one write.
   * Throws StoryError, or the DirectStreamError of a subtitle that could not be read for another reason
   * than there being none.
   */
  async write(titleId: string, season: number, episode: number): Promise<Written> {
    if (episode === 0 && season > 0) return this.writeSeason(titleId, season);
    return this.once(titleId, season, episode, () => this.writeOne(titleId, season, episode));
  }

  /** A season's whole story, one section per aired episode, from the web only: no subtitle is ever read for it. */
  async writeSeason(titleId: string, season: number): Promise<Written> {
    if (season < 1) throw new StoryError('not_found', 'Season 0 holds the specials: ask for one of its episodes.');
    return this.once(titleId, season, 0, () => this.writeNewSeason(titleId, season));
  }

  private async once(titleId: string, season: number, episode: number, make: () => Promise<Written>): Promise<Written> {
    const stored = await this.get(titleId, season, episode);
    if (stored !== null) return { story: stored, cached: true };
    const key = `${titleId} ${season} ${episode}`;
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;
    const job = make().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }

  private async writeNewSeason(titleId: string, season: number): Promise<Written> {
    const web = this.opts.webWriter;
    if (web === null) throw new StoryError('story_off', 'Stories are off on this machine (NOTESD_MOVIES_STORY_MODEL=off, or no claude binary).');
    const meta = await this.opts.repo.loadTitleMetadata(titleId);
    if (meta === null) throw new StoryError('not_found', `No title ${titleId} is stored.`);
    if (meta.kind !== 'tv') throw new StoryError('not_found', `${meta.title} is a film: it has no seasons.`);
    const today = this.now().toISOString().slice(0, 10);
    // Aired episodes only: a recap of an episode that has not aired cannot exist.
    const episodes = meta.episodes
      .filter((e) => e.season === season && e.airDate !== null && e.airDate <= today)
      .sort((a, b) => a.episode - b.episode)
      .map((e) => ({ episode: e.episode, name: e.name, airDate: e.airDate }));
    const label = labelOf(meta, season, 0);
    if (episodes.length === 0) throw new StoryError('not_found', `${label} has no aired episode.`);
    const written = await this.askWeb(web, { ...webTitle(meta), scope: 'season', season, episodes }, label);
    const told = written.sections.filter((s) => s.found).length;
    // Nothing kept when nothing was told: a later click searches again.
    if (told === 0) throw new StoryError('no_story_source', `No published recap of ${label} was found.`);
    const record: StoryRecord = {
      season,
      episode: 0,
      text: seasonText(season, written.sections),
      sections: written.sections,
      sources: written.sources,
      origin: 'web',
      model: web.model,
      writtenAt: this.now(),
    };
    await this.opts.repo.saveStory({ titleId, ...record });
    this.log(`[notesd] movies: wrote the story of ${titleId} season ${season} with ${web.model} from the web: ${told} of ${episodes.length} episodes told, ${written.sources.length} sources`);
    return { story: viewOf(record, null), cached: false };
  }

  private async writeOne(titleId: string, season: number, episode: number): Promise<Written> {
    const { webWriter: web, writer } = this.opts;
    if (web === null && writer === null) throw new StoryError('story_off', 'Stories are off on this machine (NOTESD_MOVIES_STORY_MODEL=off, or no claude binary).');
    const meta = await this.opts.repo.loadTitleMetadata(titleId);
    if (meta === null) throw new StoryError('not_found', `No title ${titleId} is stored.`);
    if (meta.kind === 'movie' && (season !== 0 || episode !== 0)) throw new StoryError('not_found', `${meta.title} is a film: it has no episodes.`);
    if (meta.kind === 'tv' && episode === 0) throw new StoryError('not_found', `Name an episode or a season of ${meta.title}.`);
    const label = labelOf(meta, season, episode);
    if (web !== null) {
      const ep = meta.kind === 'tv' ? (meta.episodes.find((e) => e.season === season && e.episode === episode) ?? null) : null;
      const input: WebStoryInput =
        meta.kind === 'movie'
          ? { ...webTitle(meta), scope: 'film', season: 0, episodes: [{ episode: 0, name: null, airDate: meta.releaseDate }] }
          : { ...webTitle(meta), scope: 'episode', season, episodes: [{ episode, name: ep?.name ?? null, airDate: ep?.airDate ?? null }] };
      const written = await this.askWeb(web, input, label);
      const section = written.sections[0];
      if (section !== undefined && section.found) {
        const record: StoryRecord = { season, episode, text: section.text, sections: [], sources: written.sources, origin: 'web', model: web.model, writtenAt: this.now() };
        await this.opts.repo.saveStory({ titleId, ...record });
        this.log(`[notesd] movies: wrote the story of ${label} (${titleId}) with ${web.model} from the web: ${written.sources.length} sources, ${section.text.length} characters`);
        return { story: viewOf(record, null), cached: false };
      }
      this.log(`[notesd] movies: no published recap of ${label} (${titleId}) was found; its subtitle is read instead`);
    }
    return this.fromDialogue(meta, titleId, season, episode, label);
  }

  /** The fallback of an episode or a film the web does not tell: its story from its dialogue. */
  private async fromDialogue(meta: TitleMetadata, titleId: string, season: number, episode: number, label: string): Promise<Written> {
    const writer = this.opts.writer;
    if (writer === null) throw new StoryError('no_story_source', `No published recap of ${label} was found, and stories from subtitles are off here.`);
    const target: StreamRef = meta.kind === 'movie' ? { kind: 'movie', tmdbId: meta.tmdbId } : { kind: 'tv', tmdbId: meta.tmdbId, season, episode };
    let dialogue: StoredDialogue | null;
    try {
      dialogue = await this.opts.dialogue(target);
    } catch (err) {
      if (err instanceof DirectStreamError && NOTHING_TO_READ.has(err.code)) {
        throw new StoryError('no_story_source', `No published recap of ${label} was found, and its subtitle could not be read: ${err.message}`);
      }
      throw err;
    }
    if (dialogue === null) throw new StoryError('no_story_source', `No published recap of ${label} was found, and no subtitle of it is stored here (direct streaming is off).`);
    const page = dialoguePage(dialogue.body, 0, STORY_DIALOGUE_CHARS);
    let text: string;
    try {
      text = await writer.write(storyInput(meta, season, episode, page.text));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[notesd] movies: the story of ${label} (${titleId}) was not written: ${message}`);
      throw new StoryError('story_failed', `The story could not be written: ${message}`);
    }
    const record: StoryRecord = { season, episode, text, sections: [], sources: [], origin: 'dialogue', model: writer.model, writtenAt: this.now() };
    await this.opts.repo.saveStory({ titleId, ...record });
    this.log(`[notesd] movies: wrote the story of ${label} (${titleId}) with ${writer.model} from ${dialogue.cues} lines (${text.length} characters)`);
    return { story: viewOf(record, dialogue), cached: false };
  }

  /** The web writer's answer; a failed run is `story_failed` (never a reason to read a subtitle instead). */
  private async askWeb(web: WebStoryWriter, input: WebStoryInput, label: string): Promise<WrittenWebStory> {
    try {
      return await web.write(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[notesd] movies: the story of ${label} was not written from the web: ${message}`);
      throw new StoryError('story_failed', `The story could not be written: ${message}`);
    }
  }
}
