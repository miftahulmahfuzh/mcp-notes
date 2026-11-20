import { OFFICE_SSID, type WarpState, type WarpSwitch } from '../streaming/warp.js';
import { NO_FILE_LIST, TORRENT_PROVIDER, TORRENTS_LEFT, type TorrentResolve } from './torrent/source.js';
import type { ResolveAttempt } from './types.js';

/**
 * Whether the daemon switches WARP on by itself (true) or only says it may help (false). Set by the measurement of
 * 2026-11-20 on kosan_baruu (docs/guide/streaming.md, "Cloudflare WARP for torrents").
 */
export const TORRENT_WARP_AUTO = true;

/** The attempt a torrent play on the office network adds: the hint, or what switching WARP on did. */
export const WARP_ATTEMPT = 'WARP';

/**
 * Cloudflare WARP for a torrent play that found no peer at all. `auto` false: the play's answer only says that WARP may
 * help; true: WARP is switched on once and the torrents asked again (NOTESD_STREAM_WARP=off builds none of it).
 */
export interface TorrentWarp {
  switch: WarpSwitch;
  auto: boolean;
}

/**
 * True when torrents were tried and not one swarm sent a file list: every torrent attempt that is not `skipped`
 * is the open's `no file list from the swarm`. A torrent that did answer (a dub, too little of the file in time,
 * no video in it) means peers are reached, and WARP is no help.
 */
export function noPeersAtAll(attempts: readonly ResolveAttempt[]): boolean {
  const tried = attempts.filter((a) => a.provider.startsWith(`${TORRENT_PROVIDER}: `) && a.outcome !== 'skipped');
  return tried.length > 0 && tried.every((a) => a.outcome === 'no_stream' && a.detail.startsWith(NO_FILE_LIST));
}

/**
 * The torrent asks that hold WARP on, per service. WARP is switched on by the first and put back off only by the last
 * to let go, and only when this service switched it on and no ask played through it (then it stays on). A WARP the
 * owner turned on is never held here, so it is never switched off.
 */
export class WarpHolds {
  private holders = 0;
  /** The switch on that this service made, while some ask still holds it. */
  private on: Promise<WarpState | null> | null = null;
  private played = false;
  /** Every switch goes after the one before it. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly sw: WarpSwitch) {}

  /** True while this service switched WARP on and an ask still holds it: another ask may join it. */
  get ours(): boolean {
    return this.on !== null;
  }

  private set(on: boolean): Promise<WarpState | null> {
    const next = this.chain.then(() => this.sw.set(on).catch(() => null));
    this.chain = next;
    return next;
  }

  /** Holds WARP on, switching it on for the first holder. Answers the switch's state; a failed switch holds nothing. */
  async hold(): Promise<WarpState | null> {
    this.holders += 1;
    this.on ??= this.set(true);
    const on = this.on;
    const state = await on;
    if (state === null || !state.ok || state.warp !== 'connected') {
      this.holders -= 1;
      if (this.holders === 0 && this.on === on) this.on = null;
    }
    return state;
  }

  /**
   * Lets go after the ask (`played`: it played through WARP, which then stays on). `held`: another ask still holds
   * it; `kept`: an ask played through it; else the switch's state after putting WARP back off.
   */
  async release(played: boolean): Promise<'held' | 'kept' | WarpState | null> {
    this.holders -= 1;
    if (played) this.played = true;
    if (this.holders > 0) return 'held';
    const keep = this.played;
    this.on = null;
    this.played = false;
    return keep ? 'kept' : this.set(false);
  }
}

const attempt = (outcome: ResolveAttempt['outcome'], detail: string, tookS: number | null = null): ResolveAttempt => ({ provider: WARP_ATTEMPT, outcome, took_s: tookS, detail });

/**
 * After a torrent ask that found no peer at all (`noPeersAtAll`), on the office network with WARP off: with `auto`,
 * WARP is switched on and `again` asks the torrents once more. WARP stays on when that played, and is put back off
 * when it did not and no other ask of this service still holds it (`holds`); without `auto`, the answer gains one
 * hint line and nothing is switched. Anywhere else (another network, WARP turned on by the owner, peers that did
 * answer) nothing is added. WARP on because another ask of this service holds it is joined: asked again under it.
 * Never throws; never for a cloud stream.
 */
export async function torrentThroughWarp(
  warp: TorrentWarp,
  holds: WarpHolds,
  first: Extract<TorrentResolve, { ok: false }>,
  again: () => Promise<TorrentResolve>,
  now: () => number = () => Date.now(),
): Promise<TorrentResolve> {
  if (!noPeersAtAll(first.attempts)) return first;
  let state;
  try {
    state = await warp.switch.status();
  } catch {
    return first;
  }
  if (state.ssid !== OFFICE_SSID) return first;
  // On, and not by this service: the owner's WARP, never touched.
  if (state.warp !== 'disconnected' && !holds.ours) return first;
  const network = `the office network (${state.ssid})`;
  if (!warp.auto) {
    return { ...first, attempts: [...first.attempts, attempt('skipped', `no torrent peer answered on ${network} with Cloudflare WARP off: turning WARP on (/warp on) may reach them`)] };
  }
  const started = now();
  const took = (): number => Math.round((now() - started) / 100) / 10;
  const on = await holds.hold();
  if (on === null || !on.ok || on.warp !== 'connected') {
    return { ...first, attempts: [...first.attempts, attempt('error', `no torrent peer answered on ${network}; Cloudflare WARP could not be turned on (${on?.error ?? 'the switch failed'})`, took())] };
  }
  let second: TorrentResolve;
  try {
    second = await again();
  } catch (err) {
    await holds.release(false);
    throw err;
  }
  // What the first round said was left to try is moot: the second ask tried it.
  const before = first.attempts.filter((a) => a.provider !== TORRENTS_LEFT);
  const back = await holds.release(second.ok);
  if (second.ok) {
    return { ...second, attempts: [...before, attempt('resolved', `no torrent peer answered on ${network}, so Cloudflare WARP was turned on and the torrents asked again. WARP stays on.`, took()), ...second.attempts] };
  }
  const putBack =
    back === 'held'
      ? 'WARP stays on while another torrent play asks through it'
      : back === 'kept'
        ? 'WARP stays on: another torrent play plays through it'
        : back?.ok === true && back.warp === 'disconnected'
          ? 'WARP was put back off'
          : `WARP could not be put back off (${back?.error ?? 'the switch failed'}): /warp off`;
  return { ...second, attempts: [...before, attempt('no_stream', `no torrent peer answered on ${network}; through Cloudflare WARP the torrents found none either, so ${putBack}.`, took()), ...second.attempts] };
}
