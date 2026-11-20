import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { DIRECT_STREAM_TOOL_NAMES } from '../chat/status.js';
import type { AppDeps } from '../deps.js';
import {
  companiesNamed,
  DISCOVER_DEFAULT_LIMIT,
  DISCOVER_DEFAULT_REGION,
  DISCOVER_MAX_LIMIT,
  DISCOVER_MAX_OTHERS,
  genreNamed,
  inWindow,
  keywordsNamed,
  languageCodes,
  looserNames,
  nearlyNamed,
  rankByName,
  releaseWindow,
  shortOverview,
} from '../directStream/discover.js';

import { pickAbsoluteEpisode, pickEpisode, pickEpisodeInSeason, withListedEpisodes, type AbsoluteChoice, type EpisodeChoice, type EpisodeProgress } from '../directStream/episodePick.js';
import {
  dbTitleLibrary,
  LookupError,
  lookupTitle,
  parseTitleRequest,
  sameTitle,
  targetKey,
  type EpisodePick,
  type LookupTmdb,
  type SeasonCount,
  type StreamTarget,
  type TitleCandidate,
  type TitleLibrary,
} from '../directStream/lookup.js';
import { normalizeName } from '../directStream/match.js';
import type { ProviderView } from '../directStream/repo.js';
import { DirectStreamError } from '../directStream/types.js';
import type { MagnetReport } from '../directStream/torrent/source.js';
import type { UpdateSourceAnswer, WatchPages } from '../directStream/updateSource.js';
import { getTitle } from '../movies/read.js';
import { isFreshStreamSource, streamFreshSince } from '../movies/repo.js';
import { audioLanguageArg, MovieStreams } from '../movies/streams.js';
import { TmdbError, type TmdbCatalog, type TmdbClient, type TmdbDiscovery, type TmdbGenre, type TmdbNamedHit } from '../movies/tmdb.js';
import { titleId, type TitleKind } from '../movies/types.js';
import { DEFAULT_WALL_URL } from './instructions.js';
import { libraryMarks, markedTitle, mergeCredits, movieErrorResult, type LibraryMark } from './movieTools.js';
import { jsonResult, type ToolDeps } from './tools.js';

const [FIND, PLAY] = DIRECT_STREAM_TOOL_NAMES;
const [, , SOURCES, UPDATE_SOURCE, DISCOVER] = DIRECT_STREAM_TOOL_NAMES;

export const DIRECT_STREAM_OFF =
  'direct_stream_off: direct streaming is not running on this server (NOTESD_DIRECT_STREAM=off, NOTESD_MOVIES=off, or the daemon was started without it), so nothing can be streamed here.';

/** This host's fresh verified source of a film or one episode (phase 5's movie_stream_sources). */
export interface FreshSource {
  provider: string;
  manifestKind: string;
  bestHeight: number | null;
  enSubtitle: boolean | null;
  verifiedAt: Date;
}

/** What the direct-streaming tools need, bound once per daemon by directStreamToolDeps (tests build their own). */
export interface DirectStreamToolDeps {
  library: TitleLibrary;
  /** Without the discovery calls (a fake that lacks them), direct_stream_discover answers tmdb_unavailable for a company, a service or a plain list. */
  tmdb: (TmdbClient & LookupTmdb & Partial<TmdbDiscovery> & Partial<Pick<TmdbCatalog, 'genres'>>) | null;
  /** A stored series' episodes with their watch state (files and streams) and last play; [] when the series is not stored. */
  progress(tmdbId: number): Promise<EpisodeProgress[]>;
  /** Stores `name` (normalized) as one more name of the title, storing the title first when it is new. False when nothing was added. */
  rememberAlias(candidate: TitleCandidate, name: string): Promise<boolean>;
  /** Default: the clock. */
  now?: () => Date;
  /**
   * DirectStreamService.playWithin: resolve, then open the player page full screen in the streaming Chrome, resuming
   * where the last stream stopped. Answers the play, or `{ pending: true, since, waited_s, stage, attempts }` when
   * it outlasted PLAY_ANSWER_MS: the play goes on in the daemon, and the same call again joins it.
   */
  play(target: StreamTarget, provider?: string, magnet?: string): Promise<unknown>;
  /** MovieStreams.setAudioLanguage: the title's audio language set by the owner ("en"; null: TMDB's original again). False when not stored. Absent in tests' fakes. */
  setAudioLanguage?(target: StreamTarget, language: string | null): Promise<boolean>;
  /** This host's source verified inside the freshness window, or null. */
  freshSource(target: StreamTarget): Promise<FreshSource | null>;
  /** What the library knows of each of these title keys (movieTools.ts libraryMarks); a key it does not hold is absent. */
  marks(ids: readonly string[]): Promise<Map<string, LibraryMark>>;
  /** The title keys with a source verified on this host inside the freshness window (a series: any episode). */
  freshTitles(): Promise<Set<string>>;
  /** DirectStreamService.providers(): the registry with this host's health (direct_stream_sources). */
  providers(): Promise<ProviderView[]>;
  /** DirectStreamService.updateSource: read a site's templates, add and probe the new providers (/update-cloud-source). */
  updateSource(site: string, pages?: WatchPages): Promise<UpdateSourceAnswer>;
  /** DirectStreamService.learnMagnet: a pasted magnet's index, swarm and trackers (/update-cloud-source <magnet>). Absent in tests' fakes. */
  learnMagnet?(magnet: string): Promise<MagnetReport>;
}

/**
 * direct_stream_play answers within this, whatever the play does. Claude Code gives an MCP request over HTTP 60 s
 * to answer (the daemon's /mcp answers plain JSON, so nothing reaches the client before the tool is done), and the
 * chat bar reaches the same tool the same way: on 2026-11-17 a torrent play that took 95 s answered the client
 * "The operation timed out." after 66 s and its attempts were lost. 45 s leaves the title lookup before the play
 * and the answer's way back inside the 60.
 */
export const PLAY_ANSWER_MS = 45_000;

/** A play that outlasted PLAY_ANSWER_MS, as DirectStreamService.playWithin answers it. */
function pendingPlay(play: unknown): { since: string; waited_s: number; stage: string; attempts: unknown[] } | null {
  const p = play as { pending?: unknown; since?: unknown; waited_s?: unknown; stage?: unknown; attempts?: unknown } | null;
  if (p === null || typeof p !== 'object' || p.pending !== true) return null;
  return {
    since: typeof p.since === 'string' ? p.since : '',
    waited_s: typeof p.waited_s === 'number' ? p.waited_s : 0,
    stage: typeof p.stage === 'string' ? p.stage : '',
    attempts: Array.isArray(p.attempts) ? p.attempts : [],
  };
}

/** The tool deps of a running daemon, or null when direct streaming (or the movie library under it) is off. */
export function directStreamToolDeps(deps: AppDeps): DirectStreamToolDeps | null {
  const service = deps.directStream ?? null;
  const movies = deps.movies;
  const config = deps.config.directStream;
  if (service === null || movies === null || config === undefined || !config.enabled) return null;
  return {
    library: dbTitleLibrary(deps.db),
    tmdb: movies.tmdb,
    progress: async (tmdbId) => {
      const detail = await getTitle(deps.db, titleId('tv', tmdbId), { host: movies.host, imageBase: deps.config.movies.tmdb.imageBase });
      return (detail?.seasons ?? []).flatMap((s) =>
        s.episodes.map((e) => ({ season: e.season, episode: e.episode, state: e.state, lastPlayedAt: e.last_played_at, airDate: e.air_date })),
      );
    },
    rememberAlias: async (candidate, name) => {
      const id = await new MovieStreams(movies).ensureTitle({ kind: candidate.kind, tmdbId: candidate.tmdbId });
      return id === null ? false : movies.repo.addTitleAlias(id, normalizeName(name));
    },
    play: async (target, provider, magnet) => {
      // No source named: direct streaming first; the streaming sites only when it found nothing (the service's siteFallback).
      const out = await service.playWithin(target, { ...(provider === undefined ? {} : { provider }), ...(magnet === undefined ? {} : { magnet }) }, PLAY_ANSWER_MS);
      return out.pending ? out : out.result;
    },
    freshSource: async (target) => {
      // Phase 5's one freshness rule: this host's row of the film (0, 0) or the episode, fresh as of now.
      const season = target.kind === 'tv' ? target.season : 0;
      const episode = target.kind === 'tv' ? target.episode : 0;
      const since = streamFreshSince(new Date(), config.freshDays);
      const row = (await movies.repo.streamSourcesOfTitle(targetKey(target), movies.host)).find(
        (r) => r.season === season && r.episode === episode && isFreshStreamSource(r, movies.host, since),
      );
      // A fresh row is verified, so it has a provider and a manifest kind (movie_stream_sources_outcome_check).
      return row === undefined || row.verifiedAt === null
        ? null
        : { provider: row.provider ?? '', manifestKind: row.manifestKind ?? '', bestHeight: row.bestHeight, enSubtitle: row.enSubtitle, verifiedAt: row.verifiedAt };
    },
    marks: (ids) => libraryMarks(deps.db, { host: movies.host, imageBase: deps.config.movies.tmdb.imageBase }, ids),
    freshTitles: async () => new Set(await movies.repo.freshStreamTitleIds(movies.host, streamFreshSince(new Date(), config.freshDays))),
    providers: () => service.providers(),
    updateSource: (site, pages) => service.updateSource(site, pages),
    learnMagnet: (magnet) => service.learnMagnet(magnet),
    setAudioLanguage: (target, language) => new MovieStreams(movies).setAudioLanguage(target, language),
  };
}

const FIND_DESCRIPTION =
  "Look a film or series up for direct streaming: a stream played in the owner's own player page straight from a cloud source, with no site and no adverts. " +
  'Pass title (the words without the year; or a movie id like M-23T4, of a title or of one episode; or a title key like movie-550 or tv-1399), year when known, and kind (movie or tv) when the owner said which. ' +
  "Titles already stored (the library, and titles streamed before) are matched first, then TMDB. A title matches when its English or original name, a name the owner gave it before, or one of TMDB's alternative titles is the asked title, and its year is the asked year when one was given. " +
  'With status none, did_you_mean lists titles close to the words (a site may call a title by another name than TMDB does): show them and ask; none of them is a match. ' +
  'Returns { status: one | several | none, matches: [{ title, original_title, year, kind, tmdb_id, movie_id, url, tmdb_url, episode, stream }] }. stream says whether this machine has a source verified recently: ' +
  'verified true with provider, manifest_kind, best_height and en_subtitle; verified false when none is known yet (it may still stream: only playing tries); verified null for a series named without an episode, whose episodes are checked when played. ' +
  'This tool only looks: nothing is resolved and nothing opens. To start one, call direct_stream_play.';

const PLAY_DESCRIPTION =
  'Stream one film, or one episode of a series, directly: the daemon finds a cloud source (providers with an English subtitle first), then opens its own player page full screen in the streaming Chrome window on the Windows side, ' +
  'resuming where the last stream of it stopped. It takes 5 to 40 seconds; call it once and wait. ' +
  'It always answers within about 45 seconds. A play that needs longer (a torrent whose swarm is slow, a cloud resolve through many providers) answers started false with pending true, stage (what is being tried now) and attempts (those finished so far): ' +
  'the play goes on in the daemon and the player opens by itself when a source plays. Say it is still starting, then call again with the same arguments, which joins that play and never starts a second one. ' +
  'Before a provider\'s stream of a title plays for the first time the daemon looks at two frames of it and passes over a cinema recording or a copy with a burned-in advert for the next provider (its attempt says "picture: watermark" or "picture: recording"; "picture: clean" is the one that plays), which adds 10 to 40 seconds to a first play. When no provider had a proper copy, the first one found plays: say so. ' +
  'provider asks one named provider only (a name from direct_stream_sources) and passes over a cache: for "stream it from VidLink", or when the stream that started is a cinema recording or a dub and another provider is known to be clean. ' +
  'provider "torrent" asks only the torrent source: a torrent of the title found by its IMDb id, downloaded from the swarm while it plays and served by this daemon (for "stream it from a torrent"). ' +
  'provider "cloud" asks the cloud providers only and never a torrent, neither a download on disk nor the swarm (no_source then means no cloud provider had it). ' +
  'The owner\'s codenames name the source, as one upper-case word, usually the last of the request and never part of the title: TM (a film) and TS (a series) are provider "torrent"; NTM and NTS are provider "cloud"; DM and DS are the library (movies_continue, VLC), not this tool. "continue OP TS" is title "OP", provider "torrent". Without a codename pass no provider. ' +
  'Call it only when the owner asks to stream (/direct-stream <title>, "stream it", "let\'s direct-stream the first one"). A film in the library plays in VLC with movies_continue unless the owner says stream; a recommendation is not a request; a question is direct_stream_find. ' +
  'Pass title (words without the year, a movie id, or a title key) with year when known. For a series pass season and episode only when the owner named them (an episode\'s movie id names both); ' +
  'a season named without an episode ("play House of the Dragon season 2") is season alone: the daemon starts the season\'s first unfinished episode (picked first, resume or next; a season already finished starts again at its first episode), or answers skipped_play no_such_season; ' +
  'when the owner named an episode by one number without a season ("One Piece episode 730", "resume one piece from episode 730"), pass absolute_episode alone: the daemon maps it to the season and episode TMDB lists (the 730th episode in order; a long anime\'s own numbers run on across seasons) and answers picked absolute with the season and episode it chose, ' +
  'or skipped_play episode_unclear with candidates when the count and the numbering name different episodes (list them and ask; then call again with that season and episode), or no_such_episode when the series is shorter. Otherwise: ' +
  'without them the daemon picks the episode from what was watched, on file or streamed (picked: first, nothing played yet; resume, the episode played last is unfinished and carries on where it stopped; next, the episode after the last finished one). ' +
  'started true: the player page is open, season and episode say which episode, and play carries the session and the source (provider, quality, subtitles). ' +
  'The daemon remembers how each title was last streamed on this machine, and a call without provider goes there first: the cloud provider that streamed it (alone; the others only when it has no stream now), or the torrents. ' +
  'A title never streamed whose last cloud search found nothing in the last three days goes to the torrents first. Naming a provider (a codename) always overrides this, and what plays then is what is remembered from then on. ' +
  'The streaming sites (idlix, lk21, flicksy, dramacool) are the last resort of a call without provider or magnet: only when every cloud provider and every torrent found nothing does the daemon ask the site the title was last played on (at its page there), then the others in order (a film: idlix, lk21, flicksy; an episode: idlix, dramacool), each by its own search, which plays only on exactly one match. ' +
  'started true with play { site, site_url, site_play, attempts } and no session means a site plays it: attempts ends with one "Site: <name>" per site asked. A call with a provider, a codename or a magnet never asks a site. A pending play that ends on a site is answered so on the next call. ' +
  'started false with skipped_play says why nothing started: several_matches (list candidates with their years and ask which, then call again with that one\'s movie_id, or title and year), ' +
  'caught_up (every episode after the last one played is finished or there is none: say so, with last and seasons), not_aired (the next episode airs on air_date), ' +
  'or no_match: did_you_mean lists titles close to the words, none of them the asked name; show them with their years and ask which. When the owner picks one, call again with its title_key (or movie_id) and asked_as set to the name the owner first used, ' +
  'so that name finds the title from then on. Never pass asked_as for a name the owner did not use. ' +
  'The error no_source means no provider and no torrent (and, without provider, no streaming site) could stream it, and nothing started: attempts lists each provider with its outcome (resolved, no_stream, bot_check, error, dubbed, unplayable, skipped_browser_only, skipped_no_template); when no provider resolved, the torrent source was tried before answering, and its attempts follow: "Index: <name>" for each torrent index asked and "Torrent: <release>" for each torrent tried (dubbed: its audio is another language; unplayable: Chrome cannot play the file as is; no_stream: no file list or too little data from the swarm in time); "Site: <name>" for each streaming site asked after them (no_stream: it does not list the title or episode; skipped: several titles of that name, none guessed). When a provider was named, offer /idlix or /lk21. ' +
  'When it plays from a torrent, play.session.provider is Torrent and play.session.torrent is { info_hash, file_index, name, index, state, seeds }; a title whose torrent download is whole on this machine plays again from disk with no index and no swarm asked (no Index: or Torrent: attempt). Several torrents are opened side by side and the one whose swarm delivers plays: its attempt names the peers connected and the rate, and the others are skipped ("its header arrived too", "still opening"). An index that failed three plays in a row is skipped for half an hour ("Index: <name>" skipped). One call tries at most six torrents; when more were found, a failed play ends with the attempt "Torrents: not tried yet" saying how many are left, and the daemon remembers the ones that failed: calling again with the same arguments tries the next ones, not the same (say so, and call again only when the owner asks). Attempts may also hold "Subtitles: <tier>" for each subtitle source asked; "Subtitles: pending" means the film started before the subtitle search ended, and the player adds the track when it arrives (say so). The error torrent_off means torrents are off on this machine (NOTESD_TORRENT=off). ' +
  'A stream always plays in the title\'s original language: a provider whose stream is dubbed into another language is skipped (dubbed), and play.session.audio says what was heard (languages; original true when the stream names the original language, null when it names none). ' +
  'The original language is TMDB\'s unless the owner set the title\'s audio language: pass audio_lang (a language code, "en") for a title whose spoken language differs from TMDB\'s original language (a French production shot in English, such as Léon: The Professional, refused as dubbed), or when the owner explicitly asks for another audio language ("Léon with English audio"). ' +
  'It is stored on the title before the play resolves, so this play and every later one check for that language (movies_get shows it as audio_language); audio_lang "original" (or "") clears it. Never pass it on your own to get past a dubbed refusal: a dub is never chosen without the owner. ' +
  'The errors resolve_failed and open_failed mean the streaming Chrome could not be used: reason says why (no_chrome, chrome_not_reachable, ...). ' +
  'When this machine holds a cache of the film or episode (made with direct_stream_cache), the play comes from it: play.session.cached is { id, state, height }. state ready plays from disk with no provider asked (attempts is empty, and it works with the internet down); state downloading plays what is on disk and fetches each part not there yet as the film reaches it. A failed cache, or one made on the other machine, is not used: the play resolves as usual. ' +
  'Tell the owner it plays in the streaming Chrome window and that a double click, F, Esc or F11 leaves full screen. Works only on the machine with Windows Chrome.';

const SOURCES_DESCRIPTION =
  'List the direct-streaming providers in this machine\'s registry: each one\'s name, film and episode address templates ' +
  '({id} is the TMDB id), whether it plays only in its own page (browser_only), whether it is known to offer an English subtitle, ' +
  'the aggregator site it was added from (origin_site, null for the checked-in seed) and when, and this machine\'s health for it ' +
  '(last success and failure, consecutive failures, median seconds to a stream, best quality). Health is per machine: the other ' +
  'laptop measures its own. delivery says how the provider\'s stream host delivered the last play from it on this machine in the ' +
  'last three days: verdict good or bad (bad: a quarter of its segment requests failed, or the player kept stalling), with requests, ' +
  'failed, stalls and median_kbps; null when nothing played from it lately. A provider with a bad delivery is tried after the others. ' +
  'Read-only: nothing opens and nothing is probed.';

const UPDATE_SOURCE_DESCRIPTION =
  'Add the providers an aggregator streaming site uses that the registry lacks, and probe each new one. Use it for ' +
  '"/update-cloud-source <site url>" in Claude Code. It reads the site\'s page and scripts with plain requests (no browser) for ' +
  'provider address templates. When the scripts hold none, it opens a watch page of the site (watch_page, else the site address itself) in a background tab of the streaming Chrome, muted, ' +
  'and derives templates from the addresses of the embed frames the page loads: the film\'s TMDB id becomes {id}, and with episode_page the season and episode too; such a provider is named after its frame\'s host. ' +
  'A site that plays in its own page has no frame: when the watch page loaded a stream by itself, its own address becomes the template (reader page), named after the site\'s host. ' +
  'reader says which way found the providers (scripts, frames or page), per provider too. A plain request answered with a bot check is read through the frames only when watch_page was given, and a bot check in the streaming Chrome is the answer bot_check: it is never got past. It keeps the ones whose host and path the registry does not have (a name already taken by another host ' +
  'is stored as "<name> (<host>)"; existing providers are never changed), inserts them, then resolves each known title (Fight Club ' +
  'and the others) with only that provider, recording its health on this machine. Probing opens tabs in the streaming Chrome out ' +
  'of sight, plays nothing and makes no sound; a provider that finds nothing takes about 35 seconds per title, so the call can take ' +
  'minutes. Answers ok: true with added (per provider: resolves, and per title the outcome, seconds, manifest kind, best height, ' +
  'English subtitle), known (found but already in the registry) and skipped; or ok: false with error bot_check, no_templates, ' +
  'chrome_unavailable (the streaming Chrome could not open the watch page), no_tab, unreachable, bad_url, reader_failed or busy, and the registry unchanged. ' +
  'Only the frames a page loads by itself are read: its other server buttons are not pressed. ' +
  'A site whose Cloudflare challenge keeps answering bot_check can instead be read from a tab the owner already solved the challenge in by hand ' +
  '(the owner runs `node claude/streaming/direct/cli.mjs gate <site>`, solves it, then this is called again with from_tab: true): that reads the SAME tab\'s current frames with no new navigation, so the challenge never shows again. ' +
  'no_tab means no such gated tab answered; gate it again and retry promptly. ' +
  'With magnet instead of site (a magnet link the owner pasted, or a bare 40-character info hash) it reads where that torrent comes from and widens the torrent sources: nothing is played and no swarm is joined. ' +
  'A torrent index that runs its own trackers signs its magnets with them, so origin names the index (index, label, by: the tracker host that says so; supported: the finder has a site module for it; enabled; site_origin; gate: what the owner must do once by hand before it answers), or is null when the trackers name no index we know, with unknown_hosts listing the tracker hosts that are neither a known index\'s nor a public tracker we hold. ' +
  'trackers says what became of the magnet\'s trackers: own (the index\'s own, never added), known (already used), added (new public UDP trackers that answered a scrape: from now on added to every torrent opened and asked for seeders before a play), silent (did not answer, not added) and skipped (not UDP). ' +
  'swarm is what the trackers know of this torrent now ({ seeders, leechers, trackers }), or null when none answered. next says what to do. Errors: bad_magnet, torrent_off.';

const siteField = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((value) => /^https?:\/\//i.test(value), 'an http or https address');

/**
 * The registry tools (/update-cloud-source): list the providers with this host's health, and
 * add a site's new providers. Without deps.directStream both answer direct_stream_off, as phase 7's do.
 */
function registerDirectStreamSourceTools(server: McpServer, deps: Pick<ToolDeps, 'directStream'>): void {
  const off = (): CallToolResult => ({ isError: true, content: [{ type: 'text', text: DIRECT_STREAM_OFF }] });

  server.registerTool(
    SOURCES,
    {
      title: 'List the direct-streaming providers',
      description: SOURCES_DESCRIPTION,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const d = deps.directStream;
      if (!d) return off();
      return respond(async () => {
        const providers = await d.providers();
        return ok({ count: providers.length, providers });
      });
    },
  );

  server.registerTool(
    UPDATE_SOURCE,
    {
      title: 'Add an aggregator site\'s new stream providers',
      description: UPDATE_SOURCE_DESCRIPTION,
      inputSchema: {
        site: siteField.optional().describe('The aggregator site\'s address, such as https://ww6-fmovies.com/ (its home page or a film page). Required unless magnet is given.'),
        magnet: z
          .string()
          .trim()
          .min(40)
          .max(8000)
          .optional()
          .describe('Instead of site: a magnet link the owner pasted (magnet:?xt=urn:btih:...), or a bare 40-character info hash. Never one you built.'),
        watch_page: siteField
          .optional()
          .describe('Only when the owner gave one: a film\'s watch page on the site, for the frame reader (a page of a known title works best: Fight Club, TMDB 550).'),
        episode_page: siteField.optional().describe('Only when the owner gave one: an episode\'s watch page on the site, for the episode template.'),
        from_tab: z
          .boolean()
          .optional()
          .describe('Only after the owner solved this site\'s Cloudflare challenge by hand (node claude/streaming/direct/cli.mjs gate <site>): read that gated tab\'s current frames instead of opening a fresh one.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ site, magnet, watch_page, episode_page, from_tab }) => {
      const d = deps.directStream;
      if (!d) return off();
      if (magnet !== undefined) {
        if (site !== undefined) return failJson({ error: 'invalid_input', message: 'Pass site or magnet, not both.' });
        const learn = d.learnMagnet;
        if (learn === undefined) return failJson({ error: 'torrent_off', message: 'Torrents are off on this machine (NOTESD_TORRENT=off).' });
        return respond(async () => {
          const report = await learn(magnet);
          return report.ok ? ok(report) : failJson(report);
        });
      }
      if (site === undefined) return failJson({ error: 'invalid_input', message: 'Pass site (an aggregator site\'s address) or magnet (a pasted magnet link).' });
      return respond(async () => ok(await d.updateSource(site, { watchPage: watch_page, episodePage: episode_page, fromTab: from_tab })));
    },
  );
}

const DISCOVER_DESCRIPTION =
  "Find films and series on TMDB to stream, by anything but a title: kind (movie or tv; both when left out), year or year_from / year_to, language (the original language, as a name or code: \"Spanish\", \"ko\"; \"Chinese\" is Mandarin and Cantonese together), " +
  'genre (one or several English names, every one must fit: "horror", "action", "comedy"), keyword (one or several words for what it is about, any one may fit: "mafia", "zombie", "revenge"), ' +
  'person (a name; role any, cast, crew or director), company (a production company or studio: "Blumhouse", "A24") and service (a streaming service or network: "Shudder", "Netflix"; region picks the country whose catalogue is read, default US). ' +
  'sort is popular (default) or newest (release date, newest first). Titles not released yet are left out. ' +
  '"Spanish series released this year" is kind tv, language Spanish, year this year; "the most recent Shudder movie" is kind movie, service Shudder, sort newest; "Blumhouse films this year" is company Blumhouse with the year; "a Johnny Depp movie, the more recent the better" is person Johnny Depp, role cast, kind movie, sort newest; "one of Nolan\'s movies" is person Christopher Nolan, role director. ' +
  '"an Indonesian horror movie released this year" is kind movie, language Indonesian, genre horror, year this year; "a Thai comedy from 2025" is kind movie, language Thai, genre comedy, year 2025; "a Chinese action movie" is kind movie, language Chinese, genre action; ' +
  '"a Kdrama with bloody action" is kind tv, language Korean, genre action, keyword ["gore", "bloody", "violence", "revenge"]; "Korean mafia movies this year" is kind movie, language Korean, keyword ["mafia", "gangster", "organized crime"], year this year. ' +
  'A genre is read per kind, since TMDB files series under fewer genres: for a series "action" and "adventure" are Action & Adventure, "sci-fi" and "fantasy" are Sci-Fi & Fantasy, and there is no Horror, Thriller or Romance (pass those as keyword for a series). filters.genres says what was understood. ' +
  'A keyword stands for the TMDB keyword of that name and the ones that hold it as a word (filters.keywords). TMDB tags few titles, recent and non-English ones least: when no title carries a keyword the list comes back without the keyword filter and filters.keywords_dropped is true; then choose by overview and by what you know of the titles (a web search helps), and say the list was not filtered by it. keyword cannot be combined with person. ' +
  'A person no search finds is looked for again by a shorter form of the name, and one whose name differs by a letter or two is taken ("park bo yeung" is Park Bo-young; filters.person.asked_as keeps the words asked): still, pass the right spelling when you know it. A person\'s most recent project is person with sort newest and no kind (films and series together); leave out the entries where their role is Self or a gala. ' +
  'Names are resolved to TMDB ids here: the best match is used and named in filters, and other_people, other_companies and other_services list what else the name fits; pass person_id, company_id or service_id to pick one of those instead. ' +
  'A studio\'s name stands for every company that starts with it ("Blumhouse" is Blumhouse Productions, Blumhouse Television and the others, listed in filters.companies), unless one company has exactly that name; company_id narrows to one. person cannot be combined with company or service. ' +
  'Returns { filters, count, titles: [{ kind, tmdb_id, title_key, movie_id, title, original_title, release_date, original_language, overview, roles (with person), in_library, state, seen, started, not_interested, interested, stream: { verified }, url, tmdb_url }] }, marked against the owner\'s library the way movies_person marks a filmography: ' +
  'seen true when the owner finished or opened it, started when they began it, not_interested when they said they do not want it, interested when they marked it to watch later (a good one to choose when they ask you to pick), stream.verified true when this machine has a recently verified source for it (it may still stream when false: only playing tries). ' +
  'This tool only looks: nothing is resolved and nothing opens. To stream one, call direct_stream_play with its title_key as title. When the owner asked you to choose ("pick one for me", "play one", "let\'s watch a Madelyn Cline movie"), pass unseen_only true: the titles they have seen or marked not interested are then left out of the list (left_out counts them), so the one you choose is never one they watched; choose one yourself, play it and say which and why. Leave unseen_only out only when they ask to rewatch ("rewatch one of Nolan\'s") or only ask what there is: then list the titles and start nothing. A title the owner names is played with direct_stream_play whether they have seen it or not. ' +
  'Reads TMDB over the network: tmdb_unavailable means this server has no TMDB credentials, tmdb_error that TMDB could not be reached.';

const titleField = z.string().trim().min(1).max(200);
const yearField = z.number().int().min(1880).max(2100);
const kindField = z.enum(['movie', 'tv']);
const seasonField = z.number().int().min(0).max(1000);
const episodeField = z.number().int().min(0).max(100000);
const nameField = z.string().trim().min(1).max(120);
const tmdbIdField = z.number().int().positive();
/** One name or a short list of them (genres, keywords). */
const namesField = z.union([nameField, z.array(nameField).min(1).max(6)]);

function ok(value: unknown): CallToolResult {
  return jsonResult(value, true);
}

function failJson(value: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }] };
}

async function respond(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return movieErrorResult(err);
  }
}

export function label(c: TitleCandidate): string {
  return c.year === null ? c.title : `${c.title} (${c.year})`;
}

export function candidateView(c: TitleCandidate, wall: string) {
  return {
    title: c.title,
    ...(c.originalTitle !== c.title ? { original_title: c.originalTitle } : {}),
    year: c.year,
    kind: c.kind,
    tmdb_id: c.tmdbId,
    movie_id: c.movieId,
    title_key: titleId(c.kind, c.tmdbId),
    url: c.movieId === null ? null : `${wall}/movies/${encodeURIComponent(c.movieId)}`,
    tmdb_url: `https://www.themoviedb.org/${c.kind}/${c.tmdbId}`,
  };
}

/** The film, the episode a movie id named, or the season and episode passed; null for a series with no episode. */
export function targetFor(c: TitleCandidate, named: EpisodePick | null, season: number | undefined, episode: number | undefined): StreamTarget | null {
  if (c.kind === 'movie') {
    if (season !== undefined || episode !== undefined) {
      throw new LookupError('invalid_input', `${label(c)} is a film: it takes no season or episode.`);
    }
    return { kind: 'movie', tmdbId: c.tmdbId };
  }
  const pick = named ?? (season !== undefined && episode !== undefined ? { season, episode } : null);
  return pick === null ? null : { kind: 'tv', tmdbId: c.tmdbId, season: pick.season, episode: pick.episode };
}

/** A series' seasons with their episode counts: stored episodes first, else TMDB; null when neither knows. */
async function seasonsOf(c: TitleCandidate, d: DirectStreamToolDeps): Promise<SeasonCount[] | null> {
  const stored = await d.library.seasons(c.kind, c.tmdbId);
  if (stored.length > 0) return stored;
  if (d.tmdb === null) return null;
  try {
    const meta = await d.tmdb.tvDetails(c.tmdbId);
    const counts = new Map<number, number>();
    for (const e of meta.episodes) if (e.season >= 1) counts.set(e.season, (counts.get(e.season) ?? 0) + 1);
    return [...counts.entries()].sort(([a], [b]) => a - b).map(([season, episodes]) => ({ season, episodes }));
  } catch (err) {
    if (err instanceof TmdbError) return null;
    throw err;
  }
}

/** A series' episodes as TMDB lists them now; null when TMDB cannot be asked. */
async function listedEpisodes(c: TitleCandidate, d: DirectStreamToolDeps): Promise<{ season: number; episode: number; airDate: string | null }[] | null> {
  if (d.tmdb === null) return null;
  try {
    return (await d.tmdb.tvDetails(c.tmdbId)).episodes;
  } catch (err) {
    if (err instanceof TmdbError) return null;
    throw err;
  }
}

/**
 * The episode a series named without one streams (episodePick.ts). The stored episodes decide;
 * TMDB's list is read when the series is not stored, or when the stored list has no episode left
 * (a series still airing has newer ones).
 */
export async function chooseEpisode(c: TitleCandidate, d: DirectStreamToolDeps): Promise<EpisodeChoice> {
  const today = (d.now?.() ?? new Date()).toISOString().slice(0, 10);
  const stored = await d.progress(c.tmdbId);
  const choice = pickEpisode(stored, today);
  if (stored.length > 0 && choice.pick !== 'caught_up') return choice;
  const listed = await listedEpisodes(c, d);
  return listed === null ? choice : pickEpisode(withListedEpisodes(stored, listed), today);
}

/**
 * The episode a season named without one streams (episodePick.ts pickEpisodeInSeason). The stored
 * episodes decide while the season has one left to watch; otherwise TMDB's list is read too (a
 * series not stored, or a season still airing). Null: no list holds the season.
 */
export async function chooseInSeason(c: TitleCandidate, season: number, d: DirectStreamToolDeps): Promise<EpisodeChoice | null> {
  const today = (d.now?.() ?? new Date()).toISOString().slice(0, 10);
  const stored = await d.progress(c.tmdbId);
  if (stored.some((e) => e.season === season && e.state !== 'finished')) return pickEpisodeInSeason(stored, season, today);
  const listed = await listedEpisodes(c, d);
  return pickEpisodeInSeason(listed === null ? stored : withListedEpisodes(stored, listed), season, today);
}

/** The air date of one episode in a list, or null. */
function airDateOf(list: readonly { season: number; episode: number; airDate: string | null }[], season: number, episode: number): string | null {
  return list.find((e) => e.season === season && e.episode === episode)?.airDate ?? null;
}

/**
 * The episode an absolute number names (episodePick.ts pickAbsoluteEpisode), with the list it was
 * read from. The stored episodes decide; TMDB's list is read when the series is not stored, or
 * when the stored list is too short for the number (a series still airing).
 */
export async function chooseAbsolute(
  c: TitleCandidate,
  n: number,
  d: DirectStreamToolDeps,
): Promise<{ choice: AbsoluteChoice; list: readonly { season: number; episode: number; airDate: string | null }[] }> {
  const stored = await d.progress(c.tmdbId);
  const choice = pickAbsoluteEpisode(stored, n);
  if (stored.length > 0 && choice.pick !== 'unknown') return { choice, list: stored };
  const listed = await listedEpisodes(c, d);
  return listed === null || listed.length <= stored.length ? { choice, list: stored } : { choice: pickAbsoluteEpisode(listed, n), list: listed };
}

async function streamView(d: DirectStreamToolDeps, target: StreamTarget | null) {
  if (target === null) return { verified: null, note: 'a series is checked per episode, when one is played' };
  const s = await d.freshSource(target);
  if (s === null) return { verified: false };
  return {
    verified: true,
    provider: s.provider,
    manifest_kind: s.manifestKind,
    best_height: s.bestHeight,
    en_subtitle: s.enSubtitle,
    verified_at: s.verifiedAt.toISOString(),
  };
}

/**
 * A failure DirectStreamService.play threw (phase 3's DirectStreamError), as the tool answers it:
 * `no_source` with every attempt, or `resolve_failed` / `open_failed` with the `reason` (no_chrome,
 * chrome_not_reachable, ...). Null for anything else, which movieErrorResult answers.
 */
function playFailure(err: unknown): { error: string; reason: string | null; attempts: unknown[]; message: string } | null {
  if (!(err instanceof DirectStreamError)) return null;
  return { error: err.code, reason: err.code === 'no_source' ? null : err.reason, attempts: err.attempts, message: err.message };
}

/** What a started play's `next` adds when it plays from this machine's cache (play.session.cached); '' otherwise. */
function cacheNext(play: unknown): string {
  const cached = (play as { session?: { cached?: { state?: unknown } | null } } | null)?.session?.cached;
  if (cached === null || cached === undefined || typeof cached !== 'object') return '';
  return cached.state === 'ready'
    ? " Say it plays from this machine's cache (no provider was asked)."
    : " Say it plays from this machine's cache while the cache is still downloading, so a part not downloaded yet is fetched as it is reached.";
}

/**
 * direct_stream_find and direct_stream_play (DIRECT_STREAMING_PLAN phase 7). Words become a TMDB
 * reference through src/directStream/lookup.ts; a play goes through DirectStreamService.play.
 * Without deps.directStream both answer DIRECT_STREAM_OFF and nothing is looked up or started.
 */
export function registerDirectStreamTools(server: McpServer, deps: Pick<ToolDeps, 'directStream' | 'wallUrl'>): void {
  const wall = (deps.wallUrl ?? DEFAULT_WALL_URL).replace(/\/+$/, '');
  const off = (): CallToolResult => ({ isError: true, content: [{ type: 'text', text: DIRECT_STREAM_OFF }] });

  server.registerTool(
    FIND,
    {
      title: 'Find a title to stream directly',
      description: FIND_DESCRIPTION,
      inputSchema: {
        title: titleField.describe('The film or series title without the year, a movie id (M-23T4), or a title key (movie-550).'),
        year: yearField.optional().describe('The release year, when known. Tells a remake from its original.'),
        kind: kindField.optional().describe('"movie" or "tv" (a series), when the owner said which.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ title, year, kind }) => {
      const d = deps.directStream;
      if (!d) return off();
      return respond(async () => {
        const result = await lookupTitle(parseTitleRequest(title, year ?? null, kind ?? null), d);
        const found =
          result.status === 'none'
            ? []
            : result.status === 'one'
              ? [{ candidate: result.candidate, episode: result.episode }]
              : result.candidates.map((candidate) => ({ candidate, episode: null }));
        const matches = await Promise.all(
          found.map(async ({ candidate, episode }) => ({
            ...candidateView(candidate, wall),
            episode,
            stream: await streamView(d, targetFor(candidate, episode, undefined, undefined)),
          })),
        );
        return ok({
          status: result.status,
          matches,
          ...(result.status === 'none' ? { did_you_mean: result.nearMisses.map((c) => candidateView(c, wall)) } : {}),
          next:
            result.status === 'none'
              ? result.nearMisses.length > 0
                ? 'No title has that name (or that name and year). Say so, show did_you_mean with years and kinds, and ask whether one of them is meant.'
                : 'No title has that name (or that name and year). Say so.'
              : 'Nothing was started. To stream one, call direct_stream_play with its movie_id, or its title and year.',
        });
      });
    },
  );

  server.registerTool(
    PLAY,
    {
      title: 'Stream a film or episode directly, full screen',
      description: PLAY_DESCRIPTION,
      inputSchema: {
        title: titleField.describe('The film or series title without the year, a movie id (M-23T4; an episode\'s id names its season and episode), or a title key (movie-550).'),
        year: yearField.optional().describe('The release year, when known.'),
        kind: kindField.optional().describe('"movie" or "tv" (a series), when the owner said which.'),
        season: seasonField.optional().describe('A series only: the season to stream from. Alone, without episode, it starts the first unfinished episode of that season.'),
        episode: episodeField.optional().describe('A series only: the episode number within that season.'),
        provider: z.string().trim().min(1).max(60).optional().describe('Only when the owner names a provider ("stream it from VidLink") or a codename, or to leave a bad stream for a known good one: a name from direct_stream_sources. Only that provider is asked. "torrent" asks the torrent source only ("stream it from a torrent", TM, TS); "cloud" asks the cloud providers only, never a torrent (NTM, NTS).'),
        magnet: z
          .string()
          .trim()
          .min(1)
          .max(4000)
          .optional()
          .describe('A magnet link ("magnet:?xt=urn:btih:...") or a bare 40-character info hash the owner pasted to play that exact torrent, skipping every index. Still pass title (and year/kind) so the play has a title, poster, resume and the original-language check: the magnet only replaces which torrent. A torrent play, so provider need not be set; the file is played only when its audio is the title\'s original language and it holds a video Chrome can play.'),
        absolute_episode: z
          .number()
          .int()
          .min(1)
          .max(100000)
          .optional()
          .describe('A series only, instead of season and episode: an episode named by one number without a season ("One Piece episode 730").'),
        asked_as: titleField
          .optional()
          .describe('Only after the owner picked a title from did_you_mean: the name they first used for it, word for word. It is remembered as another name of this title.'),
        audio_lang: z
          .string()
          .trim()
          .max(20)
          .optional()
          .describe('The audio language to play the title in from now on, as a 2- or 3-letter code ("en"): only for a title whose spoken language differs from TMDB\'s original language (a French production shot in English), or when the owner explicitly asks for another audio language. Stored on the title before the play. "original" or "" clears it.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ title, year, kind, season, episode, absolute_episode, asked_as, provider, magnet, audio_lang }) => {
      const d = deps.directStream;
      if (!d) return off();
      const audioLanguage = audio_lang === undefined ? undefined : audioLanguageArg(audio_lang);
      if (audio_lang !== undefined && audioLanguage === undefined) {
        return failJson({ error: 'invalid_input', message: 'audio_lang is a 2- or 3-letter language code ("en"), or "original" to go back to TMDB\'s original language.' });
      }
      return respond(async () => {
        const result = await lookupTitle(parseTitleRequest(title, year ?? null, kind ?? null), d);
        if (result.status === 'none') {
          return ok({
            started: false,
            skipped_play: 'no_match',
            query: { title, year: year ?? null },
            did_you_mean: result.nearMisses.map((c) => candidateView(c, wall)),
            next:
              result.nearMisses.length > 0
                ? 'Nothing started: no title has that name (or that name and year). Show did_you_mean with years and kinds and ask whether one of them is meant. When the owner picks one, call again with its title_key and asked_as set to the name they used.'
                : 'No title has that name (or that name and year). Say so; nothing started.',
          });
        }
        if (result.status === 'several') {
          return ok({
            started: false,
            skipped_play: 'several_matches',
            candidates: result.candidates.map((c) => candidateView(c, wall)),
            next: 'Nothing started. List the candidates with their years and ask which one; then call again with its movie_id, or its title and year.',
          });
        }
        const c = result.candidate;
        // A name the owner confirmed for this title: remembered whether or not a source resolves.
        const remembered =
          asked_as !== undefined && normalizeName(asked_as) !== '' && !sameTitle(c, { name: asked_as, year: null }) ? await d.rememberAlias(c, asked_as) : false;
        let target = targetFor(c, result.episode, season, episode);
        let choice: EpisodeChoice | null = null;
        if (absolute_episode !== undefined) {
          if (c.kind !== 'tv') throw new LookupError('invalid_input', `${label(c)} is a film: it takes no episode.`);
          if (target !== null || season !== undefined || episode !== undefined) {
            throw new LookupError('invalid_input', 'pass absolute_episode alone, or season and episode: not both.');
          }
          const today = (d.now?.() ?? new Date()).toISOString().slice(0, 10);
          const { choice: absolute, list } = await chooseAbsolute(c, absolute_episode, d);
          if (absolute.pick === 'unknown') {
            return ok({
              started: false,
              skipped_play: 'no_such_episode',
              title: candidateView(c, wall),
              absolute_episode,
              episodes: absolute.episodes,
              seasons: await seasonsOf(c, d),
              next: `Nothing started: ${label(c)} has ${absolute.episodes} episodes listed, so there is no episode ${absolute_episode}. Say so with seasons.`,
            });
          }
          if (absolute.pick === 'unclear') {
            return ok({
              started: false,
              skipped_play: 'episode_unclear',
              title: candidateView(c, wall),
              absolute_episode,
              candidates: absolute.candidates.map((e) => ({ season: e.season, episode: e.episode, reading: e.reading, air_date: airDateOf(list, e.season, e.episode) })),
              next: `Nothing started: episode ${absolute_episode} can be read two ways. reading count is the ${absolute_episode}th episode in order, reading number the episode numbered ${absolute_episode} in its season. List the candidates as season and episode and ask which; then call again with that season and episode.`,
            });
          }
          const airDate = airDateOf(list, absolute.season, absolute.episode);
          if (airDate !== null && airDate > today) {
            return ok({
              started: false,
              skipped_play: 'not_aired',
              title: candidateView(c, wall),
              absolute_episode,
              season: absolute.season,
              episode: absolute.episode,
              air_date: airDate,
              next: 'Nothing started: that episode has not aired yet. Say which episode and its air date.',
            });
          }
          target = { kind: 'tv', tmdbId: c.tmdbId, season: absolute.season, episode: absolute.episode };
        }
        if (target === null) {
          if (episode !== undefined) {
            throw new LookupError('invalid_input', `${label(c)} is a series: pass the season with the episode, a season alone to start that season, or neither to carry on from the last episode watched.`);
          }
          if (season !== undefined) {
            const inSeason = await chooseInSeason(c, season, d);
            if (inSeason === null) {
              return ok({
                started: false,
                skipped_play: 'no_such_season',
                title: candidateView(c, wall),
                season,
                seasons: await seasonsOf(c, d),
                next: `Nothing started: ${label(c)} has no season ${season} listed. Say so with seasons.`,
              });
            }
            choice = inSeason;
          } else {
            choice = await chooseEpisode(c, d);
          }
          if (choice.pick === 'caught_up') {
            return ok({
              started: false,
              skipped_play: 'caught_up',
              title: candidateView(c, wall),
              last: choice.last,
              seasons: await seasonsOf(c, d),
              next: 'Nothing started: the last episode played is finished and no episode after it is left. Say so with last; to watch one again the owner names a season and an episode.',
            });
          }
          if (choice.pick === 'not_aired') {
            return ok({
              started: false,
              skipped_play: 'not_aired',
              title: candidateView(c, wall),
              season: choice.season,
              episode: choice.episode,
              air_date: choice.airDate,
              next: 'Nothing started: the next episode has not aired yet. Say which episode and its air date.',
            });
          }
          target = { kind: 'tv', tmdbId: c.tmdbId, season: choice.season, episode: choice.episode };
        }
        const picked = {
          ...(target.kind === 'tv' ? { season: target.season, episode: target.episode } : { season: null, episode: null }),
          ...(choice === null ? {} : { picked: choice.pick }),
          ...(absolute_episode === undefined ? {} : { picked: 'absolute', absolute_episode }),
          ...(remembered ? { remembered_as: asked_as } : {}),
        };
        // A title played by a key the library did not hold (a pick from direct_stream_discover) has no
        // name until the resolve stores it: read it again, so the answer names what plays.
        const stored = async (): Promise<TitleCandidate> => (c.movieId === null ? ((await d.library.byKey(c.kind, c.tmdbId)) ?? c) : c);
        // The owner's audio language for the title, stored before the play resolves so this play checks for it too.
        if (audioLanguage !== undefined && d.setAudioLanguage !== undefined && !(await d.setAudioLanguage(target, audioLanguage))) {
          throw new LookupError('invalid_input', `The audio language of ${label(c)} could not be stored (the title is not in the library and TMDB could not be asked); nothing started.`);
        }
        try {
          const play = magnet !== undefined ? await d.play(target, provider, magnet) : provider === undefined ? await d.play(target) : await d.play(target, provider);
          const pending = pendingPlay(play);
          if (pending !== null) {
            return ok({
              started: false,
              pending: true,
              title: candidateView(await stored(), wall),
              ...picked,
              ...pending,
              next:
                'Not started yet, and not failed: the daemon is still starting it and opens the player by itself as soon as a source plays. Tell the owner in one line that it is still being started and what is being tried (stage), with the attempts so far when there are any. ' +
                'Then call direct_stream_play again with exactly the same arguments: that joins the play in flight (it never starts a second one) and answers its outcome, or pending again. Do not try another source or another tool meanwhile.',
            });
          }
          const onSite = (play as { site?: unknown } | null)?.site;
          if (typeof onSite === 'string') {
            return ok({
              started: true,
              title: candidateView(await stored(), wall),
              ...picked,
              play,
              next:
                `It is playing on ${onSite}, full screen in the streaming Chrome window (F11 leaves full screen): play.site_url is its page there. No cloud provider and no torrent could stream it, so the streaming sites were asked as the last resort: play.attempts lists the direct attempts, then each "Site: " asked (the site it was last played on first, then the others in order). Say so in one line${target.kind === 'tv' ? ', with the season and episode' : ''}, naming the site.`,
            });
          }
          return ok({
            started: true,
            title: candidateView(await stored(), wall),
            ...picked,
            play,
            next:
              (absolute_episode !== undefined
                ? `Say which season and episode is playing and that it is episode ${absolute_episode} counted from the first, that it plays full screen in the streaming Chrome window, and that a double click, F, Esc or F11 leaves full screen.`
                : choice === null
                  ? 'Say it is playing full screen in the streaming Chrome window, and that a double click, F, Esc or F11 leaves full screen.'
                  : 'Say which season and episode is playing and why (picked: first, resume from where it stopped, or next), that it plays full screen in the streaming Chrome window, and that a double click, F, Esc or F11 leaves full screen.') +
              cacheNext(play),
          });
        } catch (err) {
          const failure = playFailure(err);
          if (failure === null) throw err;
          if (failure.error === 'no_source') {
            return failJson({
              error: 'no_source',
              started: false,
              title: candidateView(await stored(), wall),
              ...picked,
              attempts: failure.attempts,
              next:
                provider !== undefined && provider.trim().toLowerCase() === 'cloud'
                  ? 'No cloud provider could stream it, and nothing started; no torrent was tried, since cloud only was asked. Tell the owner, one short line per attempt with its outcome, and offer a torrent (provider "torrent": TM, TS), /idlix or /lk21.'
                  : provider === undefined && magnet === undefined && failure.attempts.some((x) => String((x as { provider?: unknown }).provider ?? '').startsWith('Site: '))
                    ? 'No provider, no torrent and no streaming site could stream it, and nothing started. Tell the owner, one short line per attempt with its outcome (an "Index: " attempt is a torrent index asked, a "Torrent: " attempt one torrent tried, a "Site: " attempt one streaming site asked as the last resort: no_stream when it does not list the title or the episode, skipped when it lists several titles of that name and none was guessed). "Torrents: not tried yet" says more torrents were found than one call tries, and that asking again tries those.'
                    : 'No provider and no torrent could stream it, and nothing started. Tell the owner, one short line per attempt with its outcome (an "Index: " attempt is a torrent index asked, a "Torrent: " attempt one torrent tried; "Torrents: not tried yet" says more torrents were found than one call tries, and that asking again tries those), and offer /idlix or /lk21.',
            });
          }
          if (failure.error === 'torrent_off') {
            return failJson({
              error: 'torrent_off',
              started: false,
              title: candidateView(await stored(), wall),
              ...picked,
              message: failure.message,
              next: 'Nothing started: torrents are off on this machine (NOTESD_TORRENT=off). Say so in one line and offer to stream it from a cloud provider (call again without provider).',
            });
          }
          return failJson({
            error: failure.error,
            reason: failure.reason,
            started: false,
            title: candidateView(await stored(), wall),
            ...picked,
            attempts: failure.attempts,
            message: failure.message,
            next: 'Nothing is playing. Say in one line why (reason: no_chrome means Chrome is not installed on Windows, chrome_not_reachable that the streaming Chrome did not answer), and offer /idlix or /lk21.',
          });
        }
      });
    },
  );

  server.registerTool(
    DISCOVER,
    {
      title: 'Find titles to stream by year, language, genre, keyword, person, studio or service',
      description: DISCOVER_DESCRIPTION,
      inputSchema: {
        kind: kindField.optional().describe('"movie" or "tv" (a series). Both when left out.'),
        year: yearField.optional().describe('Released (a film) or first aired (a series) in this year.'),
        year_from: yearField.optional().describe('Released or first aired in this year or later.'),
        year_to: yearField.optional().describe('Released or first aired in this year or earlier.'),
        language: z.string().trim().min(2).max(40).optional().describe('The original language, as an English name or a code: "Spanish", "Korean", "id". "Chinese" is Mandarin (zh) and Cantonese (cn) together.'),
        genre: namesField.optional().describe('One genre or several, by English name: "horror", "action", ["action", "comedy"]. Every one must fit. A series has no Horror, Thriller or Romance genre: pass those as keyword.'),
        keyword: namesField.optional().describe('What it is about, as one word or several: "mafia", ["gore", "revenge"]. A title carrying any one of them passes. Not with person.'),
        person: nameField.optional().describe('A person by name, e.g. "Johnny Depp". Not with company or service.'),
        person_id: tmdbIdField.optional().describe('A TMDB person id from other_people, to pick that person instead of the best match.'),
        role: z.enum(['any', 'cast', 'crew', 'director']).optional().describe('With person: "cast" (acted in), "director", "crew" (directed, wrote, produced, ...) or "any" (default).'),
        company: nameField.optional().describe('A production company or studio by name, e.g. "Blumhouse".'),
        company_id: tmdbIdField.optional().describe('A TMDB company id from filters.companies or other_companies, to search that one company only.'),
        service: nameField.optional().describe('A streaming service or network by name, e.g. "Shudder", "Netflix".'),
        service_id: tmdbIdField.optional().describe('A TMDB watch-provider id from other_services, to pick that service instead of the best match.'),
        region: z
          .string()
          .trim()
          .regex(/^[A-Za-z]{2}$/)
          .optional()
          .describe(`With service: the two-letter country whose catalogue is read. Default ${DISCOVER_DEFAULT_REGION}.`),
        sort: z.enum(['popular', 'newest']).optional().describe('"popular" (default) or "newest" (release date, newest first).'),
        unseen_only: z.boolean().optional().describe('true: leave out the titles the owner has seen or marked not interested. Pass it whenever you choose a title for the owner; leave it out for a rewatch and for a question about what there is.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(DISCOVER_MAX_LIMIT)
          .optional()
          .describe(`At most this many titles, 1-${DISCOVER_MAX_LIMIT}. Default ${DISCOVER_DEFAULT_LIMIT}.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const d = deps.directStream;
      if (!d) return off();
      return respond(async () => ok(await discoverTitles(args, d, wall)));
    },
  );

  registerDirectStreamSourceTools(server, deps);
}

interface DiscoverArgs {
  kind?: TitleKind | undefined;
  year?: number | undefined;
  year_from?: number | undefined;
  year_to?: number | undefined;
  language?: string | undefined;
  genre?: string | string[] | undefined;
  keyword?: string | string[] | undefined;
  person?: string | undefined;
  person_id?: number | undefined;
  role?: 'any' | 'cast' | 'crew' | 'director' | undefined;
  company?: string | undefined;
  company_id?: number | undefined;
  service?: string | undefined;
  service_id?: number | undefined;
  region?: string | undefined;
  sort?: 'popular' | 'newest' | undefined;
  unseen_only?: boolean | undefined;
  limit?: number | undefined;
}

/** One title before it is marked against the library. */
interface Discovered {
  kind: TitleKind;
  tmdbId: number;
  title: string;
  originalTitle: string | null;
  releaseDate: string | null;
  originalLanguage: string | null;
  overview: string | null;
  popularity: number;
  roles: string[] | null;
}

const listed = (value: string | string[] | undefined): string[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/**
 * The genres asked for as TMDB ids, per kind: a kind's own list is read ("action" is Action for a film and
 * Action & Adventure for a series). A kind that lacks one of them is left out when the other kind has them all;
 * when no kind asked for has them all, the answer says which genres that kind has.
 */
async function genresByKind(names: readonly string[], kinds: readonly TitleKind[], genres: (kind: TitleKind) => Promise<TmdbGenre[]>): Promise<Map<TitleKind, TmdbGenre[]>> {
  const out = new Map<TitleKind, TmdbGenre[]>();
  const missing: string[] = [];
  for (const kind of kinds) {
    const list = await genres(kind);
    const picked = names.map((name) => genreNamed(list, name));
    const lacks = names.filter((_, i) => picked[i] === null);
    if (lacks.length === 0) out.set(kind, [...new Map(picked.flatMap((g) => (g === null ? [] : [[g.id, g] as const]))).values()]);
    else missing.push(`TMDB has no ${kind === 'movie' ? 'film' : 'series'} genre called ${lacks.map((n) => `"${n}"`).join(' or ')} (it has ${list.map((g) => g.name).join(', ')})`);
  }
  if (out.size === 0) throw new LookupError('invalid_input', `${missing.join('; ')}. Pass what is not a genre there as keyword instead.`);
  return out;
}

const named = (hit: TmdbNamedHit) => ({ id: hit.id, name: hit.name, ...(hit.country === null ? {} : { country: hit.country }) });

/** The entry a name means among `ranked` (best first), or the one `id` picks; `others` is the rest, capped. */
function pickNamed(ranked: readonly TmdbNamedHit[], id: number | undefined, name: string | undefined): { picked: TmdbNamedHit | null; others: TmdbNamedHit[] } {
  const picked = id !== undefined ? (ranked.find((h) => h.id === id) ?? { id, name: name ?? String(id), country: null }) : (ranked[0] ?? null);
  return { picked, others: ranked.filter((h) => h.id !== picked?.id).slice(0, DISCOVER_MAX_OTHERS) };
}

/** direct_stream_discover: TMDB titles by filter, each marked against the library and this host's verified sources. Starts nothing. */
async function discoverTitles(args: DiscoverArgs, d: DirectStreamToolDeps, wall: string) {
  const tmdb = d.tmdb;
  if (tmdb === null) {
    throw new LookupError('tmdb_unavailable', 'this server has no TMDB credentials (TMDB_API_READ_ACCESS_TOKEN or TMDB_API_KEY), so titles cannot be discovered. Name a title instead, or use web search.');
  }
  const byPerson = args.person !== undefined || args.person_id !== undefined;
  const byCompany = args.company !== undefined || args.company_id !== undefined;
  const byService = args.service !== undefined || args.service_id !== undefined;
  if (byPerson && (byCompany || byService)) {
    throw new LookupError('invalid_input', 'person cannot be combined with company or service: TMDB lists a person\'s titles without them. Ask for the person alone, or for the company or service alone.');
  }
  if (args.role !== undefined && !byPerson) throw new LookupError('invalid_input', 'role belongs to person: pass person too.');
  const genreNames = listed(args.genre);
  const keywordNames = listed(args.keyword);
  if (byPerson && keywordNames.length > 0) {
    throw new LookupError('invalid_input', 'keyword cannot be combined with person: TMDB lists a person\'s titles without their keywords. Ask for the person (with genre, if any) and choose from the list.');
  }
  if ((args.year_from ?? args.year ?? 0) > (args.year_to ?? args.year ?? 9999)) throw new LookupError('invalid_input', 'year_from is after year_to.');
  let languages: string[] | null = null;
  if (args.language !== undefined) {
    languages = languageCodes(args.language);
    if (languages === null) throw new LookupError('invalid_input', `"${args.language}" is not a language name or code this tool knows. Pass the English name ("Spanish") or the two-letter code ("es").`);
  }
  // One code as it always was; "Chinese" is both of TMDB's.
  const language = languages === null ? null : languages.length === 1 ? (languages[0] ?? null) : languages;
  let kinds: TitleKind[] = args.kind === undefined ? ['movie', 'tv'] : [args.kind];
  const today = (d.now?.() ?? new Date()).toISOString().slice(0, 10);
  const window = releaseWindow(args.year, args.year_from, args.year_to, today);
  const sort = args.sort ?? 'popular';
  const limit = args.limit ?? DISCOVER_DEFAULT_LIMIT;
  const filters: Record<string, unknown> = { kind: args.kind ?? 'any', released_from: window.from, released_to: window.to, language, sort };
  const others: Record<string, unknown> = {};
  let found: Discovered[];
  let genreIds: Map<TitleKind, TmdbGenre[]> | null = null;
  if (genreNames.length > 0) {
    if (tmdb.genres === undefined) throw new LookupError('tmdb_unavailable', 'this server\'s TMDB client cannot list genres.');
    genreIds = await genresByKind(genreNames, kinds, tmdb.genres.bind(tmdb));
    // A kind without the genre lists nothing of it.
    kinds = kinds.filter((kind) => genreIds?.has(kind));
    filters.genres = Object.fromEntries([...genreIds].map(([kind, list]) => [kind, list.map((g) => ({ id: g.id, name: g.name }))]));
  }
  const hasGenres = (kind: TitleKind, ids: readonly number[]): boolean => (genreIds?.get(kind) ?? []).every((g) => ids.includes(g.id));

  if (byPerson) {
    let people = args.person === undefined ? [] : await tmdb.searchPerson(args.person);
    // Nobody by that name: a shorter search, kept only for a name a letter or two away (a misspelling).
    let respelled = false;
    if (people.length === 0 && args.person !== undefined && args.person_id === undefined) {
      for (const shorter of looserNames(args.person)) {
        const near = nearlyNamed(await tmdb.searchPerson(shorter), args.person);
        if (near.length === 0) continue;
        people = near;
        respelled = true;
        break;
      }
    }
    const person =
      args.person_id !== undefined
        ? (people.find((p) => p.personId === args.person_id) ?? { personId: args.person_id, name: args.person ?? String(args.person_id), knownFor: null })
        : people[0];
    if (person === undefined) throw new LookupError('not_found', `TMDB knows no person named "${args.person}", nor one a letter or two away. Check the spelling (your own knowledge, or a web search) and call again with the right name.`);
    const role = args.role ?? 'any';
    filters.person = { id: person.personId, name: person.name, known_for: person.knownFor, ...(respelled ? { asked_as: args.person } : {}) };
    filters.role = role;
    others.other_people = people
      .filter((p) => p.personId !== person.personId)
      .slice(0, DISCOVER_MAX_OTHERS)
      .map((p) => ({ id: p.personId, name: p.name, known_for: p.knownFor }));
    found = mergeCredits(await tmdb.personCredits(person.personId))
      .filter((c) => kinds.includes(c.kind))
      .filter((c) => role === 'any' || (role === 'cast' ? c.cast : role === 'director' ? c.director : c.crew))
      .filter((c) => inWindow(c.releaseDate, window))
      .filter((c) => languages === null || (c.originalLanguage !== null && languages.includes(c.originalLanguage)))
      .filter((c) => hasGenres(c.kind, c.genreIds))
      .map((c) => ({
        kind: c.kind,
        tmdbId: c.tmdbId,
        title: c.title,
        originalTitle: null,
        releaseDate: c.releaseDate,
        originalLanguage: c.originalLanguage,
        overview: null,
        popularity: c.popularity,
        roles: c.roles,
      }));
  } else {
    const { discover, searchCompany, watchProviders } = tmdb;
    if (discover === undefined || searchCompany === undefined || watchProviders === undefined) {
      throw new LookupError('tmdb_unavailable', 'this server\'s TMDB client cannot discover titles.');
    }
    let companyIds: number[] | null = null;
    if (byCompany) {
      const hits = args.company === undefined ? [] : await searchCompany.call(tmdb, args.company);
      // A name stands for every company that starts with it; company_id picks exactly one.
      const { picked, others: rest } =
        args.company_id !== undefined
          ? { picked: [hits.find((h) => h.id === args.company_id) ?? { id: args.company_id, name: args.company ?? String(args.company_id), country: null }], others: hits.filter((h) => h.id !== args.company_id) }
          : companiesNamed(hits, args.company ?? '');
      if (picked.length === 0) throw new LookupError('not_found', `TMDB knows no production company called "${args.company}". A streaming service or network goes in service.`);
      companyIds = picked.map((c) => c.id);
      filters.companies = picked.map(named);
      others.other_companies = rest.slice(0, DISCOVER_MAX_OTHERS).map(named);
    }
    let providerId: number | null = null;
    const region = (args.region ?? DISCOVER_DEFAULT_REGION).toUpperCase();
    if (byService) {
      const lists = await Promise.all(kinds.map((kind) => watchProviders.call(tmdb, kind, region)));
      const all = [...new Map(lists.flat().map((p) => [p.id, p])).values()];
      const ranked = args.service === undefined ? all.filter((p) => p.id === args.service_id) : rankByName(all, args.service);
      const { picked, others: rest } = pickNamed(ranked, args.service_id, args.service);
      if (picked === null) {
        throw new LookupError(
          'not_found',
          `TMDB lists no streaming service called "${args.service}" in ${region}${all.length === 0 ? '' : ` (it lists ${all.slice(0, 12).map((p) => p.name).join(', ')}, ...)`}. A TV network that is not a streaming service is usually a production company too: try company.`,
        );
      }
      providerId = picked.id;
      filters.service = named(picked);
      filters.region = region;
      others.other_services = rest.map(named);
    }
    let keywordIds: number[] | null = null;
    if (keywordNames.length > 0) {
      const { searchKeyword } = tmdb;
      if (searchKeyword === undefined) throw new LookupError('tmdb_unavailable', 'this server\'s TMDB client cannot search keywords.');
      const picked = (await Promise.all(keywordNames.map(async (name) => keywordsNamed(await searchKeyword.call(tmdb, name), name)))).flat();
      const keywords = [...new Map(picked.map((k) => [k.id, k])).values()];
      keywordIds = keywords.map((k) => k.id);
      filters.keywords = keywords.map((k) => ({ id: k.id, name: k.name }));
    }
    const page = (withKeywords: boolean) =>
      Promise.all(
        kinds.map((kind) =>
          discover.call(tmdb, kind, {
            dateFrom: window.from,
            dateTo: window.to,
            originalLanguage: languages === null ? null : languages.join('|'),
            genreIds: genreIds === null ? null : (genreIds.get(kind) ?? []).map((g) => g.id),
            keywordIds: withKeywords ? keywordIds : null,
            companyIds,
            providerId,
            watchRegion: region,
            sort,
          }),
        ),
      );
    let pages = keywordIds === null || keywordIds.length > 0 ? await page(true) : [];
    // TMDB tags few titles with keywords: when none carries one, the list is the other filters alone, and says so.
    if (keywordIds !== null && pages.flat().length === 0) {
      pages = await page(false);
      filters.keywords_dropped = true;
    }
    found = pages.flat().map((h) => ({
      kind: h.kind,
      tmdbId: h.tmdbId,
      title: h.title,
      originalTitle: h.originalTitle,
      releaseDate: h.releaseDate,
      originalLanguage: h.originalLanguage ?? null,
      overview: h.overview,
      popularity: h.popularity,
      roles: null,
    }));
  }

  found.sort((a, b) =>
    sort === 'newest'
      ? (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '') || b.popularity - a.popularity
      : b.popularity - a.popularity || (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''),
  );
  const [marks, fresh] = await Promise.all([d.marks(found.map((t) => titleId(t.kind, t.tmdbId))), d.freshTitles()]);
  const titleUrl = (id: string): string => `${wall}/movies/${encodeURIComponent(id)}`;
  const all = found.map((t) => {
    const { kind, tmdb_id, title_id, movie_id, url, tmdb_url, ...library } = markedTitle(t.kind, t.tmdbId, marks, titleUrl);
    return {
      kind,
      tmdb_id,
      title_key: title_id,
      movie_id,
      title: t.title,
      ...(t.originalTitle !== null && t.originalTitle !== t.title ? { original_title: t.originalTitle } : {}),
      release_date: t.releaseDate,
      original_language: t.originalLanguage,
      ...(t.overview === null || t.overview.trim() === '' ? {} : { overview: shortOverview(t.overview) }),
      ...(t.roles === null ? {} : { roles: t.roles }),
      ...library,
      not_interested: marks.get(title_id)?.notInterested ?? false,
      interested: marks.get(title_id)?.interested ?? false,
      stream: { verified: fresh.has(title_id) },
      url,
      tmdb_url,
    };
  });
  const unseenOnly = args.unseen_only ?? false;
  // What the owner has seen or does not want: left out of a list the caller chooses from, counted either way.
  const known = { seen: all.filter((t) => t.seen).length, not_interested: all.filter((t) => t.not_interested && !t.seen).length };
  const knownCount = known.seen + known.not_interested;
  const kept = all.filter((t) => !unseenOnly || (!t.seen && !t.not_interested));
  const titles = kept.slice(0, limit);
  return {
    filters,
    ...others,
    count: titles.length,
    ...(kept.length > titles.length ? { more: kept.length - titles.length } : {}),
    ...(unseenOnly && knownCount > 0 ? { left_out: known } : {}),
    titles,
    next:
      titles.length === 0 && unseenOnly && knownCount > 0
        ? `Nothing was started. Every title that fits (${knownCount}) is one the owner has seen or marked not interested, so there is none to choose. Say so and start nothing; when they want to watch one again, a rewatch is this call without unseen_only, or direct_stream_play with the title they name.`
        : titles.length === 0
        ? 'No title passes these filters (titles not released yet are left out). Say so; try fewer filters, another year, or one of the other_ entries.'
        : filters.keywords_dropped === true
          ? 'Nothing was started. No title carries the keyword with these filters (TMDB tags few titles), so this list is NOT filtered by it: choose from it by overview and by what you know of the titles (check with a web search when unsure), say that you did, and play your choice with direct_stream_play and its title_key. If nothing listed fits what the owner described, find a title that does yourself and play it by name and year.'
          : 'Nothing was started. To stream one, call direct_stream_play with its title_key as title. If the owner asked you to choose ("pick one for me", "play one"), choose one they have not seen and did not mark not_interested, play it, and say which one and why. If they only asked what there is, list the titles with their years and start nothing.' +
            (unseenOnly
              ? knownCount > 0
                ? ` ${knownCount} title(s) the owner has seen or marked not interested were left out (left_out).`
                : ''
              : knownCount > 0
                ? ` This list still holds ${knownCount} title(s) the owner has seen or marked not interested (seen, not_interested): when you are choosing for them and they did not ask to rewatch, call again with unseen_only true and choose from that list.`
                : ''),
  };
}
