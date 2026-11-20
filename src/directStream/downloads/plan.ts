import { OFFICE_SSID } from '../../streaming/warp.js';
import type { SwarmCount, TorrentCandidate } from '../torrent/find/index.js';
import { PREFERRED_TORRENT_HEIGHT } from '../torrent/source.js';
import type { DownloadVia, TorrentBand } from './types.js';

/**
 * The source order of a download, pure and the same on every network. With no source named (`auto`): a 1080p
 * torrent with live seeds, then the owner's cloud cache at 1080p or lower, then a torrent below 1080p. On the office
 * network (SSID Employee) a torrent step that reaches no peer at all is asked once more through Cloudflare WARP before
 * the next step. That is the engine's (downloads/warp.ts), not the plan's.
 */

/** The cloud cache's height cap for a download: the torrents' preferred height, so the cloud never beats the torrent it stands in for. */
export const CLOUD_MAX_HEIGHT = PREFERRED_TORRENT_HEIGHT;

export type CloudStep = { kind: 'cloud'; maxHeight: number };
export type DownloadStep = { kind: 'torrent'; band: TorrentBand } | { kind: 'hash'; infoHash: string } | CloudStep;

export type DownloadPlan = { ok: true; steps: DownloadStep[] } | { ok: false; error: 'torrent_off' | 'cloud_off' | 'no_source'; detail: string };

/** One step that did not give a download: what it was, the code, and what was seen. `step` null: before any step. */
export interface StepFailure {
  step: DownloadStep | null;
  error: string;
  detail: string;
}

/** True on the office network: there a torrent that reaches no peer is asked once more through WARP. */
export function isOffice(ssid: string | null): boolean {
  return ssid === OFFICE_SSID;
}

/** The steps of one download, in order; or why it cannot start here. */
export function planDownload(ask: { via: DownloadVia; infoHash: string | null }, here: { torrent: boolean; cloud: boolean }): DownloadPlan {
  const cloud: CloudStep = { kind: 'cloud', maxHeight: CLOUD_MAX_HEIGHT };
  const torrentOff: DownloadPlan = { ok: false, error: 'torrent_off', detail: 'torrents are off on this machine (NOTESD_TORRENT=off)' };
  if (ask.infoHash !== null) return here.torrent ? { ok: true, steps: [{ kind: 'hash', infoHash: ask.infoHash }] } : torrentOff;
  if (ask.via === 'cloud') return here.cloud ? { ok: true, steps: [cloud] } : { ok: false, error: 'cloud_off', detail: 'the stream cache is off on this machine' };
  if (ask.via === 'torrent') return here.torrent ? { ok: true, steps: [{ kind: 'torrent', band: 'preferred' }, { kind: 'torrent', band: 'below' }] } : torrentOff;
  const steps: DownloadStep[] = [];
  if (here.torrent) steps.push({ kind: 'torrent', band: 'preferred' });
  if (here.cloud) steps.push(cloud);
  if (here.torrent) steps.push({ kind: 'torrent', band: 'below' });
  return steps.length > 0 ? { ok: true, steps } : { ok: false, error: 'no_source', detail: 'neither torrents nor the stream cache are on on this machine' };
}

/** True when the swarm has a seeder: the trackers' word when any answered for it, else the seeds the index listed. */
export function liveSeeds(c: Pick<TorrentCandidate, 'seeds'>, count: SwarmCount | null): boolean {
  if (count !== null && count.trackers > 0) return count.seeders > 0;
  return c.seeds > 0;
}

/** Whether a found torrent belongs to a band: 1080p with live seeds, or below 1080p (a height its name does not say included; never 2160p). */
export function bandAllows(band: TorrentBand, c: Pick<TorrentCandidate, 'seeds' | 'release'>, count: SwarmCount | null): boolean {
  const height = c.release.height ?? null;
  if (band === 'preferred') return height === PREFERRED_TORRENT_HEIGHT && liveSeeds(c, count);
  return height !== PREFERRED_TORRENT_HEIGHT && height !== 2160;
}

/** The steps after the cloud step: what a download goes on to when its cache fails. */
export function stepsAfterCloud(steps: readonly DownloadStep[]): DownloadStep[] {
  const at = steps.findIndex((s) => s.kind === 'cloud');
  return at < 0 ? [] : steps.slice(at + 1);
}

export function stepLabel(step: DownloadStep | null): string {
  if (step === null) return 'download';
  if (step.kind === 'cloud') return `cloud at ${step.maxHeight}p or lower`;
  if (step.kind === 'hash') return `torrent ${step.infoHash.slice(0, 8)}`;
  return step.band === 'preferred' ? `torrent ${PREFERRED_TORRENT_HEIGHT}p` : `torrent below ${PREFERRED_TORRENT_HEIGHT}p`;
}

/**
 * Why a download failed once every step did: one step's own code; `no_peers_here` when every step reached no peer on
 * the office network (WARP included); `dubbed` when every step found only dubs; else `no_source`. The detail names
 * each step and what it saw.
 */
export function finalFailure(failures: readonly StepFailure[]): { error: string; detail: string } {
  if (failures.length === 0) return { error: 'no_source', detail: 'nothing could be tried' };
  const detail = failures.map((f) => `${stepLabel(f.step)}: ${f.error}${f.detail === '' ? '' : ` (${f.detail})`}`).join('; ');
  if (failures.length === 1) return { error: failures[0]!.error, detail };
  if (failures.every((f) => f.error === 'no_peers_here')) return { error: 'no_peers_here', detail };
  return { error: failures.every((f) => f.error === 'dubbed') ? 'dubbed' : 'no_source', detail };
}
