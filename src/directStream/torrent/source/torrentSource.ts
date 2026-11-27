import type { SessionTorrent } from '../../sessions.js';
import type { ResolveAttempt, ResolvedSource, StreamRef } from '../../types.js';
import type { ReleaseHeight } from '../find/index.js';
import type { TorrentMarks } from '../marks.js';
import type { TorrentCandidateList } from '../candidates.js';
import { TORRENT_OPEN_TIMEOUT_MS } from './constants.js';
import type { SourceContext } from './context.js';
import { fromDisk, onDisk, releaseHeight } from './disk.js';
import { FailureMemory } from './failures.js';
import { SwarmHands } from './hands.js';
import { TorrentEars } from './hearing.js';
import { fetchAhead, fetchKept, keptState, releaseAhead, retryKeptRemux } from './kept.js';
import { learnMagnet } from './learnMagnet.js';
import { CandidateListings, listCandidates } from './listing.js';
import { fetchPack } from './pack.js';
import { SessionPages } from './page.js';
import { PastedMagnets, playMagnet } from './pasted.js';
import { refKey } from './query.js';
import { next, resolve } from './resolve.js';
import { SubtitleStarter } from './subtitles.js';
import { trackersOf } from './trackers.js';
import type { KeptResolve, KeptState, MagnetReport, PackFetch, PackOptions, TitleNames, TorrentHearing, TorrentResolve, TorrentResolveOptions, TorrentSourceOptions } from './types.js';

/**
 * The torrent source of direct streaming (torrent phase 3). DirectStreamService calls only this: it finds the
 * title's torrents by IMDb id (phase 2's findCandidates), opens the best of them side by side in the swarm (phase 1's
 * TorrentStreams) until one holds a file that plays in the title's original language, and answers the session's
 * SessionTorrent and the ResolvedSource stand-in a session carries. The finder ranks the candidates (phase 2);
 * which of the ones whose header arrived plays is decided here, by what their swarms deliver (chooseOrder). How
 * bytes are fetched is phase 1's. It never runs inside DirectStreamService.serial(): phase 6's borrow tier calls
 * subtitleText, which queues there.
 *
 * This class is the facade: each method hands its work to the module of source/ that owns the concern (listed in
 * docs/guide/streaming.md, "The rules in the code"): resolve.ts (a play and the shuffle), race.ts (the side-by-side race and the
 * chosen torrent), kept.ts (fetch ahead, a kept download), pack.ts (a season pack), pasted.ts (a pasted magnet),
 * learnMagnet.ts, listing.ts (the candidates list), disk.ts (a replay from disk), hearing.ts (marks and the audio
 * check), failures.ts (what failed lately per title).
 */
export class TorrentSource {
  private readonly ctx: SourceContext;

  constructor(private readonly opts: TorrentSourceOptions) {
    const now = opts.now ?? (() => Date.now());
    const log = opts.log ?? ((line: string) => console.log(line));
    this.ctx = {
      opts,
      now,
      log,
      failures: new FailureMemory(now),
      hands: new SwarmHands(opts.swarm, log),
      ears: new TorrentEars(opts, log),
      pages: new SessionPages(opts),
      subtitles: new SubtitleStarter(opts, now, log),
      listings: new CandidateListings(now),
      pasted: new PastedMagnets(),
    };
  }

  /** resolve.ts: finds the title's torrents and plays the first that works. Never throws. */
  async resolve(ref: StreamRef, options: TorrentResolveOptions): Promise<TorrentResolve> {
    return resolve(this.ctx, ref, options);
  }

  /**
   * Forgets the torrents of this film or episode whose swarm did not deliver, so the next `resolve` tries them again:
   * the torrent play on the office network asks again through WARP (torrentWarp.ts), where the same swarms may answer.
   */
  forgetNoPeers(ref: StreamRef): void {
    this.ctx.failures.forgetSwarmFailures(refKey(ref));
  }

  /** learnMagnet.ts: /update-cloud-source <magnet>. Joins no swarm and plays nothing. Never throws. */
  async learnMagnet(magnet: string): Promise<MagnetReport> {
    return learnMagnet(this.opts, this.ctx.log, magnet);
  }

  /** kept.ts: the next episode, fetched while another plays; only the download goes on. */
  async fetchAhead(ref: StreamRef, options: TorrentResolveOptions): Promise<TorrentResolve> {
    return fetchAhead(this.ctx, (r, o) => this.resolve(r, o), ref, options);
  }

  /** kept.ts: a download the owner asked for, its untagged audio heard before it is kept. Never throws. */
  async fetchKept(ref: StreamRef, options: TorrentResolveOptions & { infoHash?: string | null }): Promise<KeptResolve> {
    return fetchKept(this.ctx, (r, o) => this.resolve(r, o), ref, options);
  }

  /** kept.ts: where a kept download stands. Never throws. */
  async keptState(torrent: SessionTorrent): Promise<KeptState> {
    return keptState(this.ctx, torrent);
  }

  /** kept.ts: a kept download's failed remux, started again once. Never throws. */
  async retryKeptRemux(torrent: SessionTorrent): Promise<void> {
    return retryKeptRemux(this.ctx, torrent);
  }

  /** Lets go of a torrent `fetchAhead` took (once): with no other user the daemon leaves its swarm. */
  releaseAhead(torrent: SessionTorrent): void {
    releaseAhead(this.ctx, torrent);
  }

  /** pack.ts: a season download's pack. Never throws. */
  async fetchPack(tmdbId: number, season: number, episodes: readonly number[], options: PackOptions): Promise<PackFetch> {
    return fetchPack(this.ctx, tmdbId, season, episodes, options);
  }

  /** The picture height a torrent's release name says (from this host's row), or null when nothing says. Never throws. */
  async releaseHeight(infoHash: string): Promise<ReleaseHeight | null> {
    return releaseHeight(this.opts.swarm, infoHash);
  }

  /** True when this host holds a finished download of `ref`. */
  async onDisk(ref: StreamRef): Promise<boolean> {
    return onDisk(this.opts.swarm, ref);
  }

  /** pasted.ts: one torrent the owner pasted, played without asking any index. Never throws. */
  async playMagnet(ref: StreamRef, options: TorrentResolveOptions & { magnet: string; pasted?: boolean }): Promise<TorrentResolve> {
    return playMagnet(this.ctx, ref, options);
  }

  /** resolve.ts: the shuffle button, the session's remaining candidates without asking the indexes again. */
  async next(ref: StreamRef, torrent: SessionTorrent, audioLang: string | null): Promise<TorrentResolve> {
    return next(this.ctx, ref, torrent, audioLang);
  }

  /**
   * A session's torrent kept stalling while it played (autoSwitch in service.ts): it is left out of this title's next
   * asks like a swarm that did not deliver (SWARM_FAILURE_KEEP_MS), so `next` and `resolve` try the others.
   */
  noteStalled(ref: StreamRef, infoHash: string): void {
    this.ctx.failures.noteStalled(ref, infoHash);
  }

  /** A torrent heard as a dub of this title: left out of its asks like a file that will not change (it is kept in the marks too). */
  noteDubbed(ref: StreamRef, infoHash: string, why: string | null = null): void {
    this.ctx.failures.noteDubbed(ref, infoHash, why);
  }

  /** The info hashes the marks keep out of a play of a title whose original is `audioLang`; empty when the marks cannot be read. */
  async leftOutByMarks(audioLang: string | null): Promise<Set<string>> {
    return this.ctx.ears.leftOutByMarks(audioLang);
  }

  /** The torrent marks (the blacklist, heard languages); null when none are wired. */
  get marks(): TorrentMarks | null {
    return this.ctx.ears.marks;
  }

  /** listing.ts: every candidate torrent of a film or episode, for the candidates list. Joins no swarm. */
  async listCandidates(ref: StreamRef, options: { audioLang: string | null; imdbId: string | null; names?: TitleNames | null; fresh?: boolean; remembered?: string | null }): Promise<TorrentCandidateList> {
    return listCandidates(this.ctx, ref, options);
  }

  /** True when a hearing can run at all (a hearer is wired). */
  get hears(): boolean {
    return this.ctx.ears.hears;
  }

  /** hearing.ts: the torrent audio check. Null when no hearer is wired. Never throws: a failure is `unsure`. */
  async hearAudio(torrent: Pick<SessionTorrent, 'infoHash' | 'fileIndex' | 'name' | 'durationS'>, audioLang: string, startS: number | null): Promise<TorrentHearing | null> {
    return this.ctx.ears.hearAudio(torrent, audioLang, startS);
  }

  /**
   * What the session's swarm delivers now: the peers, the rate and the film's own bitrate (null when unknown). Null
   * when the torrent is not in the swarm or the engine cannot say.
   */
  delivery(torrent: SessionTorrent): { peers: number; downKbps: number; filmKbps: number | null } | null {
    return this.ctx.hands.delivery(torrent);
  }

  /** disk.ts: this host's finished download of the title, played from disk with no index asked and no swarm joined (R2.9). */
  async fromDisk(ref: StreamRef, options: { audioLang: string | null; resumeS?: number | null }): Promise<{ torrent: SessionTorrent; source: ResolvedSource; attempts: ResolveAttempt[] } | null> {
    return fromDisk(this.ctx, ref, options);
  }

  /** Takes the session's torrent again after a release (a reload of the page, a refresh). Throws when the swarm cannot open it. */
  async hold(ref: StreamRef, torrent: SessionTorrent): Promise<void> {
    const c = torrent.candidate;
    if (torrent.held || c === null) return;
    await this.opts.swarm.open({ infoHash: c.infoHash, trackers: trackersOf(this.opts, c), name: c.name, ref, release: c.release }, { timeoutMs: TORRENT_OPEN_TIMEOUT_MS });
    await this.opts.swarm.use(c.infoHash, [...torrent.selected]);
    if (torrent.stop.signal.aborted) torrent.stop = new AbortController();
    torrent.held = true;
    // A sync the release stopped starts over; one that finished changed the subtitle, and nothing starts.
    this.ctx.subtitles.resumeSync(torrent);
    // A remux stopped with the release starts again (torrent phase 5); its playlist keeps its address.
    if (torrent.manifestKind === 'hls') await this.opts.remux?.resume(torrent.infoHash, torrent.fileIndex);
  }

  /** Lets go of the session's torrent (once), and stops its growing subtitle tiers. */
  release(torrent: SessionTorrent): void {
    torrent.stop.abort();
    if (!torrent.held) return;
    torrent.held = false;
    if (torrent.manifestKind === 'hls') this.opts.remux?.release(torrent.infoHash, torrent.fileIndex);
    this.ctx.hands.letGo(torrent.infoHash);
  }

  /** `ready` once the chosen file is whole on disk, else `downloading`. */
  async state(torrent: SessionTorrent): Promise<SessionTorrent['state']> {
    return this.ctx.pages.state(torrent);
  }
}
