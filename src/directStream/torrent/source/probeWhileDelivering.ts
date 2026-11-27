import type { ResolveOutcome } from '../../types.js';
import { ProbeError, type MediaProbe } from '../probe.js';
import { HEADER_GIVE_WAY_MS, PROBE_MIN_MS, PROBE_SAMPLE_MS, PROBE_STALL_BYTES, PROBE_STALL_MS, TORRENT_PROBE_TIMEOUT_MS } from './constants.js';
import { messageOf, seconds } from './text.js';
import type { TorrentSourceOptions } from './types.js';

export type Probed = { ok: true; probe: MediaProbe } | { ok: false; outcome: ResolveOutcome; detail: string };

/** What the probe needs: the swarm's byte count, ffprobe, a clock, the stall window, and the log words for a swarm. */
export interface ProbeDeps {
  opts: Pick<TorrentSourceOptions, 'swarm' | 'probe' | 'probeStallMs' | 'probeSampleMs' | 'headerGiveWayMs'>;
  now: () => number;
  receivedText: (infoHash: string) => string;
}

/**
 * ffprobe on a racer's file, given as long as its swarm delivers (up to `budgetMs`, the play's whole budget left):
 * it is stopped when the torrent received less than PROBE_STALL_BYTES in the last PROBE_STALL_MS. A swarm that
 * cannot say what it received gets the flat TORRENT_PROBE_TIMEOUT_MS. After HEADER_GIVE_WAY_MS it also gives way when
 * `waiting()` says another torrent of the play waits for its slot (budget sharing; the candidates' order is not changed).
 * Never throws.
 */
export async function probeWhileDelivering(deps: ProbeDeps, url: string, infoHash: string, budgetMs: number, cancelled: () => boolean, waiting: () => number = () => 0): Promise<Probed> {
  const { opts, now } = deps;
  const received = (): number | null => {
    try {
      return opts.swarm.received?.(infoHash) ?? null;
    } catch {
      return null;
    }
  };
  const started = now();
  const first = received();
  if (first === null) {
    const probeMs = Math.max(PROBE_MIN_MS, Math.min(TORRENT_PROBE_TIMEOUT_MS, budgetMs));
    try {
      return { ok: true, probe: await opts.probe(url, probeMs) };
    } catch (err) {
      return err instanceof ProbeError && err.code === 'timeout'
        ? { ok: false, outcome: 'no_stream', detail: `the swarm sent too little of the file to read it within ${Math.round(probeMs / 1000)} s` }
        : { ok: false, outcome: 'error', detail: `ffprobe could not read the file: ${messageOf(err)}` };
    }
  }
  const stallMs = opts.probeStallMs ?? PROBE_STALL_MS;
  const probeMs = Math.max(PROBE_MIN_MS, budgetMs);
  const controller = new AbortController();
  const samples: Array<{ at: number; bytes: number }> = [{ at: started, bytes: first }];
  const giveWayMs = opts.headerGiveWayMs ?? HEADER_GIVE_WAY_MS;
  let stalled: string | null = null;
  const watch = setInterval(() => {
    if (cancelled()) {
      controller.abort();
      return;
    }
    const at = now();
    const bytes = received() ?? samples.at(-1)!.bytes;
    samples.push({ at, bytes });
    const behind = at - started >= giveWayMs ? waiting() : 0;
    if (behind > 0) {
      stalled = `no header after ${Math.round((at - started) / 1000)} s while it delivered (${deps.receivedText(infoHash)}); ${behind} more torrent${behind === 1 ? '' : 's'} waited, so it gave way`;
      controller.abort();
      return;
    }
    // The newest sample at least stallMs old is the window's start; older ones are no longer needed.
    while (samples.length > 2 && at - samples[1]!.at >= stallMs) samples.shift();
    const from = samples[0]!;
    if (at - from.at < stallMs || bytes - from.bytes >= PROBE_STALL_BYTES) return;
    stalled = `the swarm stalled before the header arrived: ${((bytes - from.bytes) / 1e6).toFixed(1)} MB in the last ${Math.round((at - from.at) / 1000)} s (${deps.receivedText(infoHash)} in ${seconds(started, at)} s)`;
    controller.abort();
  }, opts.probeSampleMs ?? PROBE_SAMPLE_MS);
  try {
    return { ok: true, probe: await opts.probe(url, probeMs, { signal: controller.signal }) };
  } catch (err) {
    if (stalled !== null) return { ok: false, outcome: 'no_stream', detail: stalled };
    if (err instanceof ProbeError && (err.code === 'timeout' || err.code === 'aborted')) {
      return { ok: false, outcome: 'no_stream', detail: `the play's budget ran out before the header arrived (${deps.receivedText(infoHash)} in ${seconds(started, now())} s)` };
    }
    return { ok: false, outcome: 'error', detail: `ffprobe could not read the file: ${messageOf(err)}` };
  } finally {
    clearInterval(watch);
  }
}
