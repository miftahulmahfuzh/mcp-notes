import { codeOf, type PlayerHost } from './playerState';
import { cacheSession, fetchCacheMap, type StreamSession } from './session';

/** A pause this long starts the download of the title to this machine; a quick pause and play does not. */
export const PAUSE_CACHE_DELAY_MS = 2_000;
/** How often the page asks where the download stands, and what is on disk. */
export const CACHE_POLL_MS = 4_000;

/** What the pause cache needs of the controller besides the host. */
export interface CacheHost extends PlayerHost {
  /** The daemon moved the session onto its cache: the film loads again from the local files, at the same place. */
  moveOntoCache(session: StreamSession): Promise<void>;
  /** The session as the daemon has it now, with the same stream (the cache's download finished). */
  replaceSession(session: StreamSession): void;
}

/**
 * A pause that lasts caches the film on this machine (phase 6): the owner waits for the film to load,
 * so the daemon downloads it meanwhile, and the play moves onto the cache once it can. While a play
 * is on a cache, its map (`cachedRanges`) is kept current until the download is complete.
 */
export class PauseCache {
  private readonly host: CacheHost;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  /** The session a pause already asked a cache for: once per session. */
  private askedFor: string | null = null;

  constructor(host: CacheHost) {
    this.host = host;
  }

  clearTimers(): void {
    if (this.pauseTimer !== null) clearTimeout(this.pauseTimer);
    if (this.cacheTimer !== null) clearTimeout(this.cacheTimer);
    this.pauseTimer = null;
    this.cacheTimer = null;
  }

  /** No pause of this session asks for a cache any more (a play that left the cache never goes back to it with a pause). */
  markAsked(sessionId: string): void {
    this.askedFor = sessionId;
  }

  /** A fresh session: its pauses may ask again. */
  forget(): void {
    this.askedFor = null;
  }

  // A pause that lasts: the owner waits for the film to load, so the daemon downloads it to this
  // machine meanwhile. Once per session; not for a play that is already a cache, a torrent (its
  // download is already on this machine's disk), a muted check, or DASH (which is never cached).
  arm(): void {
    if (this.pauseTimer !== null) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    const { host } = this;
    const session = host.session();
    if (
      host.muted ||
      session === null ||
      session.cached !== null ||
      session.torrent !== null ||
      session.manifestKind === 'dash' ||
      this.askedFor === host.sessionId() ||
      !host.onFilm() ||
      host.video.ended
    ) return;
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      if (host.disposed() || !host.video.paused || host.video.ended || !host.onFilm() || host.session() !== session) return;
      this.askedFor = host.sessionId();
      void this.ask(host.sessionId(), true);
    }, PAUSE_CACHE_DELAY_MS);
  }

  /** One ask of the daemon about the paused play's cache; asks again until the session moved onto it or it failed. */
  private async ask(asked: string, start: boolean): Promise<void> {
    const { host } = this;
    let answer;
    try {
      answer = await cacheSession(asked, start, host.deps.fetch);
    } catch (err) {
      if (!host.disposed() && host.sessionId() === asked) host.note(`cache: ${codeOf(err)}`);
      return;
    }
    if (host.disposed() || host.sessionId() !== asked) return;
    const moving = answer.moved && answer.session.cached !== null;
    // The daemon clears the old pass-through's allowed hosts the moment it answers `moved`, which can
    // race a segment the outgoing engine was still buffering into a stray `session_over`. The move
    // itself is authoritative (the daemon confirmed it), so it goes ahead and a stale error does not
    // stop it; an unrelated error with no move still does.
    if (host.state().stage === 'error' && !moving) return;
    if (start && answer.cache !== null) host.note(`paused: caching on this machine (${answer.cache.id.slice(0, 8)})`);
    if (answer.cache === null || answer.cache.state === 'failed') {
      host.note(`cache: ${answer.cache === null ? 'not available' : (answer.cache.error ?? 'failed')}`);
      return;
    }
    if (!answer.moved || answer.session.cached === null) {
      this.cacheTimer = setTimeout(() => {
        this.cacheTimer = null;
        void this.ask(asked, false);
      }, CACHE_POLL_MS);
      return;
    }
    await host.moveOntoCache(answer.session);
  }

  /** Keeps `cachedRanges` current while the session plays from a cache: now, then every poll until the download is complete. */
  follow(cacheId: string): void {
    if (this.cacheTimer !== null) clearTimeout(this.cacheTimer);
    this.cacheTimer = null;
    const { host } = this;
    const asked = host.sessionId();
    const tick = async (): Promise<void> => {
      const ranges = await fetchCacheMap(cacheId, host.deps.fetch);
      if (host.disposed() || host.sessionId() !== asked || host.session()?.cached?.id !== cacheId) return;
      host.set({ cachedRanges: ranges });
      if (host.session()?.cached?.state === 'ready') return;
      // The download may have finished: the daemon says so, and the mark beside the title follows.
      const now = await cacheSession(asked, false, host.deps.fetch).catch(() => null);
      const session = host.session();
      if (host.disposed() || host.sessionId() !== asked || session === null || session.cached?.id !== cacheId) return;
      if (now?.cache?.state === 'ready' && now.session.cached !== null) {
        host.replaceSession({ ...session, cached: now.session.cached });
        host.set({ cached: now.session.cached, cachedRanges: await fetchCacheMap(cacheId, host.deps.fetch) });
        return;
      }
      if (now?.cache?.state === 'failed') return;
      this.cacheTimer = setTimeout(() => void tick(), CACHE_POLL_MS);
    };
    void tick();
  }
}
