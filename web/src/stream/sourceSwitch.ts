import { codeOf, type PlayerHost } from './playerState';
import type { Reconnect } from './reconnect';
import { sessionGone } from './reconnect';
import { fetchSession, SessionError, switchSource, type SourceSwitch } from './session';
import { STALL_WINDOW_MS, type StallWatch } from './stallWatch';

/** At most this many moves to another provider per session, and one ask per cooldown. */
export const MAX_SOURCE_SWITCHES = 2;
export const SOURCE_SWITCH_COOLDOWN_MS = 120_000;
/** `sourceNotice` after an ask that found nothing; the page words it for a cloud source or a torrent. */
export const NO_OTHER_SOURCE = 'No other source';

/** What switching sources needs of the controller besides the host. */
export interface SourceHost extends PlayerHost {
  /** Loads the stream of the source the daemon moved the session to, at the position the film had reached. */
  moveTo(answer: SourceSwitch): Promise<void>;
}

/**
 * The asks for another source of the same title: the page's own after stalls (`auto: 'stalled'`) or a
 * broken stream (`auto: 'broken'`), the owner's (the button, S), and a move the daemon made by itself
 * (followRev). The film on screen plays on while the daemon resolves; only when another source
 * answered does the page load it (SourceHost.moveTo). The page's own asks are limited to
 * MAX_SOURCE_SWITCHES moves per session and one per SOURCE_SWITCH_COOLDOWN_MS; the owner's are not.
 */
export class SourceSwitcher {
  private readonly host: SourceHost;
  private readonly stalls: StallWatch;
  private readonly reconnect: Reconnect;
  private switches = 0;
  private lastAskAt = 0;
  private asking = false;

  constructor(host: SourceHost, stalls: StallWatch, reconnect: Reconnect) {
    this.host = host;
    this.stalls = stalls;
    this.reconnect = reconnect;
  }

  /** A new session: its own count of moves and its own cooldown. */
  reset(): void {
    this.switches = 0;
    this.lastAskAt = 0;
  }

  /** The session moved to another source (SourceHost.moveTo). */
  moved(): void {
    this.switches += 1;
  }

  /**
   * The film keeps stalling (byOwner false), or the owner asked (true): ask the daemon for another
   * source of the same title. A cached play goes back to the live stream, a muted check never moves
   * (it measures the provider it was given), and a torrent asks only after TORRENT_STALLS_TO_SWITCH
   * stalls: the daemon then moves it only when its swarm cannot keep up. The page's own asks are
   * `auto`, so the daemon's rules for a move nobody asked for apply.
   */
  async change(byOwner = false): Promise<void> {
    const { host } = this;
    const now = Date.now();
    const session = host.session();
    if (host.disposed() || this.asking || this.reconnect.active || host.muted || session === null || !host.onFilm()) return;
    // A cached play that keeps stalling (a part not on disk fetched from a slow host) goes back to the live stream.
    const leaveCache = session.cached !== null;
    if (leaveCache && byOwner) return;
    // The page's own asks are limited; the owner's (the button, S) are not.
    if (!byOwner && (this.switches >= MAX_SOURCE_SWITCHES || (this.lastAskAt > 0 && now - this.lastAskAt < SOURCE_SWITCH_COOLDOWN_MS))) return;
    this.asking = true;
    this.lastAskAt = now;
    const asked = host.sessionId();
    host.note(
      byOwner
        ? 'asked for another source'
        : `${this.stalls.count} stalls in ${Math.round(STALL_WINDOW_MS / 1000)} s: ${leaveCache ? 'leaving the cache for the live stream' : 'asking for another source'}`,
    );
    this.stalls.reset();
    host.set({ changingSource: true, sourceNotice: null, ...(byOwner ? { switchedWhy: null } : {}) });
    try {
      const answer = await switchSource(asked, host.deps.fetch, leaveCache ? { leaveCache } : byOwner ? {} : { auto: 'stalled' });
      if (host.disposed() || host.sessionId() !== asked || host.state().stage === 'error') return;
      if (!answer.switched) {
        host.note(`source kept: ${answer.reason ?? 'no_other_source'}`);
        if (byOwner) host.set({ sourceNotice: NO_OTHER_SOURCE });
        return;
      }
      await host.moveTo(answer);
    } catch (err) {
      if (!host.disposed() && host.sessionId() === asked) {
        host.note(`source kept: ${codeOf(err)}`);
        if (sessionGone(err)) void this.reconnect.carryOn((err as SessionError).code);
      }
    } finally {
      this.asking = false;
      if (!host.disposed()) host.set({ changingSource: false });
    }
  }

  /**
   * The stream cannot be played at all (a segment that does not parse, a manifest the player
   * refuses, a network error the restarts did not cure): a provider's broken stream should not be
   * the end of the play. The daemon is asked for another provider of the same title, and the play
   * stops with the error only when there is none, or the session has moved as often as it may. A
   * cached play, a torrent and a muted check have no other provider to go to.
   */
  async leaveBroken(message: string): Promise<void> {
    const { host } = this;
    const session = host.session();
    if (this.reconnect.active) {
      // The daemon is being asked for a fresh session: the engine giving up meanwhile changes nothing.
      host.note(`${message} while reconnecting`);
      if (host.state().stage !== 'error') host.set({ stage: 'refreshing' });
      return;
    }
    if (host.disposed() || host.muted || this.asking || session === null || session.torrent !== null || this.switches >= MAX_SOURCE_SWITCHES) {
      // A torrent's file route is the daemon's own: a stream that broke because the daemon went away carries on.
      await this.reconnect.endedOrCarryOn(new SessionError(message, 0));
      return;
    }
    this.asking = true;
    this.lastAskAt = Date.now();
    const asked = host.sessionId();
    this.stalls.reset();
    host.note(`${message}: asking for another source`);
    host.set({ stage: 'refreshing', changingSource: true, sourceNotice: null });
    let gone = false;
    try {
      const answer = await switchSource(asked, host.deps.fetch, session.cached !== null ? { leaveCache: true } : { auto: 'broken' });
      if (host.disposed() || host.sessionId() !== asked) return;
      if (!answer.switched) {
        host.note(`source kept: ${answer.reason ?? 'no_other_source'}`);
        host.fail(new SessionError(message, 0));
        return;
      }
      await host.moveTo(answer);
    } catch (err) {
      if (host.disposed() || host.sessionId() !== asked) return;
      host.note(`source kept: ${codeOf(err)}`);
      gone = sessionGone(err);
      if (!gone) host.fail(new SessionError(message, 0));
    } finally {
      this.asking = false;
      if (!host.disposed()) host.set({ changingSource: false });
    }
    if (gone) void this.reconnect.carryOn(message);
  }

  /**
   * The daemon moved the session to another source by itself, and the answer to a position report said so (its
   * `source_rev` went up): a check that finished behind the play rejected the stream on screen (a recording, a
   * watermark, a dub). The session is read again and its new stream loaded at the position the film reached, as a
   * move the page asked for is. Nothing while the page's own ask, a move or a carry-on runs: those read the session.
   */
  async followRev(asked: string, rev: number): Promise<void> {
    const { host } = this;
    const session = host.session();
    if (host.disposed() || this.asking || this.reconnect.active || session === null || host.sessionId() !== asked || rev === session.sourceRev || !host.onFilm()) return;
    this.asking = true;
    try {
      const fresh = await fetchSession(asked, host.deps.fetch);
      if (host.disposed() || host.session() !== session || host.sessionId() !== asked || fresh.sourceRev === session.sourceRev) return;
      await host.moveTo({ switched: true, reason: null, from: session.torrent?.name ?? session.provider, provider: fresh.provider, session: fresh });
    } catch (err) {
      host.note(`source not reloaded: ${codeOf(err)}`);
    } finally {
      this.asking = false;
    }
  }
}
