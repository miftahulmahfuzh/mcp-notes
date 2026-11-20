import { OFFICE_SSID, type WarpSwitch } from '../streaming/warp.js';
import { NO_FILE_LIST, TORRENT_PROVIDER, TORRENTS_LEFT, type TorrentResolve } from './torrent/source.js';
import type { ResolveAttempt } from './types.js';

/**
 * Whether the daemon switches WARP on by itself (true) or only says it may help (false). Set by the measurement of
 * 2026-11-20 on kosan_baruu (docs/guide/streaming.md, "Cloudflare WARP for torrents").
 */
export const TORRENT_WARP_AUTO = false;

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

const attempt = (outcome: ResolveAttempt['outcome'], detail: string, tookS: number | null = null): ResolveAttempt => ({ provider: WARP_ATTEMPT, outcome, took_s: tookS, detail });

/**
 * After a torrent ask that found no peer at all (`noPeersAtAll`), on the office network with WARP off: with `auto`,
 * WARP is switched on and `again` asks the torrents once more. WARP stays on when that played, and is put back off
 * when it did not; without `auto`, the answer gains one hint line and nothing is switched. Anywhere else (another
 * network, WARP already on, peers that did answer) nothing is added. Never throws; never for a cloud stream.
 */
export async function torrentThroughWarp(
  warp: TorrentWarp,
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
  if (state.ssid !== OFFICE_SSID || state.warp !== 'disconnected') return first;
  const network = `the office network (${state.ssid})`;
  if (!warp.auto) {
    return { ...first, attempts: [...first.attempts, attempt('skipped', `no torrent peer answered on ${network} with Cloudflare WARP off: turning WARP on (/warp on) may reach them`)] };
  }
  const started = now();
  const took = (): number => Math.round((now() - started) / 100) / 10;
  const on = await warp.switch.set(true).catch(() => null);
  if (on === null || !on.ok || on.warp !== 'connected') {
    return { ...first, attempts: [...first.attempts, attempt('error', `no torrent peer answered on ${network}; Cloudflare WARP could not be turned on (${on?.error ?? 'the switch failed'})`, took())] };
  }
  const second = await again();
  // What the first round said was left to try is moot: the second ask tried it.
  const before = first.attempts.filter((a) => a.provider !== TORRENTS_LEFT);
  if (second.ok) {
    return { ...second, attempts: [...before, attempt('resolved', `no torrent peer answered on ${network}, so Cloudflare WARP was turned on and the torrents asked again. WARP stays on.`, took()), ...second.attempts] };
  }
  const back = await warp.switch.set(false).catch(() => null);
  const putBack = back?.ok === true && back.warp === 'disconnected' ? 'WARP was put back off' : `WARP could not be put back off (${back?.error ?? 'the switch failed'}): /warp off`;
  return { ...second, attempts: [...before, attempt('no_stream', `no torrent peer answered on ${network}; through Cloudflare WARP the torrents found none either, so ${putBack}.`, took()), ...second.attempts] };
}
