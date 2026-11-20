import { OFFICE_SSID, type WarpState, type WarpSwitch } from '../../streaming/warp.js';
import type { WarpHolds } from '../torrentWarp.js';

/**
 * Cloudflare WARP for a torrent download the owner asked for (stream-downloads phase 10). The source order is the same
 * on every network. On the office network (SSID Employee), a torrent step whose every torrent sent no file list
 * (noPeersAtAll) is asked once more with WARP on, as a torrent play is (torrentWarp.ts). A download that goes ahead
 * through WARP holds it while its torrent is in the swarm, and lets go when it is done, paused, failed or cancelled.
 * WARP goes back off when the last holder lets go, unless a torrent plays on screen. The holders are the stream
 * service's one WarpHolds, shared with torrent plays. A download never reaches the switch's `set`, only this port.
 */

/** WARP as a download may use it: read, hold, let go. No `set` (DirectStreamService.warpForDownloads builds it). */
export interface DownloadWarp {
  /** WARP's state and the Wi-Fi name now (warp.mjs `status`). */
  status(): Promise<WarpState>;
  /** True while the stream service switched WARP on and a play or a download still holds it: a download may join it. */
  readonly ours: boolean;
  /** WarpHolds.hold: WARP switched on for the first holder; the switch's state (null, or not connected: nothing held). */
  hold(): Promise<WarpState | null>;
  /** WarpHolds.release: `played` true keeps WARP on (a torrent plays through it). */
  release(played: boolean): Promise<'held' | 'kept' | WarpState | null>;
}

/** The port over the stream service's WarpHolds and the switch's `status`: what a download gets instead of the switch. */
export function downloadWarpOf(holds: WarpHolds, sw: Pick<WarpSwitch, 'status'>): DownloadWarp {
  return {
    status: () => sw.status(),
    get ours(): boolean {
      return holds.ours;
    },
    hold: () => holds.hold(),
    release: (played) => holds.release(played),
  };
}

/** A download's share of WARP after a round whose second ask got a torrent. */
export interface WarpHold {
  /** Lets go once (a second call does nothing); never throws. */
  release(): Promise<void>;
}

/** What a round answers: the fetch to go on with, the hold when it went ahead through WARP, and what was said. */
export interface WarpRound<T> {
  out: T;
  hold: WarpHold | null;
  /** True when no peer answered on the office network: a torrent asked for by hand then fails `no_peers_here`. */
  office: boolean;
  /** The line for the row's detail and the log; null when no round was due. */
  note: string | null;
}

export interface WarpRoundsOptions {
  /** Null: NOTESD_STREAM_WARP=off (or no automatic flip). Nothing is switched, and the order goes on. */
  warp: DownloadWarp | null;
  /** True on the office network: the download's SSID seam (NOTESD_STREAM_DOWNLOAD_SSID, else WARP's status). */
  office: () => Promise<boolean>;
  /** True while a torrent plays on screen: a download letting go then keeps WARP on (the play may play through it). */
  playing: () => boolean;
  log: (line: string) => void;
}

const NETWORK = `the office network (${OFFICE_SSID})`;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What happened to WARP when a download let go of it. */
export function putBackText(back: 'held' | 'kept' | WarpState | null): string {
  if (back === 'held') return 'WARP stays on while a torrent play or another download holds it';
  if (back === 'kept') return 'WARP stays on: a torrent plays through it';
  if (back?.ok === true && back.warp === 'disconnected') return 'WARP was put back off';
  return `WARP could not be put back off (${back?.error ?? 'the switch failed'}): /warp off`;
}

export class WarpRounds {
  constructor(private readonly o: WarpRoundsOptions) {}

  /**
   * After a torrent step (or a season pack) that got nothing: when `noPeers` (every torrent sent no file list), on
   * the office network, with WARP off or on by this daemon, WARP is held and `again` asks once more. When that got
   * something, the answer carries the hold, and the caller lets go of it when the download leaves the swarm. When
   * it did not, WARP is let go at once. Anywhere else, `first` comes back as it is. A WARP the owner turned on is
   * never touched. Throws only what `again` throws, after letting go.
   */
  async round<T extends { ok: boolean }>(label: string, first: T, noPeers: boolean, again: () => Promise<T>): Promise<WarpRound<T>> {
    const none: WarpRound<T> = { out: first, hold: null, office: false, note: null };
    if (first.ok || !noPeers) return none;
    let office = false;
    try {
      office = await this.o.office();
    } catch {
      office = false;
    }
    if (!office) return none;
    const said = (note: string): WarpRound<T> => {
      this.o.log(`[notesd] downloads: ${label}: ${note}`);
      return { out: first, hold: null, office: true, note };
    };
    const warp = this.o.warp;
    if (warp === null) return said(`no torrent peer answered on ${NETWORK}; Cloudflare WARP is not switched by notesd here (NOTESD_STREAM_WARP=off)`);
    let state: WarpState;
    try {
      state = await warp.status();
    } catch (err) {
      return said(`no torrent peer answered on ${NETWORK}; Cloudflare WARP's state could not be read (${messageOf(err)})`);
    }
    // On, and not by this daemon: the owner's WARP, never touched.
    if (state.warp !== 'disconnected' && !warp.ours) {
      return said(`no torrent peer answered on ${NETWORK} with Cloudflare WARP ${state.warp}, which notesd did not switch on and leaves as it is`);
    }
    const on = await warp.hold();
    if (on === null || !on.ok || on.warp !== 'connected') {
      return said(`no torrent peer answered on ${NETWORK}; Cloudflare WARP could not be turned on (${on?.error ?? 'the switch failed'})`);
    }
    let second: T;
    try {
      second = await again();
    } catch (err) {
      await this.letGo(warp);
      throw err;
    }
    if (second.ok) {
      const note = `no torrent peer answered on ${NETWORK}, so Cloudflare WARP was turned on and the torrents asked again; WARP stays on while this download is in the swarm`;
      this.o.log(`[notesd] downloads: ${label}: ${note}`);
      return { out: second, hold: this.holdOf(warp, label), office: true, note };
    }
    const back = await this.letGo(warp);
    const note = `no torrent peer answered on ${NETWORK}; through Cloudflare WARP no torrent could be downloaded either, so ${putBackText(back)}`;
    this.o.log(`[notesd] downloads: ${label}: ${note}`);
    return { out: second, hold: null, office: true, note };
  }

  private holdOf(warp: DownloadWarp, label: string): WarpHold {
    let held = true;
    return {
      release: async () => {
        if (!held) return;
        held = false;
        const back = await this.letGo(warp);
        this.o.log(`[notesd] downloads: ${label}: let go of Cloudflare WARP; ${putBackText(back)}`);
      },
    };
  }

  /** WarpHolds.release; a torrent playing on screen now keeps WARP on (it may play through it). Never throws. */
  private async letGo(warp: DownloadWarp): Promise<'held' | 'kept' | WarpState | null> {
    try {
      return await warp.release(this.o.playing());
    } catch {
      return null;
    }
  }
}
