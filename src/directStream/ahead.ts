import { refLabel, type StreamRef } from './types.js';

/**
 * The next episode, fetched while this one plays. Someone watching an episode of a series most
 * likely watches the next one after it, and an episode that is whole on this machine starts at once
 * and never stutters (One Piece 788 from the cache, after 787 lagged on a far stream host). So once
 * an episode is half watched, the daemon downloads the one after it:
 *
 * - a cloud play (NTS, or no codename) into this host's stream cache, marked `auto` like a pause's;
 * - a torrent play (TS) from a torrent, into this host's torrent downloads.
 *
 * The episode on screen comes first. A torrent play waits until its own file is whole on disk. A
 * cloud play that still streams gets a `gentle` download (one file at a time), and it stops when the
 * player says the stream keeps stalling. A cloud play of a stream the cache cannot hold (DASH) fetches
 * nothing: the next episode would most likely resolve to the same provider. One episode ahead only,
 * never one that has not aired, and nothing for a film. A play then finds the copy by itself: it looks at this host's cache and
 * finished downloads before any provider.
 */

/** The next episode is fetched once the one on screen is this far through (its position over its duration). */
export const AHEAD_AT_SHARE = 0.5;
/** A page that cannot say how long the episode is: once it reported this much playing time instead. */
export const AHEAD_AFTER_WATCHED_MS = 10 * 60_000;
/** Two reports further apart than this (the page reports every 5 s) are not one stretch of watching. */
export const AHEAD_REPORT_GAP_MS = 15_000;
/** A torrent play whose own file still downloads is looked at again this often. */
export const AHEAD_RETRY_MS = 30_000;
/** How often a torrent fetched ahead is asked whether it is whole. */
export const AHEAD_TORRENT_POLL_MS = 30_000;
/** A torrent fetched ahead that is not whole after this long is let go: what it has stays on disk. */
export const AHEAD_TORRENT_MAX_MS = 3 * 3_600_000;
/** Sessions remembered at once; the oldest is forgotten first. */
const MAX_WATCHES = 32;

/** The session a report is for, as this module reads it. */
export interface AheadSession {
  id: string;
  ref: StreamRef;
  /** What the session plays from: a torrent (in the swarm or on disk), else a cloud stream or its cache. */
  via: 'torrent' | 'cloud';
  /** False: a cloud stream of a kind the stream cache cannot hold (DASH). Unset: it can. */
  cacheable?: boolean;
}

/** One position report, as this module reads it. */
export interface AheadReport {
  paused: boolean;
  /** The film ended or the page closed. */
  over: boolean;
  /** Where the episode is, and how long it is, in seconds; null or unset: the page did not say. */
  positionS?: number | null;
  durationS?: number | null;
}

/** A torrent being fetched with no page: held in the swarm until `release`. */
export interface AheadTorrent {
  name: string;
  /** True once the episode's file is whole on disk. */
  ready(): Promise<boolean>;
  release(): void;
}

export interface EpisodeAheadDeps {
  /** The episode after `ref` that has aired, or null. */
  next(ref: StreamRef): Promise<StreamRef | null>;
  /** True when the episode the session plays is whole on this machine (a ready cache, a finished torrent download). */
  onDisk(session: AheadSession): Promise<boolean>;
  /** This host's stream cache, or null (no cache on this daemon). */
  cloud(): AheadCloud | null;
  /** The torrent source, or null (torrents off). */
  torrent(): AheadTorrents | null;
  now?: () => number;
  log?: (line: string) => void;
}

export interface AheadCloud {
  /** Starts (or carries on) this host's `auto` cache of `ref`; `started` false: it is ready or already runs. */
  start(ref: StreamRef, options: { gentle: boolean }): Promise<{ started: boolean; state: string }>;
  /** Stops the download of `ref`, keeping what is on disk. */
  pause(ref: StreamRef): Promise<boolean>;
}

export interface AheadTorrents {
  /** True when this host holds a finished download of `ref`. */
  has(ref: StreamRef): Promise<boolean>;
  /** Finds a torrent of `ref` and downloads it with no page; null when none could be opened. */
  fetch(ref: StreamRef): Promise<AheadTorrent | null>;
}

interface Watch {
  session: AheadSession;
  watchedMs: number;
  lastAt: number;
  /** `watching`: not far enough yet. `waiting`: the episode on screen comes first. `busy`: deciding. `done`: nothing more for this session. */
  stage: 'watching' | 'waiting' | 'busy' | 'done';
  retryAt: number;
  /** The episode a cloud download was started for, to stop it when the stream stalls. */
  cloudTarget: StreamRef | null;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class EpisodeAhead {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly watches = new Map<string, Watch>();
  /** The one torrent fetched ahead at a time. */
  private held: { ref: StreamRef; torrent: AheadTorrent; timer: ReturnType<typeof setInterval>; since: number } | null = null;

  constructor(private readonly deps: EpisodeAheadDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((line: string) => console.log(line));
  }

  /** A position report of the session's page. Never throws and never waits: what it starts runs behind the report. */
  watched(session: AheadSession, report: AheadReport): void {
    if (session.ref.kind !== 'tv') return;
    if (report.over) {
      // What was started goes on: the next episode is wanted all the more.
      this.watches.delete(session.id);
      return;
    }
    const at = this.now();
    let watch = this.watches.get(session.id);
    if (watch === undefined) {
      watch = { session, watchedMs: 0, lastAt: at, stage: 'watching', retryAt: 0, cloudTarget: null };
      this.watches.set(session.id, watch);
      if (this.watches.size > MAX_WATCHES) this.watches.delete(this.watches.keys().next().value as string);
      return;
    }
    const gap = at - watch.lastAt;
    watch.lastAt = at;
    // A session that moved to another source (the shuffle button, a pause's cache) is read as it is now.
    watch.session = session;
    if (!report.paused && gap > 0 && gap <= AHEAD_REPORT_GAP_MS) watch.watchedMs += gap;
    // Half watched, by a page that is really playing it: a play opened and left, or a seek while paused, fetches nothing.
    if (watch.stage === 'watching' && !report.paused && watch.watchedMs > 0 && farEnough(report, watch.watchedMs)) this.begin(watch);
    else if (watch.stage === 'waiting' && !report.paused && at >= watch.retryAt) this.begin(watch);
  }

  /** The player says the session's stream keeps stalling: a cloud download started for it stops, and none starts again for this session. */
  stalled(sessionId: string): void {
    const watch = this.watches.get(sessionId);
    if (watch === undefined) return;
    const target = watch.cloudTarget;
    watch.stage = 'done';
    watch.cloudTarget = null;
    const cloud = this.deps.cloud();
    if (target === null || cloud === null) return;
    void cloud
      .pause(target)
      .then((paused) => {
        if (paused) this.log(`[notesd] stream ahead: stopped fetching ${refLabel(target)}: ${refLabel(watch.session.ref)} keeps stalling, and it comes first`);
      })
      .catch((err: unknown) => this.log(`[notesd] stream ahead: could not stop fetching ${refLabel(target)}: ${messageOf(err)}`));
  }

  /** Lets go of a torrent fetched ahead (the daemon stops). */
  close(): void {
    this.letGo();
    this.watches.clear();
  }

  /** The episode a torrent is being fetched for ahead (the Cache page's `ahead` reason), or null. Changes nothing. */
  fetching(): StreamRef | null {
    return this.held?.ref ?? null;
  }

  private begin(watch: Watch): void {
    watch.stage = 'busy';
    void this.decide(watch)
      .then((stage) => {
        // `stalled` may have ended the watch meanwhile.
        if (watch.stage === 'busy') watch.stage = stage;
        if (stage === 'waiting') watch.retryAt = this.now() + AHEAD_RETRY_MS;
      })
      .catch((err: unknown) => {
        if (watch.stage === 'busy') watch.stage = 'done';
        this.log(`[notesd] stream ahead: nothing fetched after ${refLabel(watch.session.ref)}: ${messageOf(err)}`);
      });
  }

  private async decide(watch: Watch): Promise<'waiting' | 'done'> {
    const session = watch.session;
    const next = await this.deps.next(session.ref);
    if (next === null) return 'done';
    if (session.via === 'torrent') {
      const torrents = this.deps.torrent();
      if (torrents === null || (await torrents.has(next))) return 'done';
      if (this.held !== null && sameRef(this.held.ref, next)) return 'done';
      // Two torrents in one swarm of peers halve the one on screen: its file is whole first.
      if (!(await this.deps.onDisk(session))) return 'waiting';
      const torrent = await torrents.fetch(next);
      if (torrent === null) {
        this.log(`[notesd] stream ahead: no torrent of ${refLabel(next)} could be opened; it is found when it is played`);
        return 'done';
      }
      this.hold(next, torrent);
      this.log(`[notesd] stream ahead: fetching ${refLabel(next)} from the torrent ${torrent.name} while ${refLabel(session.ref)} plays`);
      return 'done';
    }
    const cloud = this.deps.cloud();
    if (cloud === null) return 'done';
    if (session.cacheable === false) {
      this.log(`[notesd] stream ahead: nothing fetched after ${refLabel(session.ref)}: its stream is of a kind the cache does not hold`);
      return 'done';
    }
    const gentle = !(await this.deps.onDisk(session));
    const answer = await cloud.start(next, { gentle });
    if (answer.started) {
      watch.cloudTarget = next;
      this.log(`[notesd] stream ahead: caching ${refLabel(next)} while ${refLabel(session.ref)} plays${gentle ? ' (one file at a time: the episode on screen still streams)' : ''}`);
    }
    return 'done';
  }

  private hold(ref: StreamRef, torrent: AheadTorrent): void {
    this.letGo();
    const since = this.now();
    const timer = setInterval(() => {
      const held = this.held;
      if (held === null || held.torrent !== torrent) return;
      void torrent
        .ready()
        .catch(() => false)
        .then((ready) => {
          if (this.held?.torrent !== torrent) return;
          if (ready) {
            this.log(`[notesd] stream ahead: ${refLabel(ref)} is on disk (${torrent.name})`);
            this.letGo();
          } else if (this.now() - since >= AHEAD_TORRENT_MAX_MS) {
            this.log(`[notesd] stream ahead: ${refLabel(ref)} is not whole after ${Math.round(AHEAD_TORRENT_MAX_MS / 3_600_000)} h; its torrent ${torrent.name} is let go`);
            this.letGo();
          }
        });
    }, AHEAD_TORRENT_POLL_MS);
    timer.unref?.();
    this.held = { ref, torrent, timer, since };
  }

  private letGo(): void {
    const held = this.held;
    if (held === null) return;
    this.held = null;
    clearInterval(held.timer);
    try {
      held.torrent.release();
    } catch (err) {
      this.log(`[notesd] stream ahead: could not let go of ${held.torrent.name}: ${messageOf(err)}`);
    }
  }
}

/** True once the episode is half through; by playing time when the page gave no duration. */
function farEnough(report: AheadReport, watchedMs: number): boolean {
  const duration = report.durationS ?? null;
  const position = report.positionS ?? null;
  if (duration !== null && duration > 0 && position !== null) return position >= duration * AHEAD_AT_SHARE;
  return watchedMs >= AHEAD_AFTER_WATCHED_MS;
}

function sameRef(a: StreamRef, b: StreamRef): boolean {
  return a.kind === b.kind && a.tmdbId === b.tmdbId && (a.kind !== 'tv' || b.kind !== 'tv' || (a.season === b.season && a.episode === b.episode));
}
