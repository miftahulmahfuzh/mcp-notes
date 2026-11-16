import type { CacheSubtitleView } from '../../cachePlay.js';
import type { ResolveAttempt, StreamRef } from '../../types.js';
import type { MediaProbe } from '../probe.js';
import type { TorrentStreams } from '../service.js';
import type { TorrentFileInfo, TorrentHandle } from '../types.js';

/**
 * Where a torrent session's English subtitle comes from (torrent phase 3 ships the chain; phase 6 adds kept, files,
 * service and borrow, phase 7 the embedded track, phase 8 Whisper). The chain stops at the first tier that answers
 * anything: every tier answers only English tracks, or the torrent's one subtitle file that names no language, which
 * the page shows by default.
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
   * false: a growing tier that answers its track at once and fills it in the background (embedded, whisper).
   */
  readonly blocks: boolean;
  /** Why this tier is not asked for this play, or null; the chain records a `skipped` attempt with that reason. */
  skip?(ctx: SubtitleContext): string | null;
  /** The tier's tracks (WebVTT or cue-feed addresses on this daemon); [] for "none here". Throws for "this source failed". */
  find(ctx: SubtitleContext): Promise<CacheSubtitleView[]>;
}

export interface SubtitleChainResult {
  subtitles: CacheSubtitleView[];
  /** One `Subtitles: <tier>` attempt per tier reached: `resolved`, `no_stream`, `error` or `skipped`. */
  attempts: ResolveAttempt[];
}

/** What src/daemon.ts hands buildSubtitleTiers. Phases 6 to 8 add the fields their tiers need. */
export interface SubtitleTierDeps {
  /** config.torrent.dir: a torrent's sidecar folders live under `<dir>/<info hash>/` and go with it on prune. */
  torrentDir: string;
  /** Phase 1's TorrentStreams (AppDeps.torrents). */
  torrents: TorrentStreams;
  log: (line: string) => void;
  // Phase 6: subtitleUrl, fetch, lend, convertAss. Phase 7: embedded. Phase 8: whisper.
}

/** The daemon's subtitle tiers, in order. Phase 3: none. Each later phase inserts its tiers at its comment. */
export function buildSubtitleTiers(_deps: SubtitleTierDeps): SubtitleTier[] {
  return [
    // Phase 6: kept, files.
    // Phase 7: embedded.
    // Phase 6: service, borrow.
    // Phase 8: whisper.
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

/**
 * Asks the tiers in order and stops at the first that answers anything. A tier with a `skip` reason, or a blocking
 * tier that would start after the shared budget is spent, is a `skipped` attempt; a blocking tier still running when
 * the budget runs out, or one that throws, is an `error` attempt and the next is asked. Never throws.
 */
export async function runSubtitleChain(
  tiers: readonly SubtitleTier[],
  ctx: Omit<SubtitleContext, 'deadline'>,
  options: { log?: (line: string) => void; budgetMs?: number; now?: () => number } = {},
): Promise<SubtitleChainResult> {
  const now = options.now ?? (() => Date.now());
  const budgetMs = options.budgetMs ?? SUBTITLE_BUDGET_MS;
  const full: SubtitleContext = { ...ctx, deadline: now() + budgetMs };
  const attempts: ResolveAttempt[] = [];
  for (const tier of tiers) {
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
    try {
      const found = tier.blocks ? await within(tier.find(full), left, budgetMs) : await tier.find(full);
      const tookS = seconds(now() - started);
      if (found.length > 0) {
        attempts.push({ provider, outcome: 'resolved', took_s: tookS, detail: found.map((t) => t.label || 'a subtitle that names no language').join(', ') });
        return { subtitles: found, attempts };
      }
      attempts.push({ provider, outcome: 'no_stream', took_s: tookS, detail: 'no English subtitle here' });
    } catch (err) {
      options.log?.(`[notesd] torrent: the ${tier.name} subtitle tier failed for ${ctx.infoHash}: ${messageOf(err)}`);
      attempts.push({ provider, outcome: 'error', took_s: seconds(now() - started), detail: messageOf(err) });
    }
  }
  return { subtitles: [], attempts };
}
