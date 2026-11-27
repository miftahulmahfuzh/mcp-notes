import type { ResolveAttempt } from '../../types.js';
import type { SessionTorrent } from '../../sessions.js';
import { runSubtitleChain, type SubtitleContext } from '../subtitles/chain.js';
import { rankOf } from '../subtitles/disk.js';
import type { TorrentSyncRequest } from '../subtitles/synced.js';
import { SUBTITLE_HEAD_MS, SUBTITLES_PENDING } from './constants.js';
import { seconds, sleep } from './text.js';
import type { TorrentSourceOptions } from './types.js';

type SyncAsk = Omit<TorrentSyncRequest, 'signal' | 'target'>;

/**
 * A torrent session's subtitles: the subtitle chain (subtitles/chain.ts), which may hold the play's answer for
 * SUBTITLE_HEAD_MS and then goes on behind it, and Wyzie Synced (subtitles/synced.ts) once the chain ended. A subtitle
 * put on the session meanwhile (/sync-subtitle's checked file) is never replaced by one that ranks lower.
 */
export class SubtitleStarter {
  /** What a session's sync was asked with, to start it again when the session takes its torrent back (a reload of the page). */
  private readonly syncs = new WeakMap<SessionTorrent, SyncAsk>();

  constructor(
    private readonly opts: Pick<TorrentSourceOptions, 'tiers' | 'sync' | 'subtitleHeadMs'>,
    private readonly now: () => number,
    private readonly log: (line: string) => void,
  ) {}

  /** Wyzie Synced for the session's subtitle, behind the play: it starts only for a subtitle from outside the torrent (synced.ts). */
  startSync(torrent: SessionTorrent, request: SyncAsk): void {
    if (this.opts.sync == null) return;
    this.syncs.set(torrent, request);
    void this.opts.sync.start({ ...request, signal: torrent.stop.signal, target: torrent });
  }

  /** A sync the release stopped starts over when the session takes its torrent back; one never asked starts nothing. */
  resumeSync(torrent: SessionTorrent): void {
    const sync = this.syncs.get(torrent);
    if (sync !== undefined) this.startSync(torrent, sync);
  }

  /**
   * The subtitle chain for a session's torrent. It may hold the answer for `subtitleHeadMs` (a kept file, a replay);
   * after that the play is answered with `Subtitles: pending` and the chain goes on behind it: when it ends the
   * track is put on the session, `subtitleRev` goes up (the open page loads it on its next position report) and
   * `subtitlesPending` answers the chain's attempts. Wyzie Synced starts once the chain has ended, either way.
   */
  async start(torrent: SessionTorrent, ctx: Omit<SubtitleContext, 'deadline'>, sync: SyncAsk): Promise<ResolveAttempt[]> {
    const started = this.now();
    let late = false;
    const said = (attempts: readonly ResolveAttempt[]): string => attempts.map((a) => `${a.provider.replace(/^Subtitles: /, '')} ${a.outcome} ${a.took_s ?? 0} s`).join(', ');
    const chain = runSubtitleChain(this.opts.tiers, ctx, { log: this.log }).then((out) => {
      // A subtitle put on the session meanwhile (/sync-subtitle's checked file) is never replaced by one that ranks lower.
      const takes = out.subtitles.length > 0 && rankOf(out.subtitles) >= rankOf(torrent.subtitles);
      if (takes || torrent.subtitles.length === 0) torrent.subtitles = out.subtitles;
      if (late) {
        if (takes) torrent.subtitleRev += 1;
        torrent.subtitlesPending = null;
        this.log(`[notesd] torrent: subtitles of ${ctx.infoHash.slice(0, 8)} ${out.subtitles.length > 0 ? 'arrived' : 'not found'} behind the play, ${seconds(started, this.now())} s after the search began (${said(out.attempts)})`);
      }
      this.startSync(torrent, sync);
      // The release's own subtitle file, still downloading when the chain ended, takes the place of what it answered.
      void out.later?.then((more) => {
        if (more.subtitles.length === 0 || torrent.stop.signal.aborted || rankOf(more.subtitles) <= rankOf(torrent.subtitles)) return;
        torrent.subtitles = more.subtitles;
        torrent.subtitleRev += 1;
        this.log(`[notesd] torrent: the release's own subtitle of ${ctx.infoHash.slice(0, 8)} arrived ${seconds(started, this.now())} s after the search began and takes the place of the one shown (${said(more.attempts)})`);
      });
      return out.attempts;
    });
    const headMs = this.opts.subtitleHeadMs ?? SUBTITLE_HEAD_MS;
    const timer = sleep(headMs);
    const head = await Promise.race([chain, timer.done.then(() => null)]);
    timer.clear();
    if (head !== null) return head;
    late = true;
    torrent.subtitlesPending = chain;
    return [{ provider: SUBTITLES_PENDING, outcome: 'skipped', took_s: seconds(started, this.now()), detail: 'the subtitle search goes on behind the play; the player loads the track when it arrives' }];
  }
}
