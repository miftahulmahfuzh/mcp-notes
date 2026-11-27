import { codeOf, type PlayerHost } from './playerState';
import { continueSession, fetchSession, isDaemonDown, readPlayMemory, SessionError, writePlayMemory, type PlayMemory, type StreamSession } from './session';

/** While the daemon is down (a restart), the page asks to carry its play on this often... */
export const RECONNECT_RETRY_MS = 5_000;
/** ...and gives up, showing that the stream has ended, after this long. */
export const RECONNECT_GIVE_UP_MS = 180_000;

/** The daemon lost the session (`unknown_session`) or cannot be reached: a fresh session may carry the play on. */
export function sessionGone(err: unknown): boolean {
  return isDaemonDown(err) || (err instanceof SessionError && err.code === 'unknown_session');
}

/** What carrying a play on needs of the controller besides the host. */
export interface ReconnectHost extends PlayerHost {
  /** Bumped by every load of a stream: a move that began meanwhile has replaced what failed. */
  generation(): number;
  hasEngine(): boolean;
  /** Plays the fresh session at the position the film reached; paused if it was. */
  swapTo(session: StreamSession): Promise<void>;
}

/**
 * The play carried on after the daemon lost the session (it restarted: sessions live in its memory)
 * or cannot be reached. The page keeps what it knows of its play (title, provider or torrent,
 * position) in memory and in the tab's storage, and asks for a fresh session for it with that.
 */
export class Reconnect {
  private readonly host: ReconnectHost;
  /** What the page knows of its play, to carry it on after the daemon lost the session. */
  private memory: PlayMemory | null = null;
  /** The page is asking the daemon to carry the play on (carryOn). */
  private carrying = false;
  /** The page is asking the daemon whether it still holds the session (endedOrCarryOn). */
  private judging = false;

  constructor(host: ReconnectHost) {
    this.host = host;
  }

  /** The page is asking for a fresh session now. */
  get active(): boolean {
    return this.carrying;
  }

  /** A reload: what the tab's storage still knows of the play of `sessionId`. True when it knows it. */
  readFromTab(sessionId: string): boolean {
    this.memory = readPlayMemory(this.host.deps.memory, sessionId);
    return this.memory !== null;
  }

  /** Keeps what the page knows of its play, in memory and in the tab's storage. A null position keeps the one known for that session. */
  remember(session: StreamSession, positionS: number | null): void {
    if (session.ref === null) return;
    const keep = this.memory !== null && this.memory.sessionId === session.id ? this.memory.positionS : null;
    this.memory = { sessionId: session.id, ref: session.ref, provider: session.provider, infoHash: session.torrent?.infoHash ?? null, positionS: positionS ?? keep };
    writePlayMemory(this.host.deps.memory, this.memory);
  }

  /** A position the page reported for `sessionId`: kept when the memory is of that session. */
  rememberPosition(sessionId: string, positionS: number): void {
    if (this.memory === null || this.memory.sessionId !== sessionId) return;
    this.memory = { ...this.memory, positionS };
    writePlayMemory(this.host.deps.memory, this.memory);
  }

  /** Where the film is: the picture's position while it is on the page, else the last one known. */
  continueAt(): number {
    const { host } = this;
    if (host.onFilm() && host.video.currentTime > 0) return host.video.currentTime;
    if (host.lastPositionS() > 0) return host.lastPositionS();
    return this.memory?.positionS ?? 0;
  }

  /** The play cannot go on as it is: when the daemon lost the session or cannot be reached, it is carried on; else it stops with `err`. */
  async endedOrCarryOn(err: SessionError): Promise<void> {
    const { host } = this;
    if (host.disposed() || this.carrying || this.judging) return;
    if (host.muted || this.memory === null) {
      host.fail(err);
      return;
    }
    const asked = host.sessionId();
    // A move (another source, the cache) that began meanwhile has replaced what failed.
    const generation = host.generation();
    let gone = false;
    this.judging = true;
    try {
      await fetchSession(asked, host.deps.fetch);
    } catch (e) {
      gone = sessionGone(e);
    } finally {
      this.judging = false;
    }
    if (host.disposed() || host.sessionId() !== asked || host.generation() !== generation || host.state().stage === 'error') return;
    if (gone) void this.carryOn(err.code);
    else host.fail(err);
  }

  /**
   * The page asks for a fresh session for the same play (POST /api/stream/continue) with what it
   * knows: the title, the provider or the torrent, the position. While the daemon is down it asks
   * again every RECONNECT_RETRY_MS with a quiet note, and only after RECONNECT_GIVE_UP_MS says the
   * stream has ended. The film on screen plays on from its buffer meanwhile; the new session is
   * loaded at the position the film reached, and the address bar follows it.
   */
  async carryOn(reason: string): Promise<void> {
    const { host } = this;
    if (host.disposed() || this.carrying) return;
    const memory = this.memory;
    if (host.muted || memory === null) {
      host.fail(new SessionError(reason === 'unknown_session' ? reason : 'session_over', 0));
      return;
    }
    this.carrying = true;
    host.set({ reconnecting: true });
    host.note(`${reason}: carrying the play on in a fresh session`);
    const asked = host.sessionId();
    const giveUpAt = Date.now() + RECONNECT_GIVE_UP_MS;
    try {
      for (;;) {
        const at = this.continueAt();
        try {
          const answer = await continueSession({ ...memory, positionS: at > 0 ? at : memory.positionS }, host.deps.fetch);
          if (host.disposed() || host.sessionId() !== asked) return;
          if (!answer.continued && answer.session.id === asked && host.onFilm() && host.hasEngine()) {
            host.note('the daemon still holds the session');
            return;
          }
          await host.swapTo(answer.session);
          return;
        } catch (err) {
          if (host.disposed() || host.sessionId() !== asked) return;
          if (!isDaemonDown(err) || Date.now() >= giveUpAt) {
            const code = err instanceof SessionError && !isDaemonDown(err) ? err.code : 'session_over';
            host.note(`could not carry the play on: ${codeOf(err)}`);
            host.fail(new SessionError(code, 0));
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_RETRY_MS));
        if (host.disposed() || host.sessionId() !== asked) return;
      }
    } finally {
      this.carrying = false;
      if (!host.disposed()) host.set({ reconnecting: false });
    }
  }
}
