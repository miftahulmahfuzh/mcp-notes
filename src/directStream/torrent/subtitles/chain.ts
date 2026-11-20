import type { CacheSubtitleView } from '../../cachePlay.js';
import type { ResolveAttempt, StreamRef } from '../../types.js';
import type { FetchLike } from '../../passThrough.js';
import type { MediaProbe } from '../probe.js';
import type { TorrentStreams } from '../service.js';
import type { TorrentFileInfo, TorrentHandle } from '../types.js';
import { borrowTier, type SubtitleLender } from './borrow.js';
import { SubtitleShelf, keptTier, rankOf } from './disk.js';
import { embeddedTier, type EmbeddedSubtitles } from './embedded.js';
import { ffmpegAssConverter, filesTier, type AssConverter } from './files.js';
import { serviceTier } from './service.js';
import type { WhisperTier } from './whisper.js';

/**
 * Where a torrent session's English subtitle comes from (torrent phase 3 ships the chain; phase 6 adds kept, files,
 * service and borrow, phase 7 the embedded track, phase 8 Whisper). Every tier answers only English tracks, or the
 * torrent's one subtitle file that names no language, which the page shows by default.
 *
 * The tiers are asked in order and the first answer is the session's subtitle, with two exceptions that keep the
 * release's own subtitle (a file of the torrent, the track inside its video: in step by construction) ahead of
 * anything from outside it:
 *
 * - **A tier asked aside** (`aside`, the files tier): its file may take long to download, so the tiers after it are
 *   asked side by side with it. When it answers before the chain ends, its answer is the chain's; when it answers
 *   later, `later` hands it over and it takes the place of what the session shows.
 * - **A kept choice from outside the release** (`provisional`: a service's file, a borrowed one, a re-timed one) is
 *   shown at once, but the release tiers are still asked, and theirs wins.
 *
 * A kept choice /sync-subtitle made (`checked-*`) or a kept file of the release ends the chain as before.
 */

/** The tiers that hold up a play (`blocks: true`) share this budget, counted from the moment the chain starts. */
export const SUBTITLE_BUDGET_MS = 40_000;

/** What every subtitle tier knows about the play. TorrentSource builds it once per play; one name per fact. */
export interface SubtitleContext {
  ref: StreamRef;
  /** The title's IMDb id (`tt1727587`); null on a replay from disk. */
  imdbId: string | null;
  infoHash: string;
  /** The release name (the candidate's `name`; on a replay the download's recorded release, else the torrent's name). */
  release: string;
  /** Every file of the torrent; [] on a replay from disk (no swarm was joined). */
  files: readonly TorrentFileInfo[];
  /** The chosen video file's index in the torrent. */
  fileIndex: number;
  /** The subtitle files pickFile chose beside the video (downloaded with it); [] on a replay. */
  subtitleIndexes: readonly number[];
  /** The open torrent, to read bytes of its files (`end` inclusive); null on a replay from disk. */
  handle: Pick<TorrentHandle, 'read'> | null;
  /** The chosen file as ffprobe read it: its length, audio streams and subtitle streams. */
  probe: MediaProbe;
  /** The title's original language (TMDB's two-letter code), or null. */
  audioLang: string | null;
  /** Where the play starts, in seconds; null: from the start. */
  resumeS: number | null;
  /** The play asked the cloud providers first and none could stream the title (the fall-through after `no_source`). */
  cloudTried: boolean;
  /** This daemon's origin as ffmpeg reaches it (`http://127.0.0.1:<port>`); the file route is `localBase` + `localUrl`. */
  localBase: string;
  /** Aborted when the session lets go of the torrent (page closed, film ended, shuffle, idle, session end). A growing tier stops its work. */
  signal: AbortSignal;
  /** When the blocking tiers' shared budget runs out (ms since the epoch). Set by runSubtitleChain; a blocking tier caps its own waits at it. */
  deadline: number;
}

export interface SubtitleTier {
  readonly name: string;
  /**
   * true: the play waits for this tier's answer, within the shared SUBTITLE_BUDGET_MS (kept, files, service, borrow).
   * false: a growing tier that answers its track at once and fills it in the background (embedded, whisper), or one
   * asked aside, which bounds its own wait (files).
   */
  readonly blocks: boolean;
  /** Its subtitle is the release's own (files, embedded): still asked after a kept choice from outside the release. */
  readonly release?: boolean;
  /** Asked side by side with the tiers after it, which it outranks: its answer wins whenever it arrives (files). */
  readonly aside?: boolean;
  /** True when this answer may still give way to a release tier's (the kept tier, for a choice from outside the release). */
  provisional?(found: readonly CacheSubtitleView[]): boolean;
  /** Why this tier is not asked for this play, or null; the chain records a `skipped` attempt with that reason. */
  skip?(ctx: SubtitleContext): string | null;
  /** The tier's tracks (WebVTT or cue-feed addresses on this daemon); [] for "none here". Throws for "this source failed". */
  find(ctx: SubtitleContext): Promise<CacheSubtitleView[]>;
}

/** What the tiers asked aside answered after the chain had ended. */
export interface SubtitleChainLate {
  /** The subtitle that takes the place of the chain's (it ranks higher: subtitleRank); [] when none arrived. */
  subtitles: CacheSubtitleView[];
  /** One attempt per tier that was still being asked. */
  attempts: ResolveAttempt[];
}

export interface SubtitleChainResult {
  subtitles: CacheSubtitleView[];
  /** One `Subtitles: <tier>` attempt per tier reached: `resolved`, `no_stream`, `error` or `skipped`. */
  attempts: ResolveAttempt[];
  /** Answers once every tier asked aside has ended; null when none was still being asked. Never rejects. */
  later: Promise<SubtitleChainLate> | null;
}

/** What src/daemon.ts hands buildSubtitleTiers. Phases 6 to 8 add the fields their tiers need. */
export interface SubtitleTierDeps {
  /** config.torrent.dir: a torrent's sidecar folders live under `<dir>/<info hash>/` and go with it on prune. */
  torrentDir: string;
  /** Phase 1's TorrentStreams (AppDeps.torrents). */
  torrents: TorrentStreams;
  log: (line: string) => void;
  /** config.torrent.subtitleUrl; null leaves the OpenSubtitles add-on out of the service tier (phase 6). */
  subtitleUrl: string | null;
  /** Wyzie Subs' address and key (config.torrent.wyzieUrl, wyzieKey); null or unset: Wyzie is never asked (phase 6 addendum). */
  wyzie?: { baseUrl: string; key: string } | null;
  fetch: FetchLike;
  /** DirectStreamService.subtitleText, read at play time; null without direct streaming (phase 6). */
  lend: () => SubtitleLender | null;
  /** ASS/SSA to WebVTT (phase 6); src/daemon.ts passes ffmpegAssConverter(config.torrent.ffmpegBin). */
  convertAss?: AssConverter;
  /** The extraction of a file's English text track into a growing cue feed (phase 7); null with torrents off. */
  embedded?: EmbeddedSubtitles | null;
  /** Whisper, the last tier (phase 8); null when off or not installed. */
  whisper?: WhisperTier | null;
}

/** The daemon's subtitle tiers, in order. Each later phase inserts its tiers at its comment. */
export function buildSubtitleTiers(deps: SubtitleTierDeps): SubtitleTier[] {
  const shelf = new SubtitleShelf(deps.torrentDir);
  const wyzie = deps.wyzie ?? null;
  return [
    // Phase 6: kept, files.
    keptTier(shelf),
    filesTier({
      torrents: {
        filePath: (infoHash, index) => deps.torrents.filePath(infoHash, index),
        // A replay from disk joins no swarm and has no file list: the download's own record names its chosen files.
        chosenFiles: async (infoHash) => {
          const view = await deps.torrents.view(infoHash);
          if (view === null || !view.available) return null;
          return { video: view.file_index, files: view.files.map((f) => ({ index: f.index, path: f.path, name: f.path.split(/[\\/]/).pop() ?? f.path, length: f.length })) };
        },
      },
      shelf,
      convertAss: deps.convertAss ?? ffmpegAssConverter(),
    }),
    // Phase 7: embedded.
    ...(deps.embedded == null ? [] : [embeddedTier(deps.embedded)]),
    // Phase 6: service, borrow. The service tier is left out when neither service may be asked.
    ...(deps.subtitleUrl === null && wyzie === null ? [] : [serviceTier({ baseUrl: deps.subtitleUrl, wyzie, fetch: deps.fetch, torrents: deps.torrents, shelf, log: deps.log })]),
    borrowTier({ lend: deps.lend, shelf, whisperCovers: deps.whisper != null }),
    // Phase 8: whisper.
    ...(deps.whisper == null ? [] : [deps.whisper]),
  ];
}

const seconds = (ms: number): number => Math.round(ms / 100) / 10;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function within<T>(work: Promise<T>, ms: number, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`gave up: the ${budgetMs / 1000} s subtitle budget ran out`)), Math.max(0, ms));
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** A tier asked aside gets this long to answer before the tiers after it are asked: a file already on disk is read in it. */
export const ASIDE_HEAD_MS = 250;

interface Asked {
  found: CacheSubtitleView[];
  attempt: ResolveAttempt;
}

/**
 * Asks the tiers in order and stops at the first that answers anything; a tier asked aside and a provisional answer
 * are the two exceptions (see the top of this file). A tier with a `skip` reason, or a blocking tier that would start
 * after the shared budget is spent, is a `skipped` attempt; a blocking tier still running when the budget runs out,
 * or one that throws, is an `error` attempt and the next is asked. Never throws.
 */
export async function runSubtitleChain(
  tiers: readonly SubtitleTier[],
  ctx: Omit<SubtitleContext, 'deadline'>,
  options: { log?: (line: string) => void; budgetMs?: number; now?: () => number; asideHeadMs?: number } = {},
): Promise<SubtitleChainResult> {
  const now = options.now ?? (() => Date.now());
  const budgetMs = options.budgetMs ?? SUBTITLE_BUDGET_MS;
  const full: SubtitleContext = { ...ctx, deadline: now() + budgetMs };
  const attempts: ResolveAttempt[] = [];
  /** The tiers asked aside that have not answered yet. */
  const open = new Map<SubtitleTier, { started: number; done: Promise<Asked> }>();
  /** Those that answered and are not in `attempts` yet. */
  const answered: Asked[] = [];
  /** A kept choice from outside the release: the chain's answer unless a release tier has one. */
  let held: CacheSubtitleView[] | null = null;
  /** The best a tier asked aside found so far (it is in `attempts`). */
  let asideFound: CacheSubtitleView[] = [];
  /** What the tiers asked aside said goes into `attempts` ahead of the next tier's attempt, in the order they answered. */
  const flush = (): void => {
    for (const got of answered.splice(0)) {
      attempts.push(got.attempt);
      if (rankOf(got.found) > rankOf(asideFound)) asideFound = got.found;
    }
  };

  const ask = (tier: SubtitleTier, started: number, work: () => Promise<CacheSubtitleView[]>): Promise<Asked> => {
    const provider = `Subtitles: ${tier.name}`;
    return Promise.resolve()
      .then(work)
      .then(
        (found): Asked => ({
          found,
          attempt:
            found.length > 0
              ? { provider, outcome: 'resolved', took_s: seconds(now() - started), detail: found.map((t) => t.label || 'a subtitle that names no language').join(', ') }
              : { provider, outcome: 'no_stream', took_s: seconds(now() - started), detail: 'no English subtitle here' },
        }),
        (err: unknown): Asked => {
          options.log?.(`[notesd] torrent: the ${tier.name} subtitle tier failed for ${ctx.infoHash}: ${messageOf(err)}`);
          return { found: [], attempt: { provider, outcome: 'error', took_s: seconds(now() - started), detail: messageOf(err) } };
        },
      );
  };
  /** Resolves with the first tier asked aside that finds a subtitle; never when none does. */
  const asideWins = (): Promise<{ aside: Asked }> =>
    new Promise((resolve) => {
      for (const { done } of open.values()) void done.then((got) => (got.found.length > 0 ? resolve({ aside: got }) : undefined));
    });
  /** The chain's answer: what the tiers asked aside said so far goes into it, what they say after it into `later`. */
  const end = (subtitles: CacheSubtitleView[]): SubtitleChainResult => {
    flush();
    const best = rankOf(asideFound) > rankOf(subtitles) ? asideFound : subtitles;
    if (open.size === 0) return { subtitles: best, attempts, later: null };
    const waiting = [...open.entries()];
    for (const [tier, { started }] of waiting) {
      attempts.push({ provider: `Subtitles: ${tier.name}`, outcome: 'skipped', took_s: seconds(now() - started), detail: 'not here yet; when it arrives it takes the place of the subtitle shown' });
    }
    const later = Promise.all(waiting.map(([, { done }]) => done)).then((all): SubtitleChainLate => {
      const better = all.map((got) => got.found).find((found) => rankOf(found) > rankOf(best));
      return { subtitles: better ?? [], attempts: all.map((got) => got.attempt) };
    });
    return { subtitles: best, attempts, later };
  };

  for (const tier of tiers) {
    // A kept choice from outside the release stands: only the release itself is still asked.
    if (held !== null && tier.release !== true) continue;
    flush();
    const provider = `Subtitles: ${tier.name}`;
    const why = tier.skip?.(full) ?? null;
    if (why !== null) {
      attempts.push({ provider, outcome: 'skipped', took_s: 0, detail: why });
      continue;
    }
    const left = full.deadline - now();
    if (tier.blocks && left <= 0) {
      attempts.push({ provider, outcome: 'skipped', took_s: 0, detail: `the ${budgetMs / 1000} s subtitle budget was spent` });
      continue;
    }
    const started = now();
    if (tier.aside === true) {
      const done = ask(tier, started, () => tier.find(full)).then((got) => {
        if (open.delete(tier)) answered.push(got);
        return got;
      });
      open.set(tier, { started, done });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const head = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(0, options.asideHeadMs ?? ASIDE_HEAD_MS));
      });
      const quick = await Promise.race([done, head]).finally(() => clearTimeout(timer));
      // Its answer outranks every tier after it: none of them is asked.
      if (quick !== null && quick.found.length > 0) return end(quick.found);
      continue;
    }
    const work = ask(tier, started, () => (tier.blocks ? within(tier.find(full), left, budgetMs) : tier.find(full)));
    const first = open.size === 0 ? await work : await Promise.race([work, asideWins()]);
    flush();
    if ('aside' in first) {
      // The tier goes on by itself; what it finds is not shown, and a file it keeps does not outrank the release's (disk.ts).
      attempts.push({ provider, outcome: 'skipped', took_s: seconds(now() - started), detail: "the release's own subtitle arrived first" });
      return end(first.aside.found);
    }
    attempts.push(first.attempt);
    if (first.found.length === 0) continue;
    if (tier.provisional?.(first.found) === true) {
      held = first.found;
      continue;
    }
    return end(first.found);
  }
  return end(held ?? []);
}
