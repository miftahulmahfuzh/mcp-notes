import type { CacheSubtitleView } from '../../cachePlay.js';
import { joinVtt } from '../../cache/subtitle.js';
import type { StreamRef } from '../../types.js';
import type { SubtitleTier } from './chain.js';
import { vttFromText, type SubtitleShelf } from './disk.js';

/**
 * The last file tier (TORRENT_STREAM_SOURCE phase 6, R3.3): a cloud provider's English subtitle for
 * the same title, read out of sight through DirectStreamService.subtitleText. It may be out of step
 * with the torrent's cut; the player's G and H keys move it. Kept as `borrow.vtt`, labelled with
 * the provider it came from.
 */

/** The resolver's `--deadline-s` for a borrow. */
export const BORROW_DEADLINE_S = 45;
/** Time to read the subtitle file after the resolver's deadline. */
export const BORROW_GRACE_MS = 40_000;

export interface BorrowedSubtitle {
  provider: string;
  label: string;
  vtt: string;
}

/** DirectStreamService.subtitleText as the tier calls it. Throws `no_source`, `resolve_failed`, `no_subtitle`. */
export type SubtitleLender = (ref: StreamRef, options: { deadlineS: number }) => Promise<BorrowedSubtitle>;

export interface BorrowTierDeps {
  /** Read at play time: the service is built after the tiers. Null: no direct streaming. */
  lend: () => SubtitleLender | null;
  shelf: SubtitleShelf;
  deadlineS?: number;
  graceMs?: number;
  /**
   * Phase 8 sets it when the Whisper tier is on: then a title whose original language is English skips the borrow
   * (Whisper measured 5 minutes of audio in 2.5 s, and a borrowed file may be out of step with the torrent's cut).
   */
  whisperCovers?: boolean;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no subtitle within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export function borrowTier(deps: BorrowTierDeps): SubtitleTier {
  return {
    name: 'borrow',
    blocks: true,
    skip: (ctx) =>
      deps.whisperCovers === true && ctx.audioLang === 'en' ? 'Whisper transcribes English audio, and a borrowed subtitle may be out of step with the torrent' : null,
    async find(ctx): Promise<CacheSubtitleView[]> {
      if (ctx.cloudTried) return [];
      const lend = deps.lend();
      if (lend === null) return [];
      // Within the chain's shared budget (ctx.deadline): the resolver's deadline and the read after it both fit in it.
      const leftMs = Math.max(0, ctx.deadline - Date.now());
      const deadlineS = Math.max(1, Math.min(deps.deadlineS ?? BORROW_DEADLINE_S, Math.floor(leftMs / 1000) - 5));
      const got = await withTimeout(lend(ctx.ref, { deadlineS }), Math.min(deadlineS * 1000 + (deps.graceMs ?? BORROW_GRACE_MS), leftMs));
      // An HLS subtitle track arrives as its segments joined, each with its own WEBVTT header: one header is kept.
      const vtt = vttFromText(joinVtt(got.vtt.split(/\n+(?=WEBVTT)/)));
      if (vtt === null) throw new Error(`${got.provider}'s English subtitle holds no cue`);
      return [await deps.shelf.save(ctx.infoHash, 'borrow.vtt', vtt, { lang: 'en', label: `English (${got.provider})` })];
    },
  };
}
