import type { StreamPlayEnd } from '../../db/schema.js';
import { SESSION_IDLE_MS, SESSION_MAX_MS, type StreamSession } from '../sessions.js';
import { channelFailures, channelOf, failureDetailOf, failureOf, heightOf, kbpsOf, slotOf, subtitleSourceOf } from './derive.js';
import type { PlayLogInsert, PlayLogPatch, PlayLogWriter } from './repo.js';
import { StatsTally } from './tally.js';
import { PLAY_LOG_SWEEP_EVERY_MS, PLAY_LOG_WRITE_EVERY_MS, type ChannelFailures, type PageReport, type PlayAsk } from './types.js';

export interface PlayLogOptions {
  repo: PlayLogWriter;
  /** os.hostname() (the movies service's host): every row is written under it. */
  host: string;
  now?: () => Date;
  /** One line per write that failed; default console.error. */
  log?: (line: string) => void;
  /** Default PLAY_LOG_WRITE_EVERY_MS. */
  writeEveryMs?: number;
  /** How often the open plays are checked for a session that expired; default PLAY_LOG_SWEEP_EVERY_MS, 0: never (expire() only). */
  sweepEveryMs?: number;
}

/** What DirectStreamService calls. */
export type PlayLogSink = Pick<PlayLog, 'answered' | 'failed' | 'site' | 'switched' | 'ended'>;
/** What the position route calls. */
export type PlayLogFeed = Pick<PlayLog, 'report' | 'replaced'>;

/** One session's row as memory holds it between writes. */
interface SessionTally {
  readonly session: StreamSession;
  /** Set once the insert has run (every later write queues behind it). */
  rowId: number | null;
  outcome: 'no_picture' | 'played';
  readonly stats: StatsTally;
  /** The torrent the ask was answered with: its bitrate is filled in while the session still plays it. */
  readonly infoHash: string | null;
  autoSwitches: number;
  ownerSwitches: number;
  ended: Exclude<StreamPlayEnd, 'restart'> | null;
  endedAt: Date | null;
  /** When the row was last written (ms); null before the first report. */
  lastWriteAt: number | null;
  chain: Promise<void>;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** An int4 column's ceiling: a sum over many loads is clamped, never refused. */
const int4 = (n: number): number => Math.min(Math.max(0, Math.round(n)), 2_147_483_647);
const msBetween = (from: Date, to: Date): number => int4(to.getTime() - from.getTime());
/** When the session store counts the session ended (SessionStore.expiresAt: idle too long, or too old). */
const expiryOf = (s: StreamSession): number => Math.min(s.lastUsedAt.getTime() + SESSION_IDLE_MS, s.createdAt.getTime() + SESSION_MAX_MS);

/** A failed ask's detail when the daemon stopped during it. */
export const STOPPED_DETAIL = 'the daemon stopped during the ask';

/** Every channel the ask reached, or else the one it named (both when it named none), as `error`. */
function stoppedChannels(ask: PlayAsk, reached: ChannelFailures): ChannelFailures {
  let cloud = reached.cloud !== null;
  let torrent = reached.torrent !== null;
  if (!cloud && !torrent) {
    cloud = ask.asked !== 'torrent';
    torrent = ask.asked !== 'cloud' && ask.asked !== 'provider';
  }
  return { cloud: cloud ? 'error' : null, torrent: torrent ? 'error' : null };
}

function patchOf(t: SessionTally): PlayLogPatch {
  const s = t.session;
  const totals = t.stats.totals();
  const kbps = s.torrent !== null && s.torrent.infoHash === t.infoHash ? kbpsOf(s.torrent.filmKbps) : null;
  return {
    outcome: t.outcome,
    providerLast: s.source.provider,
    ...(kbps === null ? {} : { filmKbps: kbps }),
    firstFrameMs: t.stats.firstFrameMs === null ? null : int4(t.stats.firstFrameMs),
    playedMs: int4(totals.playedMs),
    stalls: int4(totals.stalls),
    stalledMs: int4(totals.stalledMs),
    waits: int4(totals.waits),
    waitedMs: int4(totals.waitedMs),
    errors: int4(totals.errors),
    autoSwitches: t.autoSwitches,
    ownerSwitches: t.ownerSwitches,
    refreshes: s.refreshes,
    switchNote: s.sourceNote,
    subtitleSource: subtitleSourceOf(s),
    ended: t.ended,
    endedAt: t.endedAt,
  };
}

/**
 * This host's play log (stream_play_log): one row per play ask whose title is known, written behind the play. A
 * session's page counters are summed in memory (StatsTally) and written on the first report, at most every
 * `writeEveryMs` while it plays, on a switch and at the end; a quiet report (a paused page's beat for the stream on
 * screen) only updates memory. Every call is synchronous and caught; every write is queued per session and caught:
 * a failure is one log line and is dropped. Nothing here can fail, delay or change a play.
 */
export class PlayLog {
  private readonly repo: PlayLogWriter;
  private readonly host: string;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly writeEveryMs: number;
  private readonly tallies = new Map<string, SessionTally>();
  private readonly writing = new Set<Promise<void>>();
  private readonly sweepEveryMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Set by the daemon's stop: an ask that fails from now on failed because the daemon stopped, not for its title. */
  private isStopping = false;

  constructor(opts: PlayLogOptions) {
    this.repo = opts.repo;
    this.host = opts.host;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line: string) => console.error(line));
    this.writeEveryMs = opts.writeEveryMs ?? PLAY_LOG_WRITE_EVERY_MS;
    this.sweepEveryMs = opts.sweepEveryMs ?? PLAY_LOG_SWEEP_EVERY_MS;
  }

  /** The ask was answered with a player session: its row, `no_picture` until the page first reports. */
  answered(ask: PlayAsk, session: StreamSession): void {
    this.guard('an answered play', () => {
      if (this.tallies.has(session.id)) return;
      const now = this.now();
      const torrent = session.torrent;
      const t: SessionTally = {
        session,
        rowId: null,
        outcome: 'no_picture',
        stats: new StatsTally(),
        infoHash: torrent?.infoHash ?? null,
        autoSwitches: 0,
        ownerSwitches: 0,
        ended: null,
        endedAt: null,
        lastWriteAt: null,
        chain: Promise.resolve(),
      };
      this.tallies.set(session.id, t);
      this.armSweep();
      const row: PlayLogInsert = {
        host: this.host,
        askedAt: ask.at,
        via: ask.via,
        ...slotOf(ask.ref),
        asked: ask.asked,
        outcome: 'no_picture',
        resolveMs: msBetween(ask.at, now),
        session: session.id,
        channel: channelOf(session),
        providerFirst: session.source.provider,
        providerLast: session.source.provider,
        infoHash: torrent?.infoHash ?? null,
        torrentIndex: torrent?.index ?? null,
        seeds: torrent?.seeds ?? null,
        filmKbps: kbpsOf(torrent?.filmKbps),
        height: heightOf(session),
        refreshes: session.refreshes,
        switchNote: session.sourceNote,
        subtitleSource: subtitleSourceOf(session),
      };
      this.queue(t, 'an answered play', async () => {
        t.rowId = await this.repo.insert(row, now);
      });
    });
  }

  /** The ask ended without a player session: the failure's word, its redacted detail and the word of each channel asked. */
  failed(ask: PlayAsk, err: unknown): void {
    this.guard('a failed play', () => {
      const now = this.now();
      const channels = this.isStopping ? stoppedChannels(ask, channelFailures(ask.asked, err)) : channelFailures(ask.asked, err);
      const row: PlayLogInsert = {
        host: this.host,
        askedAt: ask.at,
        via: ask.via,
        ...slotOf(ask.ref),
        asked: ask.asked,
        outcome: 'failed',
        failure: this.isStopping ? 'error' : failureOf(err),
        failureDetail: this.isStopping ? STOPPED_DETAIL : failureDetailOf(err),
        cloudFailure: channels.cloud,
        torrentFailure: channels.torrent,
        resolveMs: msBetween(ask.at, now),
      };
      this.queue(null, 'a failed play', async () => {
        await this.repo.insert(row, now);
      });
    });
  }

  /** A streaming site's own player took the ask: there is no session, and no page of this daemon reports. */
  site(ask: PlayAsk, site: string): void {
    this.guard('a site play', () => {
      const now = this.now();
      const row: PlayLogInsert = {
        host: this.host,
        askedAt: ask.at,
        via: ask.via,
        ...slotOf(ask.ref),
        asked: ask.asked,
        outcome: 'site',
        resolveMs: msBetween(ask.at, now),
        channel: 'site',
        providerFirst: site,
        providerLast: site,
      };
      this.queue(null, 'a site play', async () => {
        await this.repo.insert(row, now);
      });
    });
  }

  /** The session moved to another source: by the daemon or the page by itself (`auto`), or on the owner's ask. */
  switched(session: StreamSession, by: 'auto' | 'owner'): void {
    this.guard('a source switch', () => {
      const t = this.tallies.get(session.id);
      if (t === undefined) return;
      if (by === 'auto') t.autoSwitches += 1;
      else t.ownerSwitches += 1;
      this.write(t, 'a source switch');
    });
  }

  /**
   * A position report of the session's page. Its counters always reach memory; a quiet report writes nothing. Else
   * the row is written when the page first reports (`played`), when the play ends or carries on after it was closed
   * (a reload), or when `writeEveryMs` passed since the last write.
   */
  report(sessionId: string, page: PageReport): void {
    this.guard('a position report', () => {
      const t = this.tallies.get(sessionId);
      if (t === undefined) return;
      if (page.stats !== null) t.stats.add(page.stats);
      if (page.quiet) return;
      let now = false;
      if (t.outcome === 'no_picture') {
        t.outcome = 'played';
        now = true;
      }
      if (page.over !== null) {
        if (t.ended === null) {
          t.ended = page.over;
          t.endedAt = this.now();
        }
        now = true;
      } else if (t.ended !== null) {
        // The page reports again after it closed, ended or lost the screen (a reload, a replay): the play is open again.
        t.ended = null;
        t.endedAt = null;
        now = true;
      }
      if (now || t.lastWriteAt === null || this.now().getTime() - t.lastWriteAt >= this.writeEveryMs) this.write(t, 'a position report');
    });
  }

  /** Another session's page reported while this one was the stream on screen: this play lost the screen. */
  replaced(sessionId: string): void {
    this.guard('a replaced play', () => {
      const t = this.tallies.get(sessionId);
      if (t === undefined || t.ended !== null) return;
      t.ended = 'replaced';
      t.endedAt = this.now();
      this.write(t, 'a replaced play');
    });
  }

  /** The session store dropped the session (expired, or past MAX_SESSIONS): its row is written a last time and forgotten. */
  ended(session: StreamSession, reason: Exclude<StreamPlayEnd, 'restart'>): void {
    this.guard('an ended play', () => this.close(session.id, reason));
  }

  /**
   * Closes, as `expired`, every open play whose session the store already counts ended. The store drops an expired
   * session only when something sweeps it (a new play, a torrent's sweep), so without this a play nobody closed (a
   * page that crashed or slept) stayed open until the next restart and was closed as `restart`. Runs every
   * `sweepEveryMs` while a play is open; the row's `ended_at` is the time the session expired.
   */
  expire(): void {
    this.guard('an expired play', () => {
      const now = this.now().getTime();
      for (const t of [...this.tallies.values()]) if (now >= expiryOf(t.session)) this.close(t.session.id, 'expired');
    });
  }

  /** The play is over for the session store: its row is written a last time and forgotten. An expired one ends when it expired. */
  private close(sessionId: string, reason: Exclude<StreamPlayEnd, 'restart'>): void {
    const t = this.tallies.get(sessionId);
    if (t === undefined) return;
    this.tallies.delete(sessionId);
    if (this.tallies.size === 0) this.disarmSweep();
    if (t.ended === null) {
      const now = this.now();
      t.ended = reason;
      t.endedAt = reason === 'expired' ? new Date(Math.min(now.getTime(), expiryOf(t.session))) : now;
    }
    this.write(t, 'an ended play');
  }

  private armSweep(): void {
    if (this.sweepTimer !== null || this.sweepEveryMs <= 0) return;
    this.sweepTimer = setInterval(() => this.expire(), this.sweepEveryMs);
    // Never keeps the daemon (or a test) alive.
    this.sweepTimer.unref?.();
  }

  private disarmSweep(): void {
    if (this.sweepTimer === null) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * The daemon is stopping (its stop calls this first, before the stream service is torn down). An ask that fails
   * from now on is cut short by the stop, never evidence about its title: it is logged `error` on every channel it
   * asked, so the health view's outage rule keeps it off the could-not-be-played list. Changes no play's answer.
   */
  stopping(): void {
    this.isStopping = true;
    this.disarmSweep();
  }

  /** Daemon start: the rows the previous run left open are closed as `restart`. How many; 0 when the database did not answer. */
  async closeLeftOpen(): Promise<number> {
    try {
      return await this.repo.closeLeftOpen(this.host, this.now());
    } catch (err) {
      this.log(`[notesd] play log: the rows left open were not closed: ${messageOf(err)}`);
      return 0;
    }
  }

  /** Resolves once every write queued so far has ended (tests; nothing in the daemon waits on it). */
  async settled(): Promise<void> {
    while (this.writing.size > 0) await Promise.all([...this.writing]);
  }

  private write(t: SessionTally, what: string): void {
    const now = this.now();
    t.lastWriteAt = now.getTime();
    // Read now, in this call: the queued write must say what was true when it was asked for.
    const patch = patchOf(t);
    this.queue(t, what, async () => {
      if (t.rowId === null) return;
      await this.repo.update(this.host, t.rowId, patch, now);
    });
  }

  private queue(t: SessionTally | null, what: string, job: () => Promise<void>): void {
    const run = (t?.chain ?? Promise.resolve()).then(job).catch((err: unknown) => this.log(`[notesd] play log: ${what} was not written: ${messageOf(err)}`));
    if (t !== null) t.chain = run;
    this.writing.add(run);
    void run.finally(() => this.writing.delete(run));
  }

  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log(`[notesd] play log: ${what} was not logged: ${messageOf(err)}`);
    }
  }
}
