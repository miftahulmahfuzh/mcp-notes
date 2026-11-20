import { randomBytes } from 'node:crypto';
import type { CacheSubtitleView, SessionCache } from './cachePlay.js';
import { absoluteHttp } from './rewrite.js';
import type { TorrentCandidate, TorrentQuery } from './torrent/find/index.js';
import type { SyncTarget } from './torrent/subtitles/synced.js';
import type { ManifestKind, ResolveAttempt, ResolvedSource, StreamRef } from './types.js';

/** A session ends this long after its last request (the player fetches every few seconds while it plays). */
export const SESSION_IDLE_MS = 4 * 60 * 60 * 1000;
/** ... and this long after it began, whatever happens. */
export const SESSION_MAX_MS = 24 * 60 * 60 * 1000;
/** More live sessions than this: the least recently used goes. */
export const MAX_SESSIONS = 32;
/** 24 random bytes, base64url: 32 characters, 192 bits. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/**
 * The torrent a stream session plays from (torrent phase 3). Made by TorrentSource; the session's `source` is
 * then its stand-in (provider `Torrent`, the local manifest), `cache` is null and `allowedHosts` is empty.
 */
export interface SessionTorrent {
  /** Lower-case hex. */
  infoHash: string;
  /** The chosen video file's index in the torrent. */
  fileIndex: number;
  /** Every file this session selected (the video first, then its subtitle files): what a hold selects again. */
  selected: number[];
  /** The release name. */
  name: string;
  /** The index that listed the torrent (`Torrentio`, ...); null for a replay from disk. */
  index: string | null;
  /** The seed count the index listed; null for a replay from disk. */
  seeds: number | null;
  /** `ready`: the file is whole on disk; `downloading`: the file route fetches what is missing. Read again by every sessionInfo. */
  state: 'downloading' | 'ready';
  height: number | null;
  /** The local file route, relative to the daemon's origin: `/api/stream/torrent/<hash>/f/<index>`. */
  manifestUrl: string;
  /** `mp4` (the file as is); phase 5 adds `hls` for its remux. */
  manifestKind: Extract<ManifestKind, 'mp4' | 'hls'>;
  subtitles: CacheSubtitleView[];
  /**
   * Counts the times Wyzie Synced replaced `subtitles` after the play started (torrent/subtitles/synced.ts); 0 at
   * first. The player page reads it in the answer to its position reports and loads the subtitle again when it changes.
   */
  subtitleRev: number;
  /**
   * The subtitle chain still running behind the play (the play was answered with `Subtitles: pending`); it answers
   * the chain's attempts, never rejects, and is null again once it has ended. Unset or null: nothing is pending.
   */
  subtitlesPending?: Promise<ResolveAttempt[]> | null;
  /** The candidates after this one, in the finder's order, for the shuffle button (switchSource). */
  candidates: TorrentCandidate[];
  durationS: number | null;
  /** The film's own bitrate (the file's bytes over its length), in kbit/s; null or unset when not known (a replay from disk). */
  filmKbps?: number | null;
  /** The candidate this session opened, to open it again after a release; null: a replay from disk, which joins no swarm. */
  candidate: TorrentCandidate | null;
  /** True while this session holds a `use` of the torrent in the swarm; a release sets it false, a hold true again. */
  held: boolean;
  /** The title's IMDb id the torrent was found by; null for a replay from disk. */
  imdbId: string | null;
  /** The finder's query (IMDb id, names, year, episode) the shuffle button tries the rest with; null for a replay. */
  query: TorrentQuery | null;
  /**
   * Aborted when the session lets go of the torrent (TorrentSource.release): the growing subtitle tiers (phase 7's
   * extraction, phase 8's Whisper) stop their work. A torrent taken back gets a fresh one; a stopped growing track
   * starts over on the next play.
   */
  stop: AbortController;
}

/**
 * How the owner started the play, which bounds where an automatic switch may take it (autoSwitch in service.ts):
 * `provider`, a provider named by name, never moves by itself; `cloud` (NTM, NTS) stays among the cloud providers;
 * `torrent` (TM, TS, a pasted magnet) among the torrents; null (no source named) may go either way.
 */
export type SessionLock = 'provider' | 'cloud' | 'torrent' | null;

/** One resolved title the player may stream. In memory only: a daemon restart ends every session. */
export interface StreamSession {
  readonly id: string;
  readonly ref: StreamRef;
  source: ResolvedSource;
  /** The last resolve's attempts, as the resolver printed them. */
  attempts: ResolveAttempt[];
  /** `URL.host` (with port) of every host this session may fetch. */
  allowedHosts: Set<string>;
  /** Where the player starts, in seconds; null: from the start. */
  resumeS: number | null;
  /** The title's original language (TMDB's code): the player picks that audio track; null: unknown. */
  audioLang: string | null;
  /**
   * The stream cache on this host the session plays from (phase 6); null: through the pass-through.
   * While set, `source` is cacheSource()'s stand-in (the cache's provider, its local manifest), and
   * `attempts` and `allowedHosts` are empty.
   */
  cache: SessionCache | null;
  /** The torrent the session plays from (torrent phase 3); null: not a torrent. Never set together with `cache`. */
  torrent: SessionTorrent | null;
  /**
   * The title's English subtitle from outside the stream, for a cloud session whose source has none
   * (outsideSubtitles.ts): `subtitles` is [] until there is one, `subtitleRev` counts the times it changed after
   * the page first read the session, and `stop` aborts when the session ends (its sync stops). Never a torrent's.
   */
  outside: SyncTarget & { stop: AbortController };
  readonly createdAt: Date;
  refreshedAt: Date;
  /** Times a refresh replaced the source (a token expired); 0 for a fresh session. */
  refreshes: number;
  /** Providers this session left because their stream stalled (switchSource): no later resolve of the session tries them. */
  avoid: string[];
  /** See SessionLock; null for a session made by anything but a play that named a source. */
  lock: SessionLock;
  /** The moves the daemon made by itself (a check behind the play, a torrent that keeps stalling): at most MAX_AUTO_SWITCHES. */
  autoSwitches: number;
  /** Counts those moves; the page reads it in the answer to its position reports and loads the session again when it changes. */
  sourceRev: number;
  /** Why the last of those moves was made, for the line over the picture; null before the first. */
  sourceNote: string | null;
  /** A check behind the play rejected the stream on screen: the move waits for a report of the film playing (never a paused one). */
  pendingMove: string | null;
  /** True while an automatic move runs: one at a time. */
  moving: boolean;
  /**
   * The info hash the owner pasted for this play (a magnet, or Play this one in the torrent candidates list); null
   * otherwise. A heard dub of that very torrent is reported and kept on it, and the play stays.
   */
  pastedTorrent: string | null;
  /**
   * Counts the times the session's seek-preview cue list changed (src/directStream/previews/service.ts); 0 at first.
   * The page reads it in the session and in the answer to its position reports and fetches the previews again when it rises.
   */
  previewRev: number;
  lastUsedAt: Date;
}

function hostOf(url: string): string | null {
  const abs = absoluteHttp(url);
  return abs === null ? null : new URL(abs).host.toLowerCase();
}

/** The hosts a resolve returned: the manifest's and every subtitle track's. */
export function sourceHosts(source: ResolvedSource): Set<string> {
  const hosts = new Set<string>();
  for (const url of [source.manifest_url, ...source.subtitles.map((t) => t.url)]) {
    const host = hostOf(url);
    if (host !== null) hosts.add(host);
  }
  return hosts;
}

/** True when `url` is http(s) on a host this session may fetch. */
export function allows(session: StreamSession, url: string): boolean {
  const host = hostOf(url);
  return host !== null && session.allowedHosts.has(host);
}

/** Lets the session fetch `url`'s host. Called only with addresses named by an answer fetched through the session. */
export function learn(session: StreamSession, url: string): void {
  const host = hostOf(url);
  if (host !== null) session.allowedHosts.add(host);
}

export class SessionStore {
  private readonly sessions = new Map<string, StreamSession>();
  private readonly endListeners: Array<(session: StreamSession) => void> = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Called with every session the store drops (it expired, or more than MAX_SESSIONS live). A listener that throws is ignored. */
  onEnd(listener: (session: StreamSession) => void): void {
    this.endListeners.push(listener);
  }

  create(
    ref: StreamRef,
    source: ResolvedSource,
    attempts: ResolveAttempt[],
    resumeS: number | null = null,
    audioLang: string | null = null,
    cache: SessionCache | null = null,
  ): StreamSession {
    this.sweep();
    const at = this.now();
    const session: StreamSession = {
      id: randomBytes(24).toString('base64url'),
      ref,
      source,
      attempts,
      allowedHosts: sourceHosts(source),
      resumeS,
      audioLang,
      cache,
      torrent: null,
      outside: { subtitles: [], subtitleRev: 0, stop: new AbortController() },
      createdAt: at,
      refreshedAt: at,
      refreshes: 0,
      avoid: [],
      lock: null,
      autoSwitches: 0,
      sourceRev: 0,
      sourceNote: null,
      pendingMove: null,
      moving: false,
      pastedTorrent: null,
      previewRev: 0,
      lastUsedAt: at,
    };
    this.sessions.set(session.id, session);
    while (this.sessions.size > MAX_SESSIONS) {
      let oldest: StreamSession | null = null;
      for (const s of this.sessions.values()) if (oldest === null || s.lastUsedAt < oldest.lastUsedAt) oldest = s;
      if (oldest === null) break;
      this.drop(oldest);
    }
    return session;
  }

  /** A session on a torrent (torrent phase 3): `source` is TorrentSource's stand-in (a local manifest: no host is allowed), and no cache. */
  createTorrent(ref: StreamRef, source: ResolvedSource, attempts: ResolveAttempt[], resumeS: number | null, audioLang: string | null, torrent: SessionTorrent): StreamSession {
    const session = this.create(ref, source, attempts, resumeS, audioLang, null);
    session.torrent = torrent;
    return session;
  }

  /** The live session with this id, marked used now; null when the id is malformed, unknown or ended. */
  get(id: string): StreamSession | null {
    if (!SESSION_ID_PATTERN.test(id)) return null;
    const session = this.sessions.get(id);
    if (session === undefined) return null;
    const now = this.now();
    if (now.getTime() >= this.expiresAt(session).getTime()) {
      this.drop(session);
      return null;
    }
    session.lastUsedAt = now;
    return session;
  }

  /** The live session with this id, without marking it used (a snapshot must not keep a session alive); null like get(). */
  peek(id: string): StreamSession | null {
    if (!SESSION_ID_PATTERN.test(id)) return null;
    const session = this.sessions.get(id);
    if (session === undefined) return null;
    return this.now().getTime() >= this.expiresAt(session).getTime() ? null : session;
  }

  /**
   * A refresh: the new source, its hosts added to the ones the session already had. A resolved source is never a
   * cache's, nor a torrent's (a torrent session moved to a cloud provider: the caller released the torrent).
   */
  replaceSource(session: StreamSession, source: ResolvedSource, attempts: ResolveAttempt[]): void {
    session.source = source;
    session.attempts = attempts;
    session.cache = null;
    session.torrent = null;
    for (const host of sourceHosts(source)) session.allowedHosts.add(host);
    session.refreshedAt = this.now();
    session.refreshes += 1;
  }

  /** The shuffle button on a torrent session, or a cloud session moved to a torrent: the torrent and its stand-in source. The caller released the old torrent. */
  replaceTorrent(session: StreamSession, source: ResolvedSource, torrent: SessionTorrent, attempts: ResolveAttempt[]): void {
    session.source = source;
    session.cache = null;
    session.attempts = attempts;
    session.torrent = torrent;
    session.refreshedAt = this.now();
    session.refreshes += 1;
  }

  /** A refresh of a session whose cache can still be played: the cache as it is now (a download may have finished). Not counted in `refreshes` (no token was replaced). */
  useCache(session: StreamSession, cache: SessionCache): void {
    session.cache = cache;
    session.refreshedAt = this.now();
  }

  expiresAt(session: StreamSession): Date {
    return new Date(Math.min(session.lastUsedAt.getTime() + SESSION_IDLE_MS, session.createdAt.getTime() + SESSION_MAX_MS));
  }

  get size(): number {
    this.sweep();
    return this.sessions.size;
  }

  /** Every live session, the ended ones dropped first. */
  live(): StreamSession[] {
    this.sweep();
    return [...this.sessions.values()];
  }

  /** Drops every session that has ended. */
  sweep(): void {
    const now = this.now().getTime();
    for (const session of [...this.sessions.values()]) if (now >= this.expiresAt(session).getTime()) this.drop(session);
  }

  private drop(session: StreamSession): void {
    this.sessions.delete(session.id);
    session.outside.stop.abort();
    for (const listener of this.endListeners) {
      try {
        listener(session);
      } catch {
        // A listener never stops a session from ending.
      }
    }
  }
}
