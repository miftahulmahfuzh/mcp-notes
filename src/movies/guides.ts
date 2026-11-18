import { mkdir } from 'node:fs/promises';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../chat/agent.js';
import { claudeEnv } from '../chat/env.js';
import type { Db } from '../db/client.js';
import type { GenreGuideItem } from '../db/schema.js';
import { findClaudeBin } from '../sessions/summarize.js';
import { listTitlesByIds, type ReadContext, type TitleListItem } from './read.js';
import type { MoviesRepo } from './repo.js';
import { posterUrl, yearOf, type TmdbClient, type TmdbDiscovery, type TmdbPersonCredit, type TmdbProfiles, type TmdbSearchHit } from './tmdb.js';
import { titleId, type TitleKind, type TitleMetadata } from './types.js';

/**
 * What a name on a title's page opens (the wall's EntityModal): who a person or a studio is, or
 * what a genre means for that title, each with its films and series, newest first, and every one
 * marked with what the owner did with it. A person and a studio are read from TMDB at each
 * request. A genre's guide is collated once by Claude with web search (the same genre is another
 * list on another title), kept in `movie_genre_guides` and read from there afterwards. No watch
 * state is kept with any list: the marks are read from the titles at each request.
 */

/** What the owner did with a listed title; null: nothing, or it is not stored. */
export type GuideMark = 'watched' | 'not_interested' | 'started';

export interface GuideTitle {
  kind: TitleKind;
  tmdb_id: number;
  /** `movie-123`: the stored title's key, whether or not it is stored yet. */
  title_id: string;
  title: string;
  year: number | null;
  release_date: string | null;
  poster_url: string | null;
  /** A person's roles in it ("cast as Ruth, Producer"), or why a genre's guide lists it; null for a studio's title. */
  note: string | null;
  /** Null until the title is stored (`POST /api/movies/ensure` stores it and answers its id). */
  movie_id: string | null;
  mark: GuideMark | null;
  /** A file of it is on this machine. */
  has_file: boolean;
}

export interface GuideEntity {
  kind: 'person' | 'company' | 'genre';
  name: string;
  /** A person's photo or a studio's logo; null for a genre, or when TMDB has none. */
  image_url: string | null;
  /** '' when nothing is known: TMDB describes few studios. */
  description: string;
  /** Short facts under the name: "Acting", "born 1994-10-23 in Los Angeles", "US". */
  facts: string[];
  /** The entity's page on TMDB; null for a genre. */
  link: string | null;
}

export interface EntityGuide {
  entity: GuideEntity;
  titles: GuideTitle[];
  /** A genre's guide only: when it was written and by which model. */
  written_at?: string | null;
  model?: string | null;
}

/** Titles listed at most: a prolific actor's list stays readable, and the newest come first. */
export const GUIDE_TITLE_LIMIT = 120;
/** Pages of 20 read per kind for a studio's titles. */
export const COMPANY_PAGES = 2;
/** TMDB's genres of talk shows and news: a person's appearances there are not their work. */
const APPEARANCE_GENRES: readonly number[] = [10767, 10763];
const PROFILE_SIZE = 'h632';
const LOGO_SIZE = 'w300';
const POSTER_SIZE = 'w185';

export function guideMark(t: Pick<TitleListItem, 'state' | 'watched' | 'not_interested'> | undefined): GuideMark | null {
  if (t === undefined) return null;
  if (t.not_interested) return 'not_interested';
  if (t.watched || t.state === 'finished' || t.state === 'seen') return 'watched';
  if (t.state === 'in_progress' || t.state === 'dropped') return 'started';
  return null;
}

/** Newest release first, undated last; the same day by name. */
function byNewest<T extends { release_date: string | null; title: string }>(a: T, b: T): number {
  if (a.release_date === b.release_date) return a.title.localeCompare(b.title);
  if (a.release_date === null) return 1;
  if (b.release_date === null) return -1;
  return a.release_date < b.release_date ? 1 : -1;
}

interface Listed {
  kind: TitleKind;
  tmdbId: number;
  title: string;
  releaseDate: string | null;
  posterPath: string | null;
  note: string | null;
}

/** The listed titles, newest first and capped, each with the owner's mark read now. */
export async function markedTitles(db: Db, ctx: ReadContext, listed: readonly Listed[]): Promise<GuideTitle[]> {
  const rows = listed.map((l) => ({
    kind: l.kind,
    tmdb_id: l.tmdbId,
    title_id: titleId(l.kind, l.tmdbId),
    title: l.title,
    year: yearOf(l.releaseDate),
    release_date: l.releaseDate,
    poster_url: posterUrl(ctx.imageBase, l.posterPath, POSTER_SIZE),
    note: l.note,
  }));
  rows.sort(byNewest);
  const shown = rows.slice(0, GUIDE_TITLE_LIMIT);
  const stored = new Map((await listTitlesByIds(db, shown.map((r) => r.title_id), ctx)).map((t) => [t.id, t]));
  return shown.map((r) => {
    const t = stored.get(r.title_id);
    return { ...r, movie_id: t?.movie_id ?? null, mark: guideMark(t), has_file: t?.present_here ?? false };
  });
}

function roleOf(c: TmdbPersonCredit): string {
  if (c.credit === 'cast') return c.character ? `as ${c.character}` : 'cast';
  return c.job ?? 'crew';
}

/** A person appearing as themselves (a making-of, a gala), and a "Thanks" credit, are not their work. */
const SELF = /^(self|himself|herself|themselves)\b/i;

/** TMDB lists a person once per role: one entry per title with the roles joined; appearances on talk shows and news, as themselves, and thanks are left out. */
export function personTitles(credits: readonly TmdbPersonCredit[]): Listed[] {
  const byTitle = new Map<string, Listed & { roles: string[] }>();
  for (const c of credits) {
    if ((c.genreIds ?? []).some((g) => APPEARANCE_GENRES.includes(g))) continue;
    if (c.credit === 'cast' ? SELF.test(c.character ?? '') : c.job === 'Thanks') continue;
    const key = `${c.kind}:${c.tmdbId}`;
    const entry = byTitle.get(key) ?? { kind: c.kind, tmdbId: c.tmdbId, title: c.title, releaseDate: c.releaseDate, posterPath: c.posterPath, note: null, roles: [] };
    const role = roleOf(c);
    if (!entry.roles.includes(role)) entry.roles.push(role);
    byTitle.set(key, entry);
  }
  return [...byTitle.values()].map(({ roles, ...l }) => ({ ...l, note: roles.join(', ') }));
}

export type GuideTmdb = TmdbClient & Partial<TmdbProfiles & TmdbDiscovery>;

/** A person: TMDB's profile and every film and series they are credited on. Null when TMDB does not know them. */
export async function personGuide(db: Db, ctx: ReadContext, tmdb: GuideTmdb, personId: number): Promise<EntityGuide | null> {
  if (tmdb.personProfile === undefined) return null;
  const [profile, credits] = await Promise.all([tmdb.personProfile(personId), tmdb.personCredits(personId)]);
  if (profile === null) return null;
  const born = profile.birthday === null ? null : `born ${profile.birthday}${profile.placeOfBirth === null ? '' : ` in ${profile.placeOfBirth}`}`;
  return {
    entity: {
      kind: 'person',
      name: profile.name,
      image_url: posterUrl(ctx.imageBase, profile.profilePath, PROFILE_SIZE),
      description: profile.biography,
      facts: [profile.knownFor, born, profile.deathday === null ? null : `died ${profile.deathday}`].filter((f): f is string => f !== null),
      link: `https://www.themoviedb.org/person/${profile.personId}`,
    },
    titles: await markedTitles(db, ctx, personTitles(credits)),
  };
}

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

/** A studio: TMDB's profile and the films and series it made, up to a year ahead of `now`. Null when TMDB does not know it. */
export async function companyGuide(db: Db, ctx: ReadContext, tmdb: GuideTmdb, companyId: number, now: Date = new Date()): Promise<EntityGuide | null> {
  if (tmdb.companyProfile === undefined || tmdb.discover === undefined) return null;
  const discover = tmdb.discover.bind(tmdb);
  const profile = await tmdb.companyProfile(companyId);
  if (profile === null) return null;
  const dateTo = dayOf(new Date(now.getTime() + 365 * 86_400_000));
  const pages = await Promise.all(
    (['movie', 'tv'] as const).flatMap((kind) =>
      Array.from({ length: COMPANY_PAGES }, (_, i) => discover(kind, { companyIds: [companyId], sort: 'newest', dateTo, page: i + 1 }).catch((): TmdbSearchHit[] => [])),
    ),
  );
  const listed: Listed[] = pages.flat().map((h) => ({ kind: h.kind, tmdbId: h.tmdbId, title: h.title, releaseDate: h.releaseDate, posterPath: h.posterPath, note: null }));
  return {
    entity: {
      kind: 'company',
      name: profile.name,
      image_url: posterUrl(ctx.imageBase, profile.logoPath, LOGO_SIZE),
      description: profile.description,
      facts: [profile.headquarters ?? profile.country, profile.parent === null ? null : `part of ${profile.parent}`].filter((f): f is string => f !== null),
      link: profile.homepage ?? `https://www.themoviedb.org/company/${profile.id}`,
    },
    titles: await markedTitles(db, ctx, listed),
  };
}

// ---------- a genre, for one title ----------

/** Wall clock for one guide: several web searches, then the answer. */
export const DEFAULT_GUIDE_TIMEOUT_MS = 240_000;
export const GUIDE_MAX_TURNS = 16;
/** Titles the model is asked for, and kept at most. */
export const GUIDE_TITLES_ASKED = 16;

export const GUIDE_SYSTEM_PROMPT = [
  'You help the owner of a film library who clicked a genre on the page of one film or series.',
  'The same genre means something else on every title: a comedy about a con man is not a comedy about a wedding. So work from the title given, not from the genre\'s famous films.',
  'Use WebSearch to find what critics and viewers say about this title\'s tone and premise within that genre, and which other films and series are recommended to people who liked it for those reasons.',
  `Then answer with one JSON object and nothing else, no code fence: {"description": string, "titles": [{"title": string, "year": number, "kind": "movie" | "tv", "why": string}]}.`,
  'description: two or three plain sentences in English on what this genre is in this title: its tone, its kind of story, what sets it apart inside the genre. No spoilers.',
  `titles: up to ${GUIDE_TITLES_ASKED} films or series of that genre closest to this title in tone and premise, each with its exact release title as TMDB lists it, its release year, and in "why" one short line on what it shares with this title. Real titles only, each one checked in a search result; never the title itself; no sequels or prequels of it unless they stand out.`,
].join(' ');

/** What the writer is given about the title. */
export interface GuideInput {
  /** "How to Make a Killing (2026)". */
  title: string;
  kind: TitleKind;
  genre: string;
  /** Every genre of the title, the clicked one included. */
  genres: string[];
  overview: string;
}

export function buildGuideInput(input: GuideInput): string {
  return [
    `Genre clicked: ${input.genre}`,
    `Title: ${input.title} (${input.kind === 'tv' ? 'series' : 'film'})`,
    `Its genres: ${input.genres.join(', ')}`,
    ...(input.overview.trim() === '' ? [] : [`TMDB's synopsis: ${input.overview.trim()}`]),
  ].join('\n');
}

/** One title as the model named it, before TMDB resolves it. */
export interface NamedTitle {
  title: string;
  year: number | null;
  kind: TitleKind;
  why: string;
}

export interface WrittenGuide {
  description: string;
  titles: NamedTitle[];
}

/** The model's answer as a guide. Throws when it holds no JSON object with a description. */
export function parseGuide(text: string): WrittenGuide {
  const from = text.indexOf('{');
  const to = text.lastIndexOf('}');
  if (from === -1 || to <= from) throw new Error('the model answered no JSON');
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(from, to + 1));
  } catch {
    throw new Error('the model answered JSON that does not parse');
  }
  const o = raw as { description?: unknown; titles?: unknown };
  if (typeof o.description !== 'string' || o.description.trim() === '') throw new Error('the model answered no description');
  const titles: NamedTitle[] = [];
  for (const t of Array.isArray(o.titles) ? o.titles : []) {
    const e = t as { title?: unknown; year?: unknown; kind?: unknown; why?: unknown };
    if (typeof e.title !== 'string' || e.title.trim() === '') continue;
    const year = typeof e.year === 'number' && Number.isInteger(e.year) && e.year > 1870 && e.year < 2200 ? e.year : null;
    titles.push({ title: e.title.trim(), year, kind: e.kind === 'tv' ? 'tv' : 'movie', why: typeof e.why === 'string' ? e.why.trim() : '' });
  }
  return { description: o.description.trim(), titles: titles.slice(0, GUIDE_TITLES_ASKED) };
}

/** The seam between a guide and a model. Production: createGuideWriter. Tests: a plain object. */
export interface GuideWriter {
  readonly model: string;
  /** Rejects when the model call fails, times out or answers no guide. */
  write(input: GuideInput): Promise<WrittenGuide>;
}

export interface GuideWriterOptions {
  /** `config.chat.claudeBin`. */
  claudeBin: string;
  /** `<dataDir>/movies-guide`; created on first use, nothing is persisted there. */
  cwd: string;
  model: string;
  /** Default: the SDK's query. Tests inject a fake. */
  query?: QueryFn;
  baseEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Claude through the Agent SDK with WebSearch as its one tool: the owner's login, no MCP servers,
 * no settings, no persisted session (the story writer's setup, src/movies/story.ts, plus the search).
 * Null when the claude binary cannot be found.
 */
export function createGuideWriter(opts: GuideWriterOptions): GuideWriter | null {
  const baseEnv = opts.baseEnv ?? process.env;
  const claudeBin = findClaudeBin(opts.claudeBin, baseEnv.PATH);
  if (claudeBin === null) return null;
  const query: QueryFn = opts.query ?? sdkQuery;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GUIDE_TIMEOUT_MS;

  function optionsFor(abortController: AbortController): Options {
    return {
      abortController,
      cwd: opts.cwd,
      env: claudeEnv(baseEnv),
      model: opts.model,
      pathToClaudeCodeExecutable: claudeBin as string,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      tools: ['WebSearch'],
      allowedTools: ['WebSearch'],
      permissionMode: 'dontAsk',
      maxTurns: GUIDE_MAX_TURNS,
      thinking: { type: 'disabled' },
      systemPrompt: GUIDE_SYSTEM_PROMPT,
      persistSession: false,
    };
  }

  return {
    model: opts.model,
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
        for await (const message of query({ prompt: buildGuideInput(input), options: optionsFor(controller) })) {
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
      if (result !== null && result.trim() !== '') return parseGuide(result);
      throw new Error(timedOut ? `no guide within ${Math.round(timeoutMs / 1000)} s` : (failure ?? 'the model answered nothing'));
    },
  };
}

/** Why a genre's guide could not be given: the route answers `code`. */
export class GuideError extends Error {
  override readonly name = 'GuideError';
  constructor(
    readonly code: 'not_found' | 'not_a_genre' | 'guide_off' | 'guide_failed',
    message: string,
  ) {
    super(message);
  }
}

const sameName = (a: string, b: string): boolean => a.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase() === b.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

/** The TMDB title a named one is: the hit of that exact name (nearest year first), else TMDB's first hit when a year was asked; null when nothing fits. */
export function pickHit(named: NamedTitle, hits: readonly TmdbSearchHit[]): TmdbSearchHit | null {
  const exact = hits.filter((h) => sameName(h.title, named.title) || sameName(h.originalTitle, named.title));
  if (exact.length > 0) {
    const year = named.year;
    if (year === null) return exact[0] ?? null;
    return [...exact].sort((a, b) => Math.abs((a.year ?? 9999) - year) - Math.abs((b.year ?? 9999) - year))[0] ?? null;
  }
  return named.year !== null ? (hits[0] ?? null) : null;
}

export interface GenreGuidesOptions {
  db: Db;
  repo: Pick<MoviesRepo, 'genreGuide' | 'saveGenreGuide' | 'loadTitleMetadata'>;
  /** Null without TMDB credentials: nothing can be resolved, so nothing is written. */
  tmdb: Pick<TmdbClient, 'searchMovie' | 'searchTv'> | null;
  /** Null: NOTESD_MOVIES_STORY_MODEL=off, or no claude binary. Stored guides are still read. */
  writer: GuideWriter | null;
  now?: () => Date;
  log?: (line: string) => void;
}

/** The genre guides of the library: read from the store, and written once per (title, genre) on request. Holds only the writes in flight. */
export class GenreGuides {
  private readonly inFlight = new Map<string, Promise<{ guide: EntityGuide; cached: boolean }>>();
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: GenreGuidesOptions) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  /** The stored guide with today's marks, or null. Never calls a model. */
  async get(id: string, genre: string, ctx: ReadContext): Promise<EntityGuide | null> {
    const row = await this.opts.repo.genreGuide(id, genre);
    if (row === null) return null;
    return this.view(genre, row.description, row.items, row.model, row.writtenAt, ctx);
  }

  /**
   * The guide: the stored one (`cached: true`, no model call) unless `refresh`, else collated now
   * and kept. Two requests for the same guide share one write. Throws GuideError.
   */
  async write(id: string, genre: string, ctx: ReadContext, refresh = false): Promise<{ guide: EntityGuide; cached: boolean }> {
    if (!refresh) {
      const stored = await this.get(id, genre, ctx);
      if (stored !== null) return { guide: stored, cached: true };
    }
    const key = `${id} ${genre.trim().toLowerCase()}`;
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;
    const job = this.writeNew(id, genre, ctx).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }

  private async view(genre: string, description: string, items: readonly GenreGuideItem[], model: string | null, at: Date, ctx: ReadContext): Promise<EntityGuide> {
    const listed = items.map((i) => ({ kind: i.kind, tmdbId: i.tmdbId, title: i.title, releaseDate: i.releaseDate, posterPath: i.posterPath, note: i.why === '' ? null : i.why }));
    return {
      entity: { kind: 'genre', name: genre, image_url: null, description, facts: [], link: null },
      titles: await markedTitles(this.opts.db, ctx, listed),
      written_at: at.toISOString(),
      model,
    };
  }

  private async writeNew(id: string, genre: string, ctx: ReadContext): Promise<{ guide: EntityGuide; cached: boolean }> {
    const { writer, tmdb } = this.opts;
    if (writer === null || tmdb === null) throw new GuideError('guide_off', 'Genre guides are off on this machine (NOTESD_MOVIES_STORY_MODEL=off, no claude binary, or no TMDB credentials).');
    const meta: TitleMetadata | null = await this.opts.repo.loadTitleMetadata(id);
    if (meta === null) throw new GuideError('not_found', `No title ${id} is stored.`);
    const name = meta.genres.find((g) => g.toLowerCase() === genre.trim().toLowerCase());
    if (name === undefined) throw new GuideError('not_a_genre', `${meta.title} has no genre "${genre}".`);
    let written: WrittenGuide;
    try {
      written = await writer.write({ title: meta.year === null ? meta.title : `${meta.title} (${meta.year})`, kind: meta.kind, genre: name, genres: meta.genres, overview: meta.overview ?? '' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[notesd] movies: the ${name} guide of ${id} was not written: ${message}`);
      throw new GuideError('guide_failed', `The guide could not be written: ${message}`);
    }
    const items: GenreGuideItem[] = [];
    for (const named of written.titles) {
      let hit: TmdbSearchHit | null = null;
      try {
        hit = pickHit(named, named.kind === 'tv' ? await tmdb.searchTv(named.title, named.year) : await tmdb.searchMovie(named.title, named.year));
      } catch (err) {
        this.log(`[notesd] movies: TMDB could not be asked for "${named.title}": ${err instanceof Error ? err.message : String(err)}`);
      }
      // A title TMDB does not list is left out, never guessed; so is the title the guide is for, and one named twice.
      if (hit === null || titleId(hit.kind, hit.tmdbId) === id || items.some((i) => i.kind === hit.kind && i.tmdbId === hit.tmdbId)) continue;
      items.push({ kind: hit.kind, tmdbId: hit.tmdbId, title: hit.title, year: hit.year, releaseDate: hit.releaseDate, posterPath: hit.posterPath, why: named.why });
    }
    const at = this.now();
    await this.opts.repo.saveGenreGuide({ titleId: id, genre: name, description: written.description, items, model: writer.model, at });
    this.log(`[notesd] movies: wrote the ${name} guide of ${id} with ${writer.model}: ${items.length} of ${written.titles.length} titles found on TMDB`);
    return { guide: await this.view(name, written.description, items, writer.model, at, ctx), cached: false };
  }
}
