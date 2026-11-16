import type { AnimeMapper, AnimeRef } from '../directStream/anime.js';
import type { EpisodeNeighbors } from '../directStream/types.js';
import type { MoviesService } from './service.js';
import { TmdbError, type TmdbClient, type TmdbTitleNames } from './tmdb.js';
import { streamResumePosition } from './state.js';
import { streamSlot, titleId, type MovieStreamSourceRow, type StreamPositionWrite, type StreamTarget, type TitleMetadata } from './types.js';

/** The resolve error that means the title has no source now. Every other error is the local Chrome's and records nothing. */
export const NO_SOURCE = 'no_source';

/** What MovieStreams needs of the movies service (AppDeps.movies fits). */
export type MovieStreamsSource = Pick<MoviesService, 'repo' | 'tmdb' | 'events' | 'host'>;

/** One resolve's answer as phase 3 parsed it from `direct/cli.mjs resolve` (its JSON shape). */
export interface ResolveRecord {
  ok: boolean;
  source?: {
    provider: string;
    manifest_kind: string;
    best_height?: number | null;
    subtitles?: ReadonlyArray<{ lang?: string | null }>;
  } | null;
  error?: string | null;
}

/** The part of a live player session the position route reads (phase 3's session fits). */
export interface StreamSessionRef {
  id: string;
  ref: StreamTarget;
  source: { provider: string };
}

/** One position report of the player page, validated by the route. */
export interface StreamReading {
  positionS: number;
  durationS: number | null;
  ended: boolean;
}

export interface MovieStreamsOptions {
  now?: () => Date;
  log?: (line: string) => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeTarget(target: StreamTarget): string {
  return target.kind === 'movie' ? `movie ${target.tmdbId}` : `tv ${target.tmdbId} S${target.season ?? '?'}E${target.episode ?? '?'}`;
}

/** True when one of the tracks is English (`en`, `en-US`, `eng`, `English`). */
export function hasEnglishSubtitle(subtitles: ReadonlyArray<{ lang?: string | null }> | undefined): boolean {
  return (subtitles ?? []).some((s) => {
    const lang = (s.lang ?? '').trim().toLowerCase();
    return lang === 'en' || lang === 'eng' || lang === 'english' || lang.startsWith('en-');
  });
}

/** The Stream grid may change when a row is new, or turns verified or stale. */
function visibilityChanged(before: MovieStreamSourceRow | null, after: MovieStreamSourceRow): boolean {
  return (
    before === null ||
    (before.staleAt === null) !== (after.staleAt === null) ||
    (before.verifiedAt === null) !== (after.verifiedAt === null)
  );
}

/**
 * Direct streaming in the movies store. Implements phase 3's hooks (`recordResolve` after every
 * resolve, `resumeS` for a new session) and the player page's position reports. Writes only
 * through MoviesRepo; watch state stays in state.ts. Holds no state of its own: build one per use.
 */
export class MovieStreams {
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(
    private readonly movies: MovieStreamsSource,
    options: MovieStreamsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((line: string) => console.log(line));
  }

  /**
   * Makes sure the target's title row exists (TMDB details, then MoviesRepo.upsertTitle, as a
   * matched file's title is stored). Returns the title id, or null when it is not stored and cannot
   * be (no TMDB credential, TMDB unreachable): the stream is then played but not recorded.
   */
  async ensureTitle(target: StreamTarget): Promise<string | null> {
    const id = titleId(target.kind, target.tmdbId);
    if ((await this.movies.repo.titleById(id)) !== null) return id;
    const tmdb = this.movies.tmdb;
    if (tmdb === null) {
      this.log(`[notesd] direct stream: ${id} is not stored and no TMDB credential is configured; the stream is not recorded`);
      return null;
    }
    let meta: TitleMetadata;
    try {
      meta = target.kind === 'movie' ? await tmdb.movieDetails(target.tmdbId) : await tmdb.tvDetails(target.tmdbId);
    } catch (err) {
      this.log(`[notesd] direct stream: could not fetch ${id} from TMDB: ${messageOf(err)}`);
      return null;
    }
    await this.movies.repo.upsertTitle(meta, this.now());
    return id;
  }

  /**
   * Phase 3's recorder hook, awaited after every resolve. A resolved source verifies the film's or
   * the episode's row on this host; `no_source` makes it stale (R5.4); any other failure (the
   * streaming Chrome is down) records nothing. The title row is ensured first. Never throws.
   */
  async recordResolve(target: StreamTarget, result: ResolveRecord): Promise<void> {
    const source = result.ok ? (result.source ?? null) : null;
    if (source === null && (result.ok || result.error !== NO_SOURCE)) return;
    try {
      const slot = streamSlot(target);
      if (slot === null) return;
      const id = await this.ensureTitle(target);
      if (id === null) return;
      const key = { titleId: id, season: slot.source.season, episode: slot.source.episode, host: this.movies.host, at: this.now() };
      const { before, after } = await this.movies.repo.recordStreamSource(
        source !== null
          ? {
              ...key,
              outcome: 'verified',
              provider: source.provider,
              manifestKind: source.manifest_kind,
              bestHeight: source.best_height ?? null,
              enSubtitle: hasEnglishSubtitle(source.subtitles),
            }
          : { ...key, outcome: 'stale', failure: NO_SOURCE },
      );
      if (visibilityChanged(before, after)) this.emit('stream', id);
    } catch (err) {
      this.log(`[notesd] direct stream: could not record the resolve of ${describeTarget(target)}: ${messageOf(err)}`);
    }
  }

  /**
   * The title's original language (TMDB's code, "ko"), for the resolver's dub check: the stored one,
   * else TMDB's, which is then stored on the title when it has a row. Null when nothing says.
   */
  async originalLanguage(target: StreamTarget): Promise<string | null> {
    try {
      const id = titleId(target.kind, target.tmdbId);
      const row = await this.movies.repo.titleById(id);
      if (row !== null && row.originalLanguage !== null) return row.originalLanguage;
      const tmdb: (TmdbClient & Partial<TmdbTitleNames>) | null = this.movies.tmdb;
      if (tmdb === null || tmdb.originalLanguage === undefined) return null;
      const language = await tmdb.originalLanguage(target.kind, target.tmdbId);
      if (language !== null && row !== null) await this.movies.repo.setOriginalLanguage(id, language, this.now());
      return language;
    } catch (err) {
      if (!(err instanceof TmdbError)) this.log(`[notesd] direct stream: could not read the original language of ${describeTarget(target)}: ${messageOf(err)}`);
      return null;
    }
  }

  /**
   * The episodes before and after one, in the series' order (specials left out), for the player's
   * previous and next buttons. The next one is null when it airs after today. Null when the series
   * is not stored or the episode is not in its list.
   */
  async neighbors(target: StreamTarget): Promise<EpisodeNeighbors | null> {
    try {
      if (target.kind !== 'tv') return null;
      const meta = await this.movies.repo.loadTitleMetadata(titleId(target.kind, target.tmdbId));
      if (meta === null) return null;
      const list = meta.episodes.filter((e) => e.season >= 1).sort((a, b) => a.season - b.season || a.episode - b.episode);
      const at = list.findIndex((e) => e.season === target.season && e.episode === target.episode);
      if (at === -1) return null;
      const number = (e: { season: number; episode: number } | undefined) => (e === undefined ? null : { season: e.season, episode: e.episode });
      const after = list[at + 1];
      const today = this.now().toISOString().slice(0, 10);
      return { prev: number(list[at - 1]), next: after !== undefined && after.airDate !== null && after.airDate > today ? null : number(after) };
    } catch (err) {
      this.log(`[notesd] direct stream: could not read the neighbours of ${describeTarget(target)}: ${messageOf(err)}`);
      return null;
    }
  }

  /**
   * An anime's key for the anime embeds (src/directStream/anime.ts), or null. Only a title whose
   * original language is Japanese is looked up. The episode is found by its TMDB air date, so the
   * title is stored first (its episode list holds the dates).
   */
  async animeRef(target: StreamTarget, mapper: AnimeMapper): Promise<AnimeRef | null> {
    try {
      if ((await this.originalLanguage(target)) !== 'ja') return null;
      if (target.kind === 'movie') return await mapper.lookup({ kind: 'movie', tmdbId: target.tmdbId, airDate: null });
      const id = await this.ensureTitle(target);
      if (id === null) return null;
      const meta = await this.movies.repo.loadTitleMetadata(id);
      const airDate = meta?.episodes.find((e) => e.season === target.season && e.episode === target.episode)?.airDate ?? null;
      return airDate === null ? null : await mapper.lookup({ kind: 'tv', tmdbId: target.tmdbId, airDate });
    } catch (err) {
      this.log(`[notesd] direct stream: could not look ${describeTarget(target)} up as an anime: ${messageOf(err)}`);
      return null;
    }
  }

  /**
   * What the player page calls the stream, in its tab and over the video: `Saltburn (2023)` for a
   * film, `Doctor X: Mafia in White S01E01` for an episode. Null when the title is not stored
   * (the page then shows the TMDB reference).
   */
  async titleLabel(target: StreamTarget): Promise<string | null> {
    try {
      const row = await this.movies.repo.titleById(titleId(target.kind, target.tmdbId));
      if (row === null) return null;
      if (target.kind === 'movie') return row.year === null ? row.title : `${row.title} (${row.year})`;
      const pad = (n: number): string => String(n).padStart(2, '0');
      return target.season === undefined || target.season === null || target.episode === undefined || target.episode === null
        ? row.title
        : `${row.title} S${pad(target.season)}E${pad(target.episode)}`;
    } catch (err) {
      this.log(`[notesd] direct stream: could not read the title of ${describeTarget(target)}: ${messageOf(err)}`);
      return null;
    }
  }

  /** Phase 3's resume hook: where a new session starts (state.ts streamResumePosition). 0 on any failure. */
  async resumeS(target: StreamTarget): Promise<number> {
    try {
      const slot = streamSlot(target);
      if (slot === null) return 0;
      return streamResumePosition(await this.movies.repo.lastStreamPlay(slot.titleId, slot.play.season, slot.play.episode));
    } catch (err) {
      this.log(`[notesd] direct stream: could not read the resume position of ${describeTarget(target)}: ${messageOf(err)}`);
      return 0;
    }
  }

  /**
   * One position report of the player page (R2.4): written on the session's one `movie_plays` row.
   * Emits 'play' when the row opens or closes, never per report, as a VLC play does. Null when the
   * target has no slot or its title cannot be stored.
   */
  async recordPosition(session: StreamSessionRef, reading: StreamReading): Promise<StreamPositionWrite | null> {
    const slot = streamSlot(session.ref);
    if (slot === null) return null;
    const id = await this.ensureTitle(session.ref);
    if (id === null) return null;
    const written = await this.movies.repo.recordStreamPosition({
      sessionId: session.id,
      titleId: id,
      season: slot.play.season,
      episode: slot.play.episode,
      provider: session.source.provider,
      host: this.movies.host,
      positionS: reading.positionS,
      durationS: reading.durationS,
      ended: reading.ended,
      at: this.now(),
    });
    if (written.created || written.closed) this.emit('play', id);
    return written;
  }

  /** Daemon start: closes the stream plays this host left open (MoviesRepo.closeOpenStreamPlays). */
  async closeLeftOpen(): Promise<number> {
    return this.movies.repo.closeOpenStreamPlays(this.movies.host);
  }

  private emit(reason: 'play' | 'stream', id: string): void {
    try {
      this.movies.events.changed(reason, { titleIds: [id] });
    } catch (err) {
      this.log(`[notesd] direct stream: a change listener threw: ${messageOf(err)}`);
    }
  }
}
